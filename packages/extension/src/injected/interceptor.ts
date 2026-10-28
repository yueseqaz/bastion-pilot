/**
 * MAIN-world interceptor. Runs at document_start, before any page script, in
 * every site the user granted BastionPilot access to.
 *
 * It replaces window.WebSocket with a subclass that tees every downstream
 * frame to the isolated-world content controller via window.postMessage and
 * accepts upstream writes on request. It also offers a best-effort "read the
 * xterm screen" helper for alternate-screen situations (vim, top, ...).
 *
 * No chrome.* APIs here — this file runs in the page world.
 */

interface BpWindow {
  __bastionPilotInterceptor?: boolean;
  WebSocket: typeof WebSocket;
  [key: string]: unknown;
}

(function main() {
  const w = window as unknown as BpWindow;
  if (w.__bastionPilotInterceptor) return;
  w.__bastionPilotInterceptor = true;

  const channel = `bp_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  document.documentElement.setAttribute('data-bp-channel', channel);

  const NativeWebSocket = w.WebSocket;
  const sockets = new Map<string, WebSocket>();
  let seq = 0;

  const post = (msg: Record<string, unknown>) => {
    try {
      window.postMessage(msg, window.location.origin);
    } catch {
      /* serialization failures are non-fatal */
    }
  };

  const teeDown = (socketId: string, data: string | ArrayBuffer | Blob) => {
    if (typeof data === 'string' || data instanceof ArrayBuffer) {
      post({ __bp: channel, kind: 'down', socketId, data });
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data
        .arrayBuffer()
        .then((buf) => post({ __bp: channel, kind: 'down', socketId, data: buf }))
        .catch(() => {});
    }
  };

  class PatchedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const socketId = `ws_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
      (this as unknown as Record<string, unknown>).__bpId = socketId;
      sockets.set(socketId, this);
      post({ __bp: channel, kind: 'socket', socketId, url: String(url) });
      this.addEventListener('message', (ev: MessageEvent) => {
        teeDown(socketId, ev.data as string | ArrayBuffer | Blob);
      });
      this.addEventListener('close', () => sockets.delete(socketId));
      const realSend = this.send.bind(this);
      (this as unknown as Record<string, unknown>).__bpRealSend = realSend;
      this.send = function patchedSend(data: string | ArrayBuffer | Blob) {
        return realSend(data);
      };
    }
  }
  Object.assign(PatchedWebSocket, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  });
  try {
    w.WebSocket = PatchedWebSocket;
  } catch {
    /* a frozen window.WebSocket is rare; the extension then stays passive */
  }

  const findSocket = (socketId: unknown): WebSocket | null => {
    const socket = sockets.get(String(socketId));
    return socket && socket.readyState === WebSocket.OPEN ? socket : null;
  };

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const msg = ev.data as {
      __bp?: string;
      kind?: string;
      socketId?: unknown;
      data?: unknown;
      reqId?: string;
    };
    if (!msg || msg.__bp !== channel) return;
    if (msg.kind === 'write') {
      const socket = findSocket(msg.socketId);
      if (socket) {
        try {
          (socket as unknown as { __bpRealSend: (d: unknown) => void }).__bpRealSend(msg.data);
        } catch {
          /* socket died between check and send */
        }
      }
      return;
    }
    if (msg.kind === 'screen-query') {
      const text = collectXtermScreen();
      post({ __bp: channel, kind: 'screen-result', reqId: msg.reqId, text });
    }
  });

  /* ---------------- best-effort xterm screen reading ---------------- */

  function isXtermLike(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const v = value as { buffer?: { active?: unknown }; input?: unknown; cols?: unknown };
    return (
      !!v.buffer && !!v.buffer.active && typeof v.input === 'function' && typeof v.cols === 'number'
    );
  }

  function findXtermInstance(): unknown {
    const commonNames = ['term', 'terminal', 'xterm', 'tty', 'terminalInstance', '_term'];
    for (const name of commonNames) {
      try {
        const value = w[name];
        if (isXtermLike(value)) return value;
      } catch {
        /* cross-origin property access */
      }
    }
    try {
      for (const key of Object.keys(w)) {
        if (commonNames.includes(key)) continue;
        let value: unknown;
        try {
          value = w[key];
        } catch {
          continue;
        }
        if (isXtermLike(value)) return value;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function collectXtermScreen(): string {
    try {
      const term = findXtermInstance() as {
        buffer: {
          active: {
            viewportY: number;
            getLine(y: number): { translateToString(t: boolean): string } | null;
          };
        };
        rows: number;
      } | null;
      if (!term) return '';
      const buffer = term.buffer.active;
      const rows = Math.max(1, Math.min(200, term.rows ?? 24));
      const lines: string[] = [];
      for (let i = 0; i < rows; i++) {
        const line = buffer.getLine(buffer.viewportY + i);
        lines.push(line ? line.translateToString(true) : '');
      }
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
      return lines.join('\n');
    } catch {
      return '';
    }
  }
})();
