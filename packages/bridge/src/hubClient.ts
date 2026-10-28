import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ToolName,
  toolSchema,
  parseDaemonMessage,
  makeEnvelope,
  type DaemonMessage,
  type SessionInfo,
} from '@bastion-pilot/protocol';
import WebSocket from 'ws';

export interface HubClientOptions {
  url: string;
  token: string;
  name: string;
  version: string;
  /** Spawn the daemon if nothing is listening (used by `bastion-pilot mcp`). */
  spawnDaemon?: { command: string; args: string[]; env?: NodeJS.ProcessEnv };
}

interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const LONG_TOOLS = new Set<string>([ToolName.SendCommand, ToolName.WaitOutput]);
const TOOL_TIMEOUT_MS = 120_000;
const LONG_TOOL_TIMEOUT_MS = 660_000;

export async function isPortServing(url: string, timeoutMs = 800): Promise<boolean> {
  const { hostname, port } = new URL(url.replace(/^ws/, 'http'));
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Path of the running CLI bundle, for spawning the daemon from `mcp`. */
export function selfCliPath(): string {
  const argv1 = process.argv[1];
  if (argv1 && path.basename(argv1) === 'cli.js') return path.resolve(argv1);
  return fileURLToPath(import.meta.url);
}

/**
 * Client side of the daemon hub, used by the MCP server process. Reconnects
 * with backoff and can spawn the daemon on demand.
 */
export class HubClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingCall>();
  private seq = 0;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  sessions: SessionInfo[] = [];

  constructor(
    private readonly opts: HubClientOptions,
    private readonly log: {
      info(...a: unknown[]): void;
      warn(...a: unknown[]): void;
      error(...a: unknown[]): void;
    }
  ) {}

  async connect(): Promise<void> {
    if (this.opts.spawnDaemon && !(await isPortServing(this.opts.url))) {
      this.log.info(`no daemon on ${this.opts.url}, spawning one...`);
      this.spawnDaemon();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await isPortServing(this.opts.url)) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    await this.dialWithRetry();
  }

  private spawnDaemon() {
    const sd = this.opts.spawnDaemon!;
    try {
      const child = spawn(sd.command, sd.args, {
        detached: true,
        stdio: 'ignore',
        env: sd.env ?? process.env,
      });
      child.unref();
    } catch (err) {
      this.log.error('failed to spawn daemon:', (err as Error).message);
    }
  }

  private async dialWithRetry(attempts = 20, delayMs = 500): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.dial();
        return;
      } catch (err) {
        if (i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  private dial(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      const sendRaw = (type: string, payload: unknown) => {
        ws.send(JSON.stringify(makeEnvelope(type, payload)));
      };
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      ws.on('open', () => {
        sendRaw('hello', {
          token: this.opts.token,
          role: 'brain',
          name: this.opts.name,
          version: this.opts.version,
        });
      });
      ws.on('message', (raw) => {
        const parsed = parseDaemonMessage(safeJson(String(raw)));
        if (!parsed.ok) return;
        this.handle(parsed.message);
        if (!settled && parsed.message.type === 'welcome') {
          settled = true;
          this.ws = ws;
          resolve();
        }
      });
      ws.on('error', (err) => fail(err));
      ws.on('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('connection closed before welcome'));
        }
        this.onDisconnect();
      });
    });
  }

  private handle(msg: DaemonMessage) {
    switch (msg.type) {
      case 'welcome': {
        this.sessions = msg.payload.sessions;
        break;
      }
      case 'ping':
        this.sendEnvelope('pong', {});
        break;
      case 'tool_result': {
        const p = this.pending.get(msg.payload.callId);
        if (!p) break;
        this.pending.delete(msg.payload.callId);
        clearTimeout(p.timer);
        if (msg.payload.ok) p.resolve(msg.payload.data ?? {});
        else p.reject(new Error(msg.payload.error || 'tool failed'));
        break;
      }
      case 'error':
        this.log.warn('daemon error:', msg.payload.message);
        break;
      default:
        break;
    }
  }

  private onDisconnect() {
    this.ws = null;
    for (const [callId, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('daemon connection lost'));
      this.pending.delete(callId);
    }
    if (!this.stopped) {
      this.reconnectTimer = setTimeout(() => {
        this.dialWithRetry(8, 1000).catch((err) => {
          this.log.error('reconnect failed permanently:', (err as Error).message);
        });
      }, 1000);
    }
  }

  private sendEnvelope(type: string, payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('not connected to daemon');
    }
    this.ws.send(JSON.stringify(makeEnvelope(type, payload)));
  }

  async executeTool(
    source: 'mcp' | 'agent' | 'panel',
    tool: string,
    params: unknown
  ): Promise<unknown> {
    const schema = toolSchema(tool as ToolName);
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      throw new Error(
        `invalid params for ${tool}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
      );
    }
    const callId = `call_${++this.seq}_${Date.now()}`;
    const timeoutMs = LONG_TOOLS.has(tool) ? LONG_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`tool ${tool} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(callId, { resolve, reject, timer });
      try {
        this.sendEnvelope('tool_call', { callId, source, tool, params: parsed.data });
      } catch (err) {
        this.pending.delete(callId);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('client closed'));
    }
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
