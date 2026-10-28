import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  TOOL_MAP,
  ToolName,
  makeEnvelope,
  parseClientMessage,
  toolSchema,
  type ClientMessage,
  type SessionInfo,
} from '@bastion-pilot/protocol';
import { configPaths, loadConfig, resolveHome } from './config.js';
import { AuditLogger } from './audit.js';
import { OutputStore } from './outputStore.js';
import { ApprovalEngine } from './approval.js';
import { renderToolResult } from './render.js';
import { ChatManager } from './chatManager.js';
import { VERSION } from './version.js';
import { createLogger, type Logger } from './logger.js';

interface Conn {
  id: string;
  role: 'extension' | 'brain';
  name: string;
  version: string;
  ws: WebSocket;
  lastPong: number;
  sessionIds: Set<string>;
}

export interface DaemonOptions {
  port?: number;
  configHome?: string;
  log?: Logger;
}

export interface DaemonHandle {
  port: number;
  close(): Promise<void>;
}

const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 65_000;

/**
 * The BastionPilot daemon: a localhost-only WebSocket hub that sits between
 * brains (MCP server process / built-in chat) and the browser extension.
 * Enforces approval policy, writes the audit log and truncates oversized
 * terminal output to local files.
 */
export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const log = opts.log ?? createLogger('daemon');
  const home = opts.configHome ?? resolveHome();
  const { config } = loadConfig(home);
  const paths = configPaths(home);
  const port = opts.port ?? config.server.port;
  const audit = new AuditLogger(paths.auditDir);
  const outputs = new OutputStore(paths.outputsDir, config.output.maxInlineChars);
  const startedAt = Date.now();

  const state = {
    conns: new Map<string, Conn>(),
    extension: null as Conn | null,
    sessions: new Map<string, SessionInfo>(),
    toolPending: new Map<
      string,
      { resolve: (data: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
    >(),
    approvals: new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>(),
  };

  const sendTo = (conn: Conn, type: string, payload: unknown) => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(makeEnvelope(type, payload)));
    }
  };

  const extensionConns = () => [...state.conns.values()].filter((c) => c.role === 'extension');

  const approvalEngine = new ApprovalEngine(config.approval, async (req) => {
    const ext = state.extension;
    if (!ext) {
      log.warn('approval requested but no extension is connected — denying');
      return false;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => {
          if (state.approvals.delete(req.requestId)) resolve(false);
        },
        Math.max(1_000, req.expiresAt - Date.now()),
      );
      state.approvals.set(req.requestId, { resolve, timer });
      ext.ws.send(JSON.stringify(makeEnvelope('approval_request', req)));
    });
  });

  const pickExtension = (sessionId?: string): Conn | null => {
    const exts = extensionConns();
    if (exts.length === 0) return null;
    if (sessionId) {
      const owner = exts.find((c) => c.sessionIds.has(sessionId));
      if (owner) return owner;
    }
    return exts[0] ?? null;
  };

  const auditAppend = async (partial: {
    ok: boolean;
    error?: string;
    exitCode?: number | null;
    outputChars?: number;
    outputFile?: string;
    params: unknown;
    sessionId?: string;
    source: string;
    tool: string;
    startedAt: number;
  }) => {
    audit.append({
      ts: new Date().toISOString(),
      kind: 'tool_call',
      source: partial.source,
      tool: partial.tool,
      sessionId: partial.sessionId,
      params: partial.params,
      ok: partial.ok,
      durationMs: Date.now() - partial.startedAt,
      error: partial.error,
      exitCode: partial.exitCode,
      outputChars: partial.outputChars,
      outputFile: partial.outputFile,
    });
    await audit.flush();
  };

  const executeTool = async (
    source: 'mcp' | 'agent' | 'panel',
    tool: string,
    rawParams: unknown,
  ): Promise<unknown> => {
    if (!TOOL_MAP.has(tool as ToolName)) throw new Error(`unknown tool: ${tool}`);
    const parsed = toolSchema(tool as ToolName).safeParse(rawParams ?? {});
    if (!parsed.success) {
      throw new Error(
        `invalid params for ${tool}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const params = parsed.data as Record<string, unknown>;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    const t0 = Date.now();

    const decision = await approvalEngine.check(source, tool, params);
    if (!decision.approved) {
      await auditAppend({
        ok: false,
        error: `blocked: ${decision.reason}`,
        params,
        sessionId,
        source,
        tool,
        startedAt: t0,
      });
      throw new Error(`Blocked by approval policy: ${decision.reason}`);
    }

    const ext = pickExtension(sessionId);
    if (!ext) {
      throw new Error(
        'No bastion terminal session is connected. Open a bastion web-terminal tab in the ' +
          'browser (with the BastionPilot extension granted for that site) and retry.',
      );
    }

    const callId = crypto.randomUUID();
    const timeoutMs =
      tool === ToolName.SendCommand || tool === ToolName.WaitOutput ? 660_000 : 120_000;
    let data: unknown;
    try {
      data = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.toolPending.delete(callId);
          reject(new Error(`tool ${tool} timed out in the browser after ${timeoutMs}ms`));
        }, timeoutMs);
        state.toolPending.set(callId, { resolve, reject, timer });
        sendTo(ext, 'tool_call', { callId, source, tool, params });
      });
    } catch (err) {
      await auditAppend({
        ok: false,
        error: (err as Error).message,
        params,
        sessionId,
        source,
        tool,
        startedAt: t0,
      });
      throw err;
    }

    // Bound oversized terminal output and persist the full text locally.
    let result = data;
    if (result && typeof result === 'object') {
      const record = result as Record<string, unknown>;
      for (const field of ['text', 'screen'] as const) {
        if (typeof record[field] === 'string') {
          const processed = await outputs.process(record[field] as string, tool);
          record[field] = processed.text;
          if (processed.file) record.outputFile = processed.file;
        }
      }
    }

    await auditAppend({
      ok: true,
      exitCode: typeof (result as Record<string, unknown>)?.exitCode === 'number'
        ? ((result as Record<string, unknown>).exitCode as number)
        : undefined,
      outputChars: typeof (result as Record<string, unknown>)?.text === 'string'
        ? ((result as Record<string, unknown>).text as string).length
        : undefined,
      outputFile: (result as Record<string, unknown>)?.outputFile as string | undefined,
      params,
      sessionId,
      source,
      tool,
      startedAt: t0,
    });
    return result;
  };

  const chats = new ChatManager({
    config,
    chatsDir: paths.chatsDir,
    executeTool: (source, tool, params) => executeTool(source, tool, params),
    renderResult: renderToolResult,
    emit: (msg) => {
      const ext = state.extension;
      if (ext && ext.ws.readyState === WebSocket.OPEN) ext.ws.send(JSON.stringify(msg));
    },
    log,
  });

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/health' || url === '/health/') {
      const body = JSON.stringify({
        ok: true,
        name: 'bastion-pilot',
        version: VERSION,
        port: actualPort,
        extensionConnected: extensionConns().length > 0,
        brainsConnected: [...state.conns.values()].filter((c) => c.role === 'brain').length,
        sessions: [...state.sessions.values()],
        approvalMode: config.approval.mode,
        activeProviderId: config.activeProviderId,
        providers: config.providers.map((p) => ({ id: p.id, label: p.label ?? p.id, model: p.model })),
        uptimeS: Math.round((Date.now() - startedAt) / 1000),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    let conn: Conn | null = null;
    ws.on('message', (raw: RawData) => {
      const text = Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : raw.toString();
      const parsed = parseClientMessage(safeJson(text));
      if (!parsed.ok) {
        ws.send(JSON.stringify(makeEnvelope('error', { message: `bad message: ${parsed.error}` })));
        return;
      }
      const msg = parsed.message;
      if (!conn) {
        if (msg.type !== 'hello') {
          ws.send(JSON.stringify(makeEnvelope('error', { message: 'expected hello first' })));
          ws.close();
          return;
        }
        if (msg.payload.token !== config.security.token) {
          ws.send(
            JSON.stringify(
              makeEnvelope('error', {
                message:
                  'invalid token — run `bastion-pilot init` and copy the token into the extension options page',
              }),
            ),
          );
          ws.close();
          return;
        }
        conn = {
          id: crypto.randomUUID(),
          role: msg.payload.role,
          name: msg.payload.name,
          version: msg.payload.version,
          ws,
          lastPong: Date.now(),
          sessionIds: new Set(),
        };
        state.conns.set(conn.id, conn);
        if (conn.role === 'extension') state.extension = conn;
        log.info(`${conn.role} connected: ${conn.name} v${conn.version}`);
        sendTo(conn, 'welcome', {
          daemonVersion: VERSION,
          sessions: [...state.sessions.values()],
          providers: config.providers.map((p) => ({ id: p.id, label: p.label || p.id, model: p.model })),
          activeProviderId: config.activeProviderId,
        });
        return;
      }
      handleClientMessage(conn, msg);
    });
    ws.on('close', () => {
      if (!conn) return;
      state.conns.delete(conn.id);
      if (state.extension === conn) state.extension = null;
      log.info(`${conn.role} disconnected: ${conn.name}`);
    });
    ws.on('error', () => {
      /* close event handles cleanup */
    });
  });

  const handleClientMessage = async (conn: Conn, msg: ClientMessage) => {
    switch (msg.type) {
      case 'pong': {
        conn.lastPong = Date.now();
        break;
      }
      case 'tool_result': {
        const pending = state.toolPending.get(msg.payload.callId);
        if (!pending) break;
        state.toolPending.delete(msg.payload.callId);
        clearTimeout(pending.timer);
        if (msg.payload.ok) pending.resolve(msg.payload.data ?? {});
        else pending.reject(new Error(msg.payload.error || 'tool failed in the browser'));
        break;
      }
      case 'sessions_update': {
        state.sessions = new Map(msg.payload.sessions.map((s) => [s.sessionId, s]));
        conn.sessionIds = new Set(msg.payload.sessions.map((s) => s.sessionId));
        if (conn.role === 'extension') state.extension = conn;
        break;
      }
      case 'tool_call': {
        // From a brain client (MCP process): execute locally and send the
        // result back over the same connection.
        if (conn.role !== 'brain') {
          sendTo(conn, 'error', { message: 'only brain clients may request tool calls' });
          break;
        }
        const { callId } = msg.payload;
        try {
          const data = await executeTool(msg.payload.source, msg.payload.tool, msg.payload.params);
          sendTo(conn, 'tool_result', { callId, ok: true, data });
        } catch (err) {
          sendTo(conn, 'tool_result', { callId, ok: false, error: (err as Error).message });
        }
        break;
      }
      case 'providers_list_get': {
        sendTo(conn, 'providers_list', {
          providers: chats.providers(),
          activeProviderId: config.activeProviderId,
        });
        break;
      }
      case 'chat_new': {
        const session = chats.create(msg.payload.providerId);
        sendTo(conn, 'chat_created', { chatId: session.id });
        break;
      }
      case 'chat_message': {
        chats.submit(msg.payload.chatId, msg.payload.text).catch((err) =>
          sendTo(conn, 'error', { message: (err as Error).message }),
        );
        break;
      }
      case 'chat_abort': {
        chats.abort(msg.payload.chatId);
        break;
      }
      case 'approval_response': {
        const pending = state.approvals.get(msg.payload.requestId);
        if (!pending) break;
        state.approvals.delete(msg.payload.requestId);
        clearTimeout(pending.timer);
        pending.resolve(msg.payload.approved);
        break;
      }
      default:
        break;
    }
  };

  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const conn of [...state.conns.values()]) {
      if (now - conn.lastPong > PONG_TIMEOUT_MS) {
        log.warn(`terminating unresponsive ${conn.role}: ${conn.name}`);
        state.conns.delete(conn.id);
        if (state.extension === conn) state.extension = null;
        conn.ws.terminate();
        continue;
      }
      sendTo(conn, 'ping', {});
    }
  }, PING_INTERVAL_MS);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  log.info(
    `daemon listening on ws://127.0.0.1:${actualPort} (approval mode: ${config.approval.mode}, v${VERSION})`,
  );
  if (config.providers.length === 0) {
    log.info(
      'no AI provider configured — the built-in side-panel chat stays disabled until you add ' +
        'one to the config; MCP clients (Claude Code, Codex, ...) work regardless',
    );
  }

  const close = async (): Promise<void> => {
    clearInterval(pingTimer);
    for (const [, p] of state.approvals) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    for (const [, p] of state.toolPending) {
      clearTimeout(p.timer);
      p.reject(new Error('daemon shutting down'));
    }
    const closed = new Promise<void>((resolve) => wss.close(() => resolve()));
    server.close();
    for (const conn of [...state.conns.values()]) conn.ws.terminate();
    await closed;
  };

  return { port: actualPort, close };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
