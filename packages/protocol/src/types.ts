/** A terminal session: one tab of a web terminal the extension has hooked. */
export interface SessionInfo {
  sessionId: string;
  /** Tab / window title as shown by the bastion product. */
  title: string;
  url: string;
  /** Site profile applied to this session, e.g. "generic-xterm". */
  profileId: string;
  state: 'active' | 'idle';
  createdAt: number;
  lastActivityAt: number;
}

export type ClientRole = 'extension' | 'brain';

export type ToolSource = 'mcp' | 'agent' | 'panel';
