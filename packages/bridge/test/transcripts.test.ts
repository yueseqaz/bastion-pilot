import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptRecorder } from '../src/transcripts.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bp-transcripts-'));
}

describe('TranscriptRecorder', () => {
  it('appends entries between header lines per session', async () => {
    const dir = tmpDir();
    const recorder = new TranscriptRecorder(dir);
    recorder.append({
      ts: '2026-10-29T01:00:00.000Z',
      source: 'mcp',
      tool: 'send_command',
      sessionId: 'sess_abc',
      exitCode: 0,
      text: 'file1\nfile2',
    });
    recorder.append({
      ts: '2026-10-29T01:00:05.000Z',
      source: 'agent',
      tool: 'download_file',
      sessionId: 'sess_abc',
      text: 'downloaded /etc/hosts (42 bytes) -> /downloads/hosts',
    });
    await recorder.flush();

    const content = recorder.read('sess_abc');
    expect(content).toContain('===== 2026-10-29T01:00:00.000Z · mcp · send_command · exit 0 =====');
    expect(content).toContain('file2');
    expect(content).toContain('downloaded /etc/hosts');
    expect(recorder.read('sess_missing')).toBeNull();
  });

  it('records entries even with no output text', async () => {
    const dir = tmpDir();
    const recorder = new TranscriptRecorder(dir);
    recorder.append({
      ts: '2026-10-29T02:00:00.000Z',
      source: 'panel',
      tool: 'get_screen',
      sessionId: 'sess_x',
    });
    await recorder.flush();
    expect(recorder.read('sess_x')).toContain('(no output)');
  });

  it('sanitizes session ids into safe file names', async () => {
    const dir = tmpDir();
    const recorder = new TranscriptRecorder(dir);
    recorder.append({
      ts: '2026-10-29T03:00:00.000Z',
      source: 'mcp',
      tool: 'send_command',
      sessionId: '../evil/id',
      text: 'x',
    });
    await recorder.flush();
    expect(fs.readdirSync(dir)).toEqual(['___evil_id.log']);
  });

  it('lists transcripts newest first', async () => {
    const dir = tmpDir();
    const recorder = new TranscriptRecorder(dir);
    recorder.append({
      ts: '2026-10-29T04:00:00.000Z',
      source: 'mcp',
      tool: 'send_command',
      sessionId: 'a',
      text: 'x',
    });
    await recorder.flush();
    // force a different mtime
    const bFile = path.join(dir, 'b.log');
    fs.writeFileSync(bFile, 'older\n');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(bFile, past, past);
    const list = recorder.list();
    expect(list.map((t) => t.sessionId)).toEqual(['a', 'b']);
    expect(list[0]!.bytes).toBeGreaterThan(0);
  });

  it('supports tail reads', async () => {
    const dir = tmpDir();
    const recorder = new TranscriptRecorder(dir);
    recorder.append({
      ts: '2026-10-29T05:00:00.000Z',
      source: 'mcp',
      tool: 'send_command',
      sessionId: 't',
      text: 'one\ntwo\nthree',
    });
    await recorder.flush();
    const tail = recorder.read('t', 2);
    expect(tail).not.toContain('one');
    expect(tail).toContain('three');
  });
});
