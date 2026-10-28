/**
 * Declarative site profiles. A profile tells the content controller how the
 * bastion product frames its terminal stream — everything else (WebSocket
 * interception, buffering, sentinels) is product-independent.
 *
 * Adding support for a new bastion product is usually just a new entry here.
 */
export interface FramerConfig {
  /** Down/up framing of the PTY stream. */
  type: 'raw' | 'json' | 'base64';
  /** json: property that carries the PTY payload on the way down. */
  dataField?: string;
  /** json: how the payload is encoded inside the property. */
  encoding?: 'plain' | 'base64';
  /** json: property name for input frames on the way up. */
  inputField?: string;
}

export interface SiteProfile {
  id: string;
  name: string;
  description: string;
  framer: FramerConfig;
  /** 'socket' writes PTY bytes directly to the terminal WebSocket (default);
   *  'dom' synthesizes keyboard events into the xterm textarea. */
  inputMode: 'socket' | 'dom';
  /** DOM markers that make the controller treat a socket as the terminal. */
  terminalDomHints: string[];
  /** Shell prompt endings used as an extra completion signal. */
  promptHints: string[];
}

export const GENERIC_XTERM_PROFILE: SiteProfile = {
  id: 'generic-xterm',
  name: 'Generic xterm.js web terminal',
  description:
    'Default profile for any web terminal built on xterm.js with a raw PTY byte stream ' +
    '(ttyd, koko, sshwifty, most bastion products).',
  framer: { type: 'raw' },
  inputMode: 'socket',
  terminalDomHints: ['.xterm', '.xterm-screen', 'canvas'],
  promptHints: ['$ ', '# ', ']$ ', ']# ', '> ', '~$ ', '~# '],
};

export const JUMPSERVER_PROFILE: SiteProfile = {
  id: 'jumpserver',
  name: 'JumpServer (koko web terminal)',
  description:
    'JumpServer community/enterprise web terminal. koko streams a raw PTY byte stream over ' +
    'the WebSocket, so the generic xterm.js profile works; this profile adds JumpServer-specific ' +
    'DOM hints and prompt patterns. If your version frames messages as JSON, duplicate this ' +
    'profile with framer.type = "json" and the matching dataField.',
  framer: { type: 'raw' },
  inputMode: 'socket',
  terminalDomHints: ['.xterm', '.xterm-screen', '#terminal', '.term-output'],
  promptHints: ['$ ', '# ', ']$ ', ']# ', ']~$ ', 'optimus>$'],
};

export const BUILTIN_PROFILES: SiteProfile[] = [GENERIC_XTERM_PROFILE, JUMPSERVER_PROFILE];

export function profileById(id: string | undefined | null): SiteProfile {
  if (id) {
    const found = BUILTIN_PROFILES.find((p) => p.id === id);
    if (found) return found;
  }
  return GENERIC_XTERM_PROFILE;
}

/** Normalize user input into a scheme+host[:port] origin. */
export function normalizeOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  // Reject non-http(s) schemes instead of mangling them with a prefix.
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function originToMatchPattern(origin: string): string | null {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

export function urlMatchesSite(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
