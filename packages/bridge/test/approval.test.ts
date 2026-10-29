import { describe, expect, it } from 'vitest';
import { ApprovalEngine, summarizeToolCall } from '../src/approval.js';

function engine(
  mode: 'auto' | 'confirm' | 'readonly',
  gate: ((req: { summary: string }) => Promise<boolean>) | null = null,
  allowlist: string[] = []
) {
  return new ApprovalEngine(
    {
      mode,
      requireUserApproval: mode === 'confirm',
      confirmTimeoutMs: 200,
      readonlyAllowlist: allowlist,
    },
    gate
      ? async (req) =>
          gate({ summary: req.summary }).then((approved) => {
            gateCalls.push(req.summary);
            return approved;
          })
      : null
  );
}
let gateCalls: string[] = [];

describe('ApprovalEngine', () => {
  it('always allows read-only tools in every mode', async () => {
    for (const mode of ['auto', 'confirm', 'readonly'] as const) {
      const e = engine(mode, null);
      expect((await e.check('mcp', 'read_output', {})).approved).toBe(true);
      expect((await e.check('mcp', 'list_sessions', {})).approved).toBe(true);
    }
  });

  it('auto mode allows mutating tools without asking', async () => {
    const e = engine('auto');
    const d = await e.check('agent', 'send_command', { sessionId: 's', command: 'reboot' });
    expect(d.approved).toBe(true);
  });

  it('confirm mode asks the user gate and honors the answer', async () => {
    gateCalls = [];
    const allow = engine('confirm', async () => true);
    const d1 = await allow.check('mcp', 'send_command', { sessionId: 's', command: 'ls /tmp' });
    expect(d1.approved).toBe(true);
    expect(gateCalls[0]).toContain('ls /tmp');

    const deny = engine('confirm', async () => false);
    const d2 = await deny.check('mcp', 'send_command', { sessionId: 's', command: 'rm -rf /' });
    expect(d2.approved).toBe(false);
  });

  it('confirm mode denies when no gate is available', async () => {
    const e = engine('confirm', null);
    const d = await e.check('mcp', 'send_key', { sessionId: 's', key: 'enter' });
    expect(d.approved).toBe(false);
  });

  it('confirm mode times out to deny', async () => {
    const e = engine('confirm', () => new Promise<boolean>(() => {}));
    const d = await e.check('mcp', 'send_command', { sessionId: 's', command: 'sleep 999' });
    expect(d.approved).toBe(false);
  });

  it('readonly mode blocks mutating tools unless allowlisted', async () => {
    const e = engine('readonly', null, ['^git status', '^df']);
    expect(
      (await e.check('mcp', 'send_command', { sessionId: 's', command: 'git status' })).approved
    ).toBe(true);
    expect(
      (await e.check('mcp', 'send_command', { sessionId: 's', command: 'git push --force' }))
        .approved
    ).toBe(false);
    expect(
      (await e.check('mcp', 'send_command', { sessionId: 's', command: 'df -h' })).approved
    ).toBe(true);
    expect((await e.check('mcp', 'send_key', { sessionId: 's', key: 'enter' })).approved).toBe(
      false
    );
  });

  it('treats an invalid allowlist regex as non-matching', async () => {
    const e = engine('readonly', null, ['[unclosed']);
    expect(
      (await e.check('mcp', 'send_command', { sessionId: 's', command: 'anything' })).approved
    ).toBe(false);
  });

  it('summarizes tool calls for humans', () => {
    expect(summarizeToolCall('send_command', { command: 'ls -la' })).toBe('command: ls -la');
    expect(summarizeToolCall('send_key', { key: 'ctrl+c' })).toBe('key press: ctrl+c');
    expect(summarizeToolCall('get_screen', {})).toBe('tool get_screen');
  });
});
