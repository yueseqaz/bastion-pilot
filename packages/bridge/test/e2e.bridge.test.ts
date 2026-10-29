import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { makeEnvelope, type SessionInfo } from '@bastion-pilot/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/config.js';
import { startDaemon } from '../src/daemon.js';
import { HubClient } from '../src/hubClient.js';

type BpPayload = Record<string, unknown>;
type BpMessage = { type: string; payload: BpPayload };
import { createLogger } from '../src/logger.js';

const TOKEN = 'e2e-test-token-0123456789abcdef';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bp-e2e-'));
}

function makeHome(approvalMode: 'auto' | 'confirm' | 'readonly'): string {
  const home = tmpDir();
  const cfg = defaultConfig();
  cfg.security.token = TOKEN;
  cfg.approval.mode = approvalMode;
  cfg.approval.confirmTimeoutMs = 5_000;
  cfg.output.maxInlineChars = 2_000;
  cfg.server.port = 0;
  saveConfig(cfg, home);
  return home;
}

class FakeExtension {
  private ws: WebSocket;
  private received: BpMessage[] = [];
  private waiters: Array<{ type: string; resolve: (m: BpMessage) => void }> = [];
  onToolCall?: (call: { callId: string; tool: string; params: BpPayload }) => void;
  onApprovalRequest?: (req: { requestId: string; summary: string }) => void;
  readonly welcome: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.welcome = new Promise<void>((resolve, reject) => {
      this.ws.on('error', reject);
      this.ws.on('open', () => {
        this.send('hello', { token: TOKEN, role: 'extension', name: 'fake-ext', version: '0' });
      });
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as BpMessage;
        if (msg.type === 'welcome') resolve();
        this.dispatch(msg);
      });
    });
  }

  private dispatch(msg: BpMessage) {
    this.received.push(msg);
    if (msg.type === 'ping') this.send('pong', {});
    if (msg.type === 'tool_call')
      this.onToolCall?.(
        msg.payload as unknown as { callId: string; tool: string; params: BpPayload }
      );
    if (msg.type === 'approval_request')
      this.onApprovalRequest?.(msg.payload as unknown as { requestId: string; summary: string });
    const idx = this.waiters.findIndex((w) => w.type === msg.type);
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0];
      if (w) w.resolve(msg);
    }
  }

  send(type: string, payload: unknown) {
    this.ws.send(JSON.stringify(makeEnvelope(type, payload)));
  }

  sendSessions(sessions: SessionInfo[]) {
    this.send('sessions_update', { sessions });
  }

  replyTool(callId: string, data: unknown) {
    this.send('tool_result', { callId, ok: true, data });
  }

  replyToolError(callId: string, error: string) {
    this.send('tool_result', { callId, ok: false, error });
  }

  replyApproval(requestId: string, approved: boolean) {
    this.send('approval_response', { requestId, approved });
  }

  wait(type: string, timeoutMs = 4_000): Promise<BpMessage> {
    const existing = this.received.find((m) => m.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  close() {
    this.ws.close();
  }
}

const session: SessionInfo = {
  sessionId: 'sess_1',
  title: 'web-01 via JumpServer',
  url: 'https://bastion.example.com/koko/',
  profileId: 'generic-xterm',
  state: 'active',
  createdAt: Date.now(),
  lastActivityAt: Date.now(),
};

function logger() {
  return createLogger('e2e');
}

describe('daemon e2e', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
  });

  async function boot(approvalMode: 'auto' | 'confirm' | 'readonly') {
    const home = makeHome(approvalMode);
    const daemon = await startDaemon({ configHome: home });
    const url = `ws://127.0.0.1:${daemon.port}`;
    const ext = new FakeExtension(url);
    await ext.welcome;
    const brain = new HubClient({ url, token: TOKEN, name: 'test-brain', version: '0' }, logger());
    await brain.connect();
    cleanups.push(async () => {
      brain.close();
      ext.close();
      await daemon.close();
    });
    return { home, daemon, url, ext, brain };
  }

  it('routes tool calls to the extension and returns results', async () => {
    const { ext, brain } = await boot('auto');
    ext.sendSessions([session]);
    await new Promise((r) => setTimeout(r, 50));

    ext.onToolCall = (call) => {
      expect(call.tool).toBe('list_sessions');
      ext.replyTool(call.callId, { sessions: [session] });
    };
    const result = (await brain.executeTool('mcp', 'list_sessions', {})) as {
      sessions: SessionInfo[];
    };
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe('sess_1');
  });

  it('propagates tool errors from the browser', async () => {
    const { ext, brain } = await boot('auto');
    ext.onToolCall = (call) => ext.replyToolError(call.callId, 'terminal not ready');
    await expect(brain.executeTool('mcp', 'get_screen', { sessionId: 'sess_1' })).rejects.toThrow(
      /terminal not ready/
    );
  });

  it('rejects unknown tools and invalid params', async () => {
    const { brain } = await boot('auto');
    await expect(brain.executeTool('mcp', 'does_not_exist', {})).rejects.toThrow(/unknown tool/);
    await expect(brain.executeTool('mcp', 'send_command', { sessionId: 's' })).rejects.toThrow(
      /invalid params/
    );
  });

  it('saves oversized output to a file and reports the path', async () => {
    const { ext, brain, home } = await boot('auto');
    ext.onToolCall = (call) => {
      ext.replyTool(call.callId, {
        status: 'completed',
        exitCode: 0,
        cursor: 99,
        text: 'line\n'.repeat(1000),
        hasMore: false,
      });
    };
    const result = (await brain.executeTool('mcp', 'send_command', {
      sessionId: 'sess_1',
      command: 'cat big.log',
    })) as { text: string; outputFile?: string };
    expect(result.outputFile).toBeTruthy();
    expect(result.text).toContain('truncated');
    expect(fs.statSync(result.outputFile!).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(home, 'outputs'))).toHaveLength(1);
  });

  it('writes an audit log entry for every executed tool call', async () => {
    const { ext, brain, home } = await boot('auto');
    ext.onToolCall = (call) => ext.replyTool(call.callId, { ok: true });
    await brain.executeTool('mcp', 'get_screen', { sessionId: 'sess_1' });
    await new Promise((r) => setTimeout(r, 50));
    const auditDir = path.join(home, 'audit');
    const file = fs.readdirSync(auditDir)[0]!;
    const entry = JSON.parse(fs.readFileSync(path.join(auditDir, file), 'utf8'));
    expect(entry).toMatchObject({ tool: 'get_screen', source: 'mcp', ok: true });
  });

  it('asks the user for approval in confirm mode and honors consent', async () => {
    const { ext, brain } = await boot('confirm');
    ext.onApprovalRequest = (req) => ext.replyApproval(req.requestId, true);
    ext.onToolCall = (call) =>
      ext.replyTool(call.callId, {
        status: 'completed',
        exitCode: 0,
        cursor: 1,
        text: '',
        hasMore: false,
      });
    const result = (await brain.executeTool('mcp', 'send_command', {
      sessionId: 'sess_1',
      command: 'uptime',
    })) as { status: string };
    expect(result.status).toBe('completed');
    const approval = await ext.wait('approval_request');
    expect(approval.payload.summary).toContain('uptime');
  });

  it('denies the tool call when the user rejects it in confirm mode', async () => {
    const { ext, brain } = await boot('confirm');
    ext.onApprovalRequest = (req) => ext.replyApproval(req.requestId, false);
    await expect(
      brain.executeTool('mcp', 'send_command', { sessionId: 'sess_1', command: 'rm -rf /tmp/x' })
    ).rejects.toThrow(/Blocked by approval policy/);
  });

  it('blocks mutating tools in readonly mode while allowing reads', async () => {
    const { ext, brain } = await boot('readonly');
    ext.onToolCall = (call) => ext.replyTool(call.callId, { screen: 'ok', truncated: false });
    await expect(
      brain.executeTool('mcp', 'send_command', { sessionId: 'sess_1', command: 'ls' })
    ).rejects.toThrow(/readonly/);
    const result = (await brain.executeTool('mcp', 'get_screen', { sessionId: 'sess_1' })) as {
      screen: string;
    };
    expect(result.screen).toBe('ok');
  });

  it('rejects connections with a bad token', async () => {
    const home = makeHome('auto');
    const daemon = await startDaemon({ configHome: home });
    cleanups.push(async () => daemon.close());
    const bad = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
    const error = await new Promise<string>((resolve) => {
      bad.on('open', () =>
        bad.send(
          JSON.stringify(
            makeEnvelope('hello', {
              token: 'wrong-token-aaaaaaaaaa',
              role: 'brain',
              name: 'x',
              version: '0',
            })
          )
        )
      );
      bad.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'error') resolve(msg.payload.message);
      });
    });
    expect(error).toMatch(/invalid token/);
    bad.close();
  });

  it('does not leak session details through the unauthenticated /health endpoint', async () => {
    const { daemon, ext } = await boot('auto');
    ext.sendSessions([session]);
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    const text = await res.text();
    expect(text).not.toContain('bastion.example.com');
    expect(text).not.toContain('"url"');
    expect(JSON.parse(text).sessionCount).toBe(1);
  });
});
