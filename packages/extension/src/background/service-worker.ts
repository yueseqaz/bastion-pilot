import {
  makeEnvelope,
  parseDaemonMessage,
  ToolName,
  type DaemonMessage,
  type SessionInfo,
} from '@bastion-pilot/protocol';

/**
 * Service worker: the extension's single WebSocket client to the daemon.
 * Routes tool calls to the right tab, relays chat events to the side panel,
 * manages approval requests and keeps content scripts registered for the
 * sites the user granted.
 */

const SETTINGS_KEY = 'settings';

interface SiteEntry {
  origin: string;
  profileId?: string;
}

interface Settings {
  daemonUrl: string;
  token: string;
  sites: SiteEntry[];
  defaultWaitMs?: number;
}

interface PendingApproval {
  requestId: string;
  source: string;
  tool: string;
  sessionId?: string;
  summary: string;
  expiresAt: number;
}

interface PendingTool {
  callId: string;
  port: chrome.runtime.Port;
}

const DEFAULTS: Settings = {
  daemonUrl: 'ws://127.0.0.1:8765',
  token: '',
  sites: [],
};

async function loadSettings(): Promise<Settings> {
  try {
    const stored = (await chrome.storage.sync.get(SETTINGS_KEY)) as Record<string, unknown>;
    const s = (stored[SETTINGS_KEY] ?? {}) as Partial<Settings>;
    return { ...DEFAULTS, ...s, sites: s.sites ?? [] };
  } catch {
    return { ...DEFAULTS };
  }
}

/* ------------------------------------------------------------------ */
/* Daemon connection                                                   */
/* ------------------------------------------------------------------ */

class DaemonConnection {
  private ws: WebSocket | null = null;
  private retryMs = 1_000;
  private stopped = false;
  private settings: Settings | null = null;

  constructor(
    private readonly onMessage: (msg: DaemonMessage) => void,
    private readonly onStateChange: (connected: boolean) => void
  ) {}

  async start() {
    this.stopped = false;
    this.settings = await loadSettings();
    this.dial();
  }

  restart() {
    this.stopped = false;
    void loadSettings().then((settings) => {
      this.settings = settings;
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
      this.dial();
    });
  }

  stop() {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(type: string, payload: unknown): boolean {
    if (!this.connected) return false;
    try {
      this.ws!.send(JSON.stringify(makeEnvelope(type, payload)));
      return true;
    } catch {
      return false;
    }
  }

  private dial() {
    if (this.stopped) return;
    const settings = this.settings;
    if (!settings || !settings.token) {
      // Not paired yet; retry quietly.
      setTimeout(() => this.dial(), 5_000);
      return;
    }
    let settled = false;
    const ws = new WebSocket(settings.daemonUrl);
    const fail = () => {
      if (settled) return;
      settled = true;
      this.ws = null;
      this.onStateChange(false);
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
      setTimeout(() => this.dial(), this.retryMs);
    };
    ws.onopen = () => {
      ws.send(
        JSON.stringify(
          makeEnvelope('hello', {
            token: settings.token,
            role: 'extension',
            name: 'BastionPilot',
            version: chrome.runtime.getManifest().version,
          })
        )
      );
    };
    ws.onmessage = (ev) => {
      const parsed = parseDaemonMessage(safeJson(String(ev.data)));
      if (!parsed.ok) return;
      if (!settled && parsed.message.type === 'welcome') {
        settled = true;
        this.ws = ws;
        this.retryMs = 1_000;
        this.onStateChange(true);
        // Re-announce current sessions right after connecting.
        const sessions = registry.list();
        if (sessions.length > 0) this.send('sessions_update', { sessions });
        return;
      }
      this.onMessage(parsed.message);
    };
    ws.onerror = () => fail();
    ws.onclose = () => fail();
  }
}

/* ------------------------------------------------------------------ */
/* Session registry (content-script ports)                             */
/* ------------------------------------------------------------------ */

class SessionRegistry {
  private sessions = new Map<string, { port: chrome.runtime.Port; info: SessionInfo }>();

  upsert(port: chrome.runtime.Port, info: SessionInfo) {
    this.sessions.set(info.sessionId, { port, info });
    broadcastState();
    this.pushSessionsToDaemon();
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((e) => e.info);
  }

  byId(sessionId: string | undefined): { port: chrome.runtime.Port; info: SessionInfo } | null {
    if (sessionId) {
      const found = this.sessions.get(sessionId);
      if (found) return found;
    }
    const first = this.sessions.values().next();
    return first.done ? null : first.value;
  }

  removeByPort(port: chrome.runtime.Port): boolean {
    let removed = false;
    for (const [sessionId, entry] of [...this.sessions]) {
      if (entry.port === port) {
        this.sessions.delete(sessionId);
        removed = true;
      }
    }
    return removed;
  }

  pushSessionsToDaemon() {
    daemon.send('sessions_update', { sessions: this.list() });
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const pendingTools = new Map<string, PendingTool>();
const pendingApprovals = new Map<string, PendingApproval>();
const panelPorts = new Set<chrome.runtime.Port>();

function broadcastState() {
  const state = {
    kind: 'state',
    connected: daemon.connected,
    sessions: registry.list(),
    approvals: [...pendingApprovals.values()],
  };
  for (const port of panelPorts) {
    try {
      port.postMessage(state);
    } catch {
      /* ignore */
    }
  }
  updateBadge();
}

function updateBadge() {
  const n = pendingApprovals.size;
  void chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
}

function forwardToPanels(message: unknown) {
  for (const port of panelPorts) {
    try {
      port.postMessage(message);
    } catch {
      /* ignore */
    }
  }
}

const registry = new SessionRegistry();

const daemon = new DaemonConnection(
  (msg) => void onDaemonMessage(msg),
  () => broadcastState()
);

async function onDaemonMessage(msg: DaemonMessage) {
  switch (msg.type) {
    case 'ping':
      daemon.send('pong', {});
      return;
    case 'tool_call': {
      await routeToolCall(msg.payload.callId, msg.payload.tool, msg.payload.params);
      return;
    }
    case 'approval_request': {
      const req: PendingApproval = {
        requestId: msg.payload.requestId,
        source: msg.payload.source,
        tool: msg.payload.tool,
        sessionId: msg.payload.sessionId,
        summary: msg.payload.summary,
        expiresAt: msg.payload.expiresAt,
      };
      pendingApprovals.set(req.requestId, req);
      broadcastState();
      notifyApproval(req);
      return;
    }
    case 'chat_created':
    case 'chat_delta':
    case 'chat_tool_call':
    case 'chat_tool_result':
    case 'chat_done':
    case 'providers_list':
    case 'error':
      forwardToPanels({ kind: 'chat-event', message: msg });
      return;
    default:
      return;
  }
}

async function routeToolCall(callId: string, tool: string, params: Record<string, unknown>) {
  // Session discovery is global: the registry holds every hooked tab/frame,
  // while each content controller only knows about its own frame.
  if (tool === ToolName.ListSessions) {
    daemon.send('tool_result', { callId, ok: true, data: { sessions: registry.list() } });
    return;
  }
  const target = registry.byId(typeof params.sessionId === 'string' ? params.sessionId : undefined);
  if (!target || !target.port) {
    daemon.send('tool_result', {
      callId,
      ok: false,
      error:
        'no bastion terminal session is open — open a web-terminal tab and make sure the site is granted in BastionPilot options',
    });
    return;
  }
  try {
    target.port.postMessage({ kind: 'tool', requestId: callId, tool, params });
    pendingTools.set(callId, { callId, port: target.port });
  } catch (err) {
    daemon.send('tool_result', { callId, ok: false, error: (err as Error).message });
  }
}

function notifyApproval(req: PendingApproval) {
  try {
    const id = `bp-approval-${req.requestId}`;
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'BastionPilot — approval required',
      message: req.summary,
    });
  } catch {
    /* notifications unavailable; the side panel still shows the banner */
  }
}

chrome.notifications?.onClicked.addListener((id) => {
  if (!id.startsWith('bp-approval-')) return;
  void openSidePanel();
});

async function openSidePanel() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.id !== undefined) {
      await chrome.sidePanel.open({ windowId: win.id });
    }
  } catch {
    /* user will open the panel manually */
  }
}

/* ----------------------- ports ----------------------- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'session') {
    port.onMessage.addListener(
      (msg: {
        kind?: string;
        session?: SessionInfo;
        sessions?: SessionInfo[];
        requestId?: string;
        ok?: boolean;
        data?: unknown;
        error?: string;
      }) => {
        if (msg.kind === 'register' && msg.session) {
          registry.upsert(port, msg.session);
        } else if (msg.kind === 'sessions' && msg.sessions) {
          for (const info of msg.sessions) registry.upsert(port, info);
        } else if (msg.kind === 'tool-result' && msg.requestId) {
          const pending = pendingTools.get(msg.requestId);
          if (!pending) return;
          pendingTools.delete(msg.requestId);
          daemon.send('tool_result', {
            callId: msg.requestId,
            ok: msg.ok === true,
            data: msg.data,
            error: msg.error,
          });
        }
      }
    );
    port.onDisconnect.addListener(() => {
      for (const [callId, pending] of [...pendingTools]) {
        if (pending.port === port) {
          pendingTools.delete(callId);
          daemon.send('tool_result', { callId, ok: false, error: 'terminal tab closed' });
        }
      }
      const removed = registry.removeByPort(port);
      if (removed) {
        registry.pushSessionsToDaemon();
        broadcastState();
      }
    });
    return;
  }
  if (port.name === 'panel') {
    panelPorts.add(port);
    port.onMessage.addListener(
      (msg: {
        kind?: string;
        providerId?: string;
        chatId?: string;
        text?: string;
        requestId?: string;
        approved?: boolean;
      }) => {
        switch (msg.kind) {
          case 'chat-new':
            daemon.send('chat_new', { providerId: msg.providerId });
            break;
          case 'chat-message':
            if (msg.chatId && msg.text)
              daemon.send('chat_message', { chatId: msg.chatId, text: msg.text });
            break;
          case 'chat-abort':
            if (msg.chatId) daemon.send('chat_abort', { chatId: msg.chatId });
            break;
          case 'approval-response':
            if (msg.requestId) {
              pendingApprovals.delete(msg.requestId);
              broadcastState();
              daemon.send('approval_response', {
                requestId: msg.requestId,
                approved: msg.approved === true,
              });
            }
            break;
          case 'get-state':
            broadcastState();
            try {
              port.postMessage({
                kind: 'state',
                connected: daemon.connected,
                sessions: registry.list(),
                approvals: [...pendingApprovals.values()],
              });
            } catch {
              /* ignore */
            }
            break;
          default:
            break;
        }
      }
    );
    port.onDisconnect.addListener(() => {
      panelPorts.delete(port);
    });
    broadcastState();
  }
});

/* ----------------------- content script management ----------------------- */

const SCRIPT_MAIN = 'bp-main';
const SCRIPT_CONTENT = 'bp-content';

async function syncContentScripts() {
  const settings = await loadSettings();
  const matches = settings.sites
    .map((s) => {
      try {
        const url = new URL(s.origin);
        return `${url.protocol}//${url.host}/*`;
      } catch {
        return null;
      }
    })
    .filter((m): m is string => m !== null);

  for (const id of [SCRIPT_MAIN, SCRIPT_CONTENT]) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
    } catch {
      /* not registered yet */
    }
  }
  if (matches.length === 0) return;
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_MAIN,
        matches,
        js: ['interceptor.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
      },
      {
        id: SCRIPT_CONTENT,
        matches,
        js: ['content.js'],
        runAt: 'document_start',
        world: 'ISOLATED',
        allFrames: true,
      },
    ]);
  } catch (err) {
    console.error('[BastionPilot] failed to register content scripts', err);
  }
}

async function injectIntoExistingTabs() {
  const settings = await loadSettings();
  for (const site of settings.sites) {
    let tabs: chrome.tabs.Tab[] = [];
    try {
      tabs = await chrome.tabs.query({ url: `${site.origin}/*` });
    } catch {
      continue;
    }
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['interceptor.js'],
          world: 'MAIN',
        });
      } catch {
        /* already injected or unsupported page */
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js'],
          world: 'ISOLATED',
        });
      } catch {
        /* ignore */
      }
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void syncContentScripts().then(() => injectIntoExistingTabs());
  void daemon.start();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void syncContentScripts().then(() => injectIntoExistingTabs());
  void daemon.start();
});

chrome.action.onClicked.addListener(() => {
  void openSidePanel();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[SETTINGS_KEY]) {
    void syncContentScripts();
    daemon.restart();
  }
});

chrome.alarms.create('bp-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bp-keepalive' && !daemon.connected) {
    void daemon.start();
  }
});

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
