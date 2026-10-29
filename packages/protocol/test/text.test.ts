import { describe, expect, it } from 'vitest';
import { cleanCommandOutput, TerminalTextRenderer, TextRingBuffer } from '../src/text.js';

function renderAll(chunks: string[]): { completed: string; pending: string } {
  const r = new TerminalTextRenderer();
  let completed = '';
  for (const c of chunks) completed += r.push(c);
  return { completed, pending: r.pending() };
}

describe('TerminalTextRenderer', () => {
  it('passes plain text through and commits on newline', () => {
    const { completed, pending } = renderAll(['hello\nworld']);
    expect(completed).toBe('hello\n');
    expect(pending).toBe('world');
  });

  it('strips SGR color sequences', () => {
    const { completed } = renderAll(['\x1b[31mred\x1b[0m plain\n']);
    expect(completed).toBe('red plain\n');
  });

  it('strips cursor-position sequences', () => {
    const { completed } = renderAll(['\x1b[2;3HX\x1b[?25hy\n']);
    expect(completed).toBe('Xy\n');
  });

  it('strips BEL-terminated OSC titles', () => {
    const { completed } = renderAll(['\x1b]0;user@host: ~\x07ls -la\n']);
    expect(completed).toBe('ls -la\n');
  });

  it('strips ST-terminated OSC and DCS sequences', () => {
    const { completed } = renderAll(['\x1b]8;;http://x\x1b\\link\x1b\\\n', '\x1bP+q544e\x1b\\\n']);
    expect(completed).toBe('link\n\n');
  });

  it('swallows 2-char and 3-char ESC sequences', () => {
    const { completed } = renderAll(['\x1b7save\x1b(Bpos\n']);
    expect(completed).toBe('savepos\n');
  });

  it('handles sequences split across chunks', () => {
    const { completed } = renderAll(['\x1b[3', '1;1mhi\x1b', '[0m\n']);
    expect(completed).toBe('hi\n');
  });

  it('applies carriage-return overwrite (progress bars)', () => {
    const { completed } = renderAll(['hello\rjello\n']);
    expect(completed).toBe('jello\n');
  });

  it('keeps trailing characters when the overwritten segment is shorter', () => {
    // Real terminals do not erase beyond the new segment: "100%" then "50%"
    // overwrites the first three columns and leaves the old "%" visible.
    const { completed } = renderAll(['100%\r50%\n']);
    expect(completed).toBe('50%%\n');
  });

  it('applies backspace overwrite', () => {
    const { completed } = renderAll(['abc\bX\n']);
    expect(completed).toBe('abX\n');
  });

  it('expands tabs to 8-column stops', () => {
    const { completed } = renderAll(['a\tb\n']);
    expect(completed).toBe('a       b\n');
  });

  it('keeps UTF-8 text', () => {
    const { completed } = renderAll(['中文测试 ok\n']);
    expect(completed).toBe('中文测试 ok\n');
  });

  it('drops DEL and other C0 controls', () => {
    const { completed } = renderAll(['a\x00\x07\x7fb\n']);
    expect(completed).toBe('ab\n');
  });

  it('matches xterm semantics for an ESC inside OSC (SOS swallows until ST)', () => {
    // ESC ends the OSC; the following ESC X opens an SOS string that consumes
    // "after" until an ST that never arrives — same as a real terminal.
    const { completed } = renderAll(['\x1b]0;title\x1bXafter\n']);
    expect(completed).toBe('');
  });

  it('bails out of unterminated string sequences after a safety threshold', () => {
    const { completed, pending } = renderAll(['\x1b]0;never-terminated', 'x'.repeat(9000)]);
    expect(completed).toBe('');
    expect(pending.length).toBeGreaterThanOrEqual(800);
  });
});

describe('TextRingBuffer', () => {
  it('reads back what was written', () => {
    const buf = new TextRingBuffer();
    buf.writeLines(['one\n', 'two\n']);
    const r = buf.readFromCursor(0, 1000);
    expect(r.text).toBe('one\ntwo\n');
    expect(r.nextCursor).toBe(8);
    expect(r.hasMore).toBe(false);
    expect(r.dropped).toBe(false);
  });

  it('supports incremental reads', () => {
    const buf = new TextRingBuffer();
    buf.writeLines(['aaa\n', 'bbb\n', 'ccc\n']);
    const first = buf.readFromCursor(0, 4);
    expect(first.text).toBe('aaa\n');
    expect(first.hasMore).toBe(true);
    const second = buf.readFromCursor(first.nextCursor, 4);
    expect(second.text).toBe('bbb\n');
    const third = buf.readFromCursor(second.nextCursor, 4);
    expect(third.text).toBe('ccc\n');
    expect(third.hasMore).toBe(false);
  });

  it('clamps cursors below the retention window and reports dropping', () => {
    const buf = new TextRingBuffer(21);
    buf.writeLines(['aaaaaaaaaa\n']); // 11 chars
    buf.writeLines(['bbbbbbbbbb\n']); // drops the first line
    buf.writeLines(['cc\n']);
    const r = buf.readFromCursor(0, 1000);
    expect(r.dropped).toBe(true);
    expect(r.text).toBe('bbbbbbbbbb\ncc\n');
  });

  it('returns tail lines', () => {
    const buf = new TextRingBuffer();
    buf.writeLines(['1\n', '2\n', '3\n']);
    expect(buf.tailLines(2)).toEqual(['2\n', '3\n']);
  });

  it('never drops the only line even when over capacity', () => {
    const buf = new TextRingBuffer(4);
    buf.writeLines(['toolongline\n']);
    expect(buf.readFromCursor(0, 100).text).toBe('toolongline\n');
  });
});

describe('cleanCommandOutput', () => {
  it('removes shell echoes and completion sentinels without touching output', () => {
    expect(cleanCommandOutput('ops@host:~$ pwd\n/tmp/app\n__BP_ab12_0__\n', 'pwd')).toBe(
      '/tmp/app'
    );
  });
});
