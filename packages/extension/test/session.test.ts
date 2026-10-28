import { describe, expect, it } from 'vitest';
import { TerminalSession } from '../src/content/session.js';
import { GENERIC_XTERM_PROFILE } from '../src/profiles.js';
import { keySequence } from '../src/content/keys.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface Harness {
  session: TerminalSession;
  writes: string[];
  feed(text: string): void;
}

function makeSession(): Harness {
  const writes: string[] = [];
  const session = new TerminalSession(
    'ws_1',
    GENERIC_XTERM_PROFILE,
    (data) => writes.push(decoder.decode(data as ArrayBuffer)),
    'https://bastion.example.com/koko/',
    'web-01'
  );
  return {
    session,
    writes,
    feed: (text: string) => session.feed(encoder.encode(text).buffer),
  };
}

function extractNonce(payload: string): string {
  const match = /__BP_([0-9a-f]{8})_\$\?__/.exec(payload);
  if (!match) throw new Error(`no sentinel found in: ${payload}`);
  return match[1]!;
}

describe('TerminalSession', () => {
  it('executes a command and reports completion with exit code', async () => {
    const h = makeSession();
    const promise = h.session.executeCommand('ls -la', { waitMs: 4_000 });
    await new Promise((r) => setTimeout(r, 20));
    const nonce = extractNonce(h.writes[0] ?? '');
    h.feed(
      [
        'ls -la',
        'echo __BP_' + nonce + '_$?__',
        'total 8',
        'file1.txt',
        `__BP_${nonce}_0__`,
        'prompt$ ',
      ].join('\r\n') + '\r\n'
    );
    const result = await promise;
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('file1.txt');
    // The echoed `echo` line (with literal $?) must not have been matched early.
    expect(result.text).toContain('$?__');
  });

  it('reports non-zero exit codes', async () => {
    const h = makeSession();
    const promise = h.session.executeCommand('cat missing.txt', { waitMs: 4_000 });
    await new Promise((r) => setTimeout(r, 20));
    const nonce = extractNonce(h.writes[0] ?? '');
    h.feed(`cat: missing.txt: No such file\r\n__BP_${nonce}_1__\r\n`);
    const result = await promise;
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(1);
  });

  it('times out when the command produces no sentinel', async () => {
    const h = makeSession();
    const result = await h.session.executeCommand('sleep 999', { waitMs: 300 });
    expect(result.status).toBe('timeout');
    expect(result.exitCode).toBeNull();
  }, 5_000);

  it('resolves as quiet when output stalls without a sentinel', async () => {
    const h = makeSession();
    const promise = h.session.executeCommand('tail -f x.log', {
      waitMs: 5_000,
      quietMs: 150,
    });
    await new Promise((r) => setTimeout(r, 20));
    const nonce = /__BP_([0-9a-f]{8})_\$\?__/.exec(h.writes[0] ?? '')?.[1];
    h.feed('line one\r\nline two\r\n');
    await new Promise((r) => setTimeout(r, 60));
    h.feed(`__BP_${nonce}__never-arrives\r\n`); // noise, not a sentinel
    const result = await promise;
    expect(result.status).toBe('quiet');
    expect(result.text).toContain('line two');
  }, 6_000);

  it('supports no-sentinel typing for interactive dialogs', async () => {
    const h = makeSession();
    const promise = h.session.executeCommand('y', {
      waitMs: 2_000,
      quietMs: 150,
      attachSentinel: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.writes[0]).toBe('y\r');
    h.feed('proceed? [y/n] y\r\ndone\r\n');
    const result = await promise;
    expect(['quiet', 'timeout']).toContain(result.status);
    expect(result.text).toContain('done');
  }, 5_000);

  it('keeps incremental cursor reads consistent', async () => {
    const h = makeSession();
    h.feed('part one\n');
    const first = h.session.readText(0, 10_000);
    expect(first.text).toBe('part one\n');
    h.feed('part two\n');
    const second = h.session.readText(first.nextCursor, 10_000);
    expect(second.text).toBe('part two\n');
  });

  it('survives UTF-8 sequences split across frames', () => {
    const h = makeSession();
    const bytes = encoder.encode('中文\n');
    h.session.feed(bytes.slice(0, 1).buffer as ArrayBuffer);
    h.session.feed(bytes.slice(1).buffer as ArrayBuffer);
    const read = h.session.readText(0, 1000);
    expect(read.text).toContain('中文');
  });

  it('renders screen fallback from the tail of the buffer', () => {
    const h = makeSession();
    for (let i = 0; i < 30; i++) h.feed(`line ${i}\n`);
    const { screen, truncated } = h.session.screenLines(10);
    expect(truncated).toBe(true);
    expect(screen.split('\n')).toHaveLength(10);
    expect(screen).toContain('line 29');
  });

  it('sends special keys as PTY control sequences', () => {
    const h = makeSession();
    expect(h.session.sendKey('ctrl+c')).toBe(true);
    expect(h.session.sendKey('up')).toBe(true);
    expect(h.writes).toEqual(['\x03', '\x1b[A']);
    expect(h.session.sendKey('ctrl+space')).toBe(false);
  });

  it('applies carriage-return overwrites to progress bars', async () => {
    const h = makeSession();
    const promise = h.session.executeCommand('downloader', { waitMs: 4_000 });
    await new Promise((r) => setTimeout(r, 20));
    const nonce = extractNonce(h.writes[0] ?? '');
    h.feed('10%\r50%\r100%\r\n' + `__BP_${nonce}_0__\r\n`);
    const result = await promise;
    expect(result.status).toBe('completed');
    expect(result.text).toContain('100%');
    expect(result.text).not.toContain('10%');
  });
});

describe('key sequences', () => {
  it('maps documented keys', () => {
    expect(keySequence('enter')).toBe('\r');
    expect(keySequence('ctrl+c')).toBe('\x03');
    expect(keySequence('esc')).toBe('\x1b');
    expect(keySequence('down')).toBe('\x1b[B');
    expect(keySequence('bogus')).toBeNull();
  });
});
