import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLogger } from '../src/audit.js';
import { OutputStore } from '../src/outputStore.js';
import { loadConfig, saveConfig, defaultConfig } from '../src/config.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-'));
}

describe('AuditLogger', () => {
  it('writes one JSONL line per entry into a daily file', async () => {
    const dir = tmpDir();
    const logger = new AuditLogger(dir);
    logger.append({
      ts: '2026-10-29T01:02:03.000Z',
      kind: 'tool_call',
      source: 'mcp',
      tool: 'send_command',
      sessionId: 's1',
      params: { command: 'ls' },
      ok: true,
      durationMs: 42,
      exitCode: 0,
    });
    await logger.flush();
    const files = fs.readdirSync(dir);
    expect(files).toEqual(['2026-10-29.jsonl']);
    const lines = fs.readFileSync(path.join(dir, files[0]!), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: 'send_command', ok: true, exitCode: 0 });
  });

  it('serializes concurrent appends without interleaving', async () => {
    const dir = tmpDir();
    const logger = new AuditLogger(dir);
    for (let i = 0; i < 50; i++) {
      logger.append({
        ts: '2026-10-29T01:02:03.000Z',
        kind: 'tool_call',
        source: 'agent',
        tool: `tool_${i}`,
        params: {},
        ok: true,
        durationMs: i,
      });
    }
    await logger.flush();
    const file = fs.readdirSync(dir)[0]!;
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(50);
    const last = JSON.parse(lines[49]!);
    expect(last.tool).toBe('tool_49');
  });
});

describe('OutputStore', () => {
  it('passes small outputs through untouched', async () => {
    const store = new OutputStore(tmpDir(), 1000);
    const r = await store.process('hello', 'send_command');
    expect(r.truncated).toBe(false);
    expect(r.file).toBeUndefined();
    expect(r.text).toBe('hello');
  });

  it('persists large outputs and returns a head+tail excerpt', async () => {
    const dir = tmpDir();
    const store = new OutputStore(dir, 500);
    const big = 'x'.repeat(300) + 'SECRET-IN-MIDDLE' + 'y'.repeat(300);
    const r = await store.process(big, 'send_command');
    expect(r.truncated).toBe(true);
    expect(r.file).toBeTruthy();
    expect(r.totalChars).toBe(big.length);
    expect(r.text).toContain('full output saved to');
    expect(r.text).toContain('SECRET-IN-MIDDLE');
    const saved = fs.readFileSync(r.file!, 'utf8');
    expect(saved).toBe(big);
  });
});

describe('config', () => {
  it('creates a config with a fresh token on first run', () => {
    const dir = tmpDir();
    const { config, created } = loadConfig(dir);
    expect(created).toBe(true);
    expect(config.security.token).toMatch(/^[0-9a-f]{48}$/);
    expect(config.approval.mode).toBe('confirm');
    expect(fs.statSync(path.join(dir, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('merges user overrides over defaults', () => {
    const dir = tmpDir();
    saveConfig({ ...defaultConfig(), server: { port: 9999 }, activeProviderId: 'local' }, dir);
    const { config, created } = loadConfig(dir);
    expect(created).toBe(false);
    expect(config.server.port).toBe(9999);
    expect(config.activeProviderId).toBe('local');
    expect(config.approval.mode).toBe('confirm');
  });

  it('rejects invalid config files with a clear error', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port: 'abc' } }));
    expect(() => loadConfig(dir)).toThrow(/invalid config file/);
  });
});
