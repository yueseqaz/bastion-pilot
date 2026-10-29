import { ToolName, type SessionInfo } from '@bastion-pilot/protocol';
import { normalizeOrigin, profileById, type SiteProfile } from '../profiles.js';
import { isPtyLikeBytes } from './pty.js';
import { TerminalSession } from './session.js';

/**
 * ISOLATED-world content controller. Bridges the MAIN-world interceptor to
 * the service worker, owns the per-tab TerminalSession and executes tools.
 */

interface FrameMessage {
  __bp?: string;
  kind?: 'socket' | 'down' | 'screen-result';
  socketId?: string;
  url?: string;
  data?: string | ArrayBuffer;
  reqId?: string;
  text?: string;
}

interface SocketObservation {
  url: string;
  binarySeen: boolean;
  stringFrames: number;
  decided: boolean;
}

const CHANNEL_ATTR = 'data-bp-channel';
const SETTINGS_KEY = 'settings';

interface Settings {
  daemonUrl: string;
  token: string;
  sites: Array<{ origin: string; profileId?: string }>;
  defaultWaitMs?: number;
}

declare global {
  interface Window {
    __bastionPilotController?: boolean;
  }
}

async function waitForChannel(timeoutMs = 5_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const channel = document.documentElement.getAttribute(CHANNEL_ATTR);
    if (channel) return channel;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function loadSettings(): Promise<Settings> {
  try {
    const stored = (await chrome.storage.sync.get(SETTINGS_KEY)) as Record<string, unknown>;
    const settings = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
    return {
      daemonUrl: settings?.daemonUrl ?? 'ws://127.0.0.1:8765',
      token: settings?.token ?? '',
      sites: settings?.sites ?? [],
      defaultWaitMs: settings?.defaultWaitMs ?? 10_000,
    };
  } catch {
    return { daemonUrl: 'ws://127.0.0.1:8765', token: '', sites: [], defaultWaitMs: 10_000 };
  }
}

function pickProfile(settings: Settings): SiteProfile {
  const match = settings.sites.find(
    (site) => site.origin && normalizeOrigin(site.origin) === location.origin
  );
  return profileById(match?.profileId);
}

class TabController {
  private channel: string | null = null;
  private observations = new Map<string, SocketObservation>();
  private session: TerminalSession | null = null;
  private port: chrome.runtime.Port | null = null;
  private portRetryMs = 1_000;
  private settings: Settings | null = null;
  private lastSessionsPush = 0;
  private screenWaiters = new Map<string, (text: string) => void>();
  private screenSeq = 0;

  async start() {
    if (window.__bastionPilotController) return;
    window.__bastionPilotController = true;

    this.channel = await waitForChannel();
    if (!this.channel) return; // interceptor never ran; stay passive

    this.settings = await loadSettings();
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'sync' && changes[SETTINGS_KEY]) {
        this.settings = await loadSettings();
      }
    });

    window.addEventListener('message', (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const msg = ev.data as FrameMessage;
      if (!msg || msg.__bp !== this.channel) return;
      this.onFrame(msg);
    });

    this.connectPort();
    setInterval(() => this.pushSessionsIfChanged(), 2_000);
  }

  /* ----------------------- frame handling ----------------------- */

  private onFrame(msg: FrameMessage) {
    if (msg.kind === 'screen-result' && msg.reqId) {
      const waiter = this.screenWaiters.get(msg.reqId);
      if (waiter) {
        this.screenWaiters.delete(msg.reqId);
        waiter(msg.text ?? '');
      }
      return;
    }
    if (!msg.socketId) return;
    if (msg.kind === 'socket') {
      if (!this.observations.has(msg.socketId)) {
        this.observations.set(msg.socketId, {
          url: msg.url ?? '',
          binarySeen: false,
          stringFrames: 0,
          decided: false,
        });
      }
      return;
    }
    if (msg.kind !== 'down') return;

    const observation = this.observations.get(msg.socketId);
    if (!observation) return;
    if (this.session && this.session.socketId === msg.socketId) {
      this.session.feed(msg.data ?? '');
      return;
    }
    if (this.session) return; // one terminal per tab for now

    if (typeof msg.data === 'string') {
      observation.stringFrames++;
      if (!this.isLikelyTerminalText(observation, msg.data)) return;
    } else {
      observation.binarySeen = true;
      // Analytics/protobuf sockets also ship binary frames — only accept a
      // binary stream that actually looks like terminal output.
      if (!isPtyLikeBytes(msg.data as ArrayBuffer)) return;
    }
    observation.decided = true;
    this.createSession(msg.socketId, observation, msg.data ?? '');
  }

  private isLikelyTerminalText(observation: SocketObservation, data: string): boolean {
    if (observation.binarySeen) return true;
    // JSON frames (heartbeats, notifications) are not terminal output unless
    // the page looks like a web terminal AND the frame carries PTY text.
    try {
      const parsed = JSON.parse(data);
      if (parsed !== null && typeof parsed === 'object') {
        const hints = pickProfile(
          this.settings ?? { daemonUrl: '', token: '', sites: [] }
        ).terminalDomHints;
        const looksTerminal = hints.some((hint) => {
          try {
            return document.querySelector(hint) !== null;
          } catch {
            return false;
          }
        });
        return looksTerminal;
      }
    } catch {
      /* plain text */
    }
    return observation.stringFrames >= 2;
  }

  private createSession(
    socketId: string,
    observation: SocketObservation,
    firstFrame: string | ArrayBuffer
  ) {
    const profile = pickProfile(this.settings ?? { daemonUrl: '', token: '', sites: [] });
    const isFrame = window.top !== window;
    const title = (document.title || location.host || 'terminal') + (isFrame ? ' · frame' : '');
    this.session = new TerminalSession(
      socketId,
      profile,
      (data) => this.writeSocket(socketId, data),
      location.href,
      title
    );
    this.session.feed(firstFrame);
    void this.registerWithWorker();
  }

  private writeSocket(socketId: string, data: string | ArrayBuffer) {
    window.postMessage(
      { __bp: this.channel, kind: 'write', socketId, data },
      window.location.origin
    );
  }

  private queryScreen(): Promise<string> {
    if (!this.channel) return Promise.resolve('');
    const reqId = `scr_${++this.screenSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.screenWaiters.delete(reqId);
        resolve('');
      }, 300);
      this.screenWaiters.set(reqId, (text) => {
        clearTimeout(timer);
        resolve(text);
      });
      window.postMessage(
        { __bp: this.channel, kind: 'screen-query', reqId },
        window.location.origin
      );
    });
  }

  /* ----------------------- worker port ----------------------- */

  private connectPort() {
    try {
      this.port = chrome.runtime.connect({ name: 'session' });
      this.portRetryMs = 1_000;
      this.port.onDisconnect.addListener(() => {
        this.port = null;
        setTimeout(() => this.connectPort(), this.portRetryMs);
        this.portRetryMs = Math.min(this.portRetryMs * 2, 10_000);
      });
      this.port.onMessage.addListener(
        (msg: {
          kind?: string;
          requestId?: string;
          tool?: string;
          params?: Record<string, unknown>;
        }) => {
          if (msg?.kind === 'tool' && msg.requestId && msg.tool) {
            void this.handleTool(msg.requestId, msg.tool, msg.params ?? {});
          }
        }
      );
      void this.registerWithWorker();
    } catch {
      /* extension context invalidated (reload) */
    }
  }

  private sessionInfo(): SessionInfo | null {
    if (!this.session) return null;
    const info = this.session.info;
    info.title = this.session.title;
    info.url = this.session.url;
    info.lastActivityAt = this.session.lastActivityAt;
    return info;
  }

  private async registerWithWorker() {
    const info = this.sessionInfo();
    if (!info || !this.port) return;
    try {
      this.port.postMessage({ kind: 'register', session: info });
    } catch {
      /* port dying; reconnect logic handles it */
    }
  }

  private pushSessionsIfChanged() {
    const info = this.sessionInfo();
    if (!info || !this.port) return;
    if (Date.now() - this.lastSessionsPush < 1_500) return;
    this.lastSessionsPush = Date.now();
    try {
      this.port.postMessage({ kind: 'sessions', sessions: [info] });
    } catch {
      /* ignore */
    }
  }

  /* ----------------------- tool execution ----------------------- */

  private async handleTool(requestId: string, tool: string, params: Record<string, unknown>) {
    const reply = (ok: boolean, data?: unknown, error?: string) => {
      try {
        this.port?.postMessage({ kind: 'tool-result', requestId, ok, data, error });
      } catch {
        /* ignore */
      }
    };
    const session = this.session;
    if (!session) {
      reply(false, undefined, 'no terminal session on this tab');
      return;
    }

    try {
      switch (tool) {
        case ToolName.ListSessions: {
          const info = this.sessionInfo();
          reply(true, { sessions: info ? [info] : [] });
          return;
        }
        case ToolName.SendCommand: {
          const result = await session.executeCommand(String(params.command ?? ''), {
            waitMs:
              typeof params.waitMs === 'number'
                ? params.waitMs
                : (this.settings?.defaultWaitMs ?? 10_000),
            attachSentinel: params.attachSentinel !== false,
          });
          reply(true, result);
          return;
        }
        case ToolName.ReadOutput: {
          const cursor = typeof params.cursor === 'number' ? params.cursor : 0;
          const maxChars = typeof params.maxChars === 'number' ? params.maxChars : 8_000;
          const result = session.readText(cursor, maxChars);
          reply(true, result);
          return;
        }
        case ToolName.WaitOutput: {
          // Default cursor = "everything from now on", not the whole scrollback.
          const cursor = typeof params.cursor === 'number' ? params.cursor : session.endCursor;
          const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 20_000;
          const quietMs = typeof params.quietMs === 'number' ? params.quietMs : 1_000;
          const result = await session.waitOutput(cursor, timeoutMs, quietMs);
          reply(true, result);
          return;
        }
        case ToolName.SendKey: {
          const ok = session.sendKey(String(params.key ?? ''));
          reply(ok, ok ? { ok } : undefined, ok ? undefined : `unsupported key`);
          return;
        }
        case ToolName.GetScreen: {
          const maxLines = typeof params.maxLines === 'number' ? params.maxLines : 40;
          const live = await this.queryScreen();
          if (live) {
            const lines = live.split('\n');
            const truncated = lines.length > maxLines;
            reply(true, {
              screen: truncated ? lines.slice(-maxLines).join('\n') : live,
              truncated,
            });
            return;
          }
          reply(true, session.screenLines(maxLines));
          return;
        }
        default:
          reply(false, undefined, `unknown tool: ${tool}`);
      }
    } catch (err) {
      reply(false, undefined, (err as Error).message);
    }
  }
}

const controller = new TabController();
void controller.start();
