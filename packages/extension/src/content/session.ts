import {
  TextRingBuffer,
  TerminalTextRenderer,
  extractExitCode,
  newSentinelNonce,
  sentinelCommandFor,
  wrapCommandWithSentinel,
  cleanCommandOutput,
  type SessionInfo,
} from '@bastion-pilot/protocol';
import { createFramer, type Framer } from './framer.js';
import { domTypeText, keySequence } from './keys.js';
import type { SiteProfile } from '../profiles.js';

const SCAN_TAIL_CHARS = 8192;
const TICK_MS = 50;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export interface ExecuteOptions {
  waitMs?: number;
  quietMs?: number;
  attachSentinel?: boolean;
}

export interface SessionOptions {
  /**
   * Bracketed-paste mode for command typing. The production default is false
   * so opening a terminal never emits an unapproved probe command; null keeps
   * the legacy probe available for explicit compatibility/testing.
   */
  bracketedPaste?: boolean | null;
}

export interface CommandResult {
  status: 'completed' | 'quiet' | 'timeout';
  exitCode: number | null;
  cursor: number;
  text: string;
  hasMore: boolean;
}

export interface WaitOutputResult {
  status: 'quiet' | 'timeout';
  nextCursor: number;
  text: string;
  hasMore: boolean;
}

interface SentinelWaiter {
  nonce: string;
  regex: RegExp;
  done: boolean;
  resolve: () => void;
}

/**
 * One hooked terminal: decodes downstream frames, renders them, keeps a
 * cursor-addressed buffer and implements the command-execution semantics the
 * bridge exposes as tools. Pure logic — no chrome.* dependencies.
 */
export class TerminalSession {
  readonly sessionId: string;
  readonly createdAt = Date.now();
  lastActivityAt = Date.now();
  info: SessionInfo;

  private readonly framer: Framer;
  private readonly renderer = new TerminalTextRenderer();
  private readonly ring = new TextRingBuffer(200_000);
  private readonly decoder = new TextDecoder('utf-8');
  private readonly waiters: SentinelWaiter[] = [];
  private scanTail = '';
  private lastDataAt = 0;
  private bracketedPaste: boolean | null;

  constructor(
    readonly socketId: string,
    readonly profile: SiteProfile,
    private readonly write: (data: string | ArrayBuffer) => void,
    public readonly url: string,
    public readonly title: string,
    opts: SessionOptions = {}
  ) {
    this.sessionId = `sess_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    this.framer = createFramer(profile.framer);
    this.bracketedPaste = opts.bracketedPaste === undefined ? false : opts.bracketedPaste;
    this.info = {
      sessionId: this.sessionId,
      title,
      url,
      profileId: profile.id,
      state: 'active',
      createdAt: this.createdAt,
      lastActivityAt: this.createdAt,
    };
  }

  /** Absolute offset just past the newest committed output. */
  get endCursor(): number {
    return this.ring.endCursor;
  }

  /** Feed a downstream frame (already teed from the page WebSocket). */
  feed(data: string | ArrayBuffer) {
    const bytes = this.framer.decodeDown(data);
    let text: string;
    try {
      text = this.decoder.decode(bytes, { stream: true });
    } catch {
      return;
    }
    if (!text) return;
    this.lastDataAt = Date.now();
    this.append(text);
  }

  private append(text: string) {
    const completed = this.renderer.push(text);
    if (completed.length > 0) {
      const split = completed.split('\n');
      split.pop(); // push() always terminates completed lines with '\n'
      this.ring.writeLines(split.map((l) => l + '\n'));
      this.scanTail = (this.scanTail + completed).slice(-SCAN_TAIL_CHARS);
    }
    this.lastActivityAt = Date.now();
    this.checkWaiters();
  }

  private scanText(): string {
    return this.scanTail + this.renderer.pending();
  }

  private checkWaiters() {
    const text = this.scanText();
    for (const waiter of this.waiters) {
      if (!waiter.done && waiter.regex.test(text)) {
        waiter.done = true;
        waiter.resolve();
      }
    }
  }

  readText(
    cursor: number,
    maxChars: number
  ): {
    text: string;
    nextCursor: number;
    hasMore: boolean;
    dropped: boolean;
  } {
    const result = this.ring.readFromCursor(cursor, maxChars);
    const pending = this.renderer.pending();
    return { ...result, text: stripSentinelNoise(result.text + pending) };
  }

  /** Snapshot of the visible screen (fallback when no xterm instance is reachable). */
  screenLines(maxLines: number): { screen: string; truncated: boolean } {
    const committed = this.ring.tailLines(maxLines).map((l) => l.replace(/\n$/, ''));
    const pending = this.renderer.pending();
    if (pending) committed.push(pending);
    const total = this.ring.tailLines(10_000).length;
    return { screen: committed.join('\n'), truncated: total > maxLines };
  }

  /** Type raw text (or control sequences) into the terminal. */
  typeText(text: string): boolean {
    if (this.profile.inputMode === 'dom') {
      const ok = domTypeText(text);
      if (ok) {
        this.lastActivityAt = Date.now();
        return true;
      }
      // fall through to socket mode when the DOM textarea is unavailable
    }
    const frame = this.framer.encodeUp(text);
    try {
      this.write(frame);
    } catch {
      return false;
    }
    this.lastActivityAt = Date.now();
    return true;
  }

  sendKey(key: string): boolean {
    const sequence = keySequence(key);
    if (!sequence) return false;
    return this.typeText(sequence);
  }

  /**
   * Type a command and watch its execution:
   * - sentinel attached: resolve when `echo __BP_..._$?__` prints (exit code
   *   included), when output goes quiet, or when the wait elapses;
   * - no sentinel (interactive dialogs): resolve on quiet or timeout only.
   *
   * The first sentinel-attached command probes the shell for bracketed-paste
   * support; when supported, commands are typed inside paste markers so tabs
   * and multi-line payloads cannot be mangled by readline.
   */
  async executeCommand(command: string, opts: ExecuteOptions = {}): Promise<CommandResult> {
    const waitMs = opts.waitMs ?? 10_000;
    const quietMs = opts.quietMs ?? 800;
    const attachSentinel = opts.attachSentinel !== false;
    const initialCursor = this.ring.endCursor;

    if (!attachSentinel) {
      const sentAt = Date.now();
      this.typeText(`${command}\r`);
      const status = await this.waitQuietOrTimeout(sentAt, waitMs, quietMs);
      return this.buildResult(initialCursor, status, null, command);
    }

    if (this.bracketedPaste === null) {
      this.bracketedPaste = await this.probeBracketedPaste(Math.max(800, Math.min(waitMs, 3_000)));
    }

    // Do not include the one-time bracketed-paste probe in the user's command
    // result; it is an internal capability check, not terminal output.
    const cursorBefore = this.ring.endCursor;

    const nonce = newSentinelNonce();
    const { waiter, done } = this.addWaiter(nonce);

    const sentAt = Date.now();
    if (this.bracketedPaste) {
      const cmd = command.replace(/\n+$/, '');
      this.typeText(
        `${BRACKETED_PASTE_START}${cmd}${BRACKETED_PASTE_END}\n${sentinelCommandFor(nonce)}\n`
      );
    } else {
      this.typeText(wrapCommandWithSentinel(command, nonce));
    }

    const raced = await Promise.race([
      done.then(() => 'completed' as const),
      this.waitQuietOrTimeout(sentAt, waitMs, quietMs),
    ]);

    this.removeWaiter(waiter);
    if (raced === 'completed') {
      const exitCode = extractExitCode(this.scanText(), nonce);
      return this.buildResult(cursorBefore, 'completed', exitCode, command);
    }
    return this.buildResult(cursorBefore, raced, null, command);
  }

  /**
   * Probe readline for bracketed-paste support: type `true` wrapped in paste
   * markers followed by a sentinel. Supported shells consume the markers and
   * exit 0; unsupported ones execute the markers as part of the command line
   * (non-zero exit). The result is cached for the session lifetime.
   */
  private async probeBracketedPaste(waitMs: number): Promise<boolean> {
    const nonce = newSentinelNonce();
    const { waiter, done } = this.addWaiter(nonce);
    const sentAt = Date.now();
    this.typeText(
      `${BRACKETED_PASTE_START}true${BRACKETED_PASTE_END}\n${sentinelCommandFor(nonce)}\n`
    );
    const raced = await Promise.race([
      done.then(() => 'completed' as const),
      this.waitQuietOrTimeout(sentAt, waitMs, 500),
    ]);
    this.removeWaiter(waiter);
    return raced === 'completed' && extractExitCode(this.scanText(), nonce) === 0;
  }

  private addWaiter(nonce: string): { waiter: SentinelWaiter; done: Promise<void> } {
    const waiter: SentinelWaiter = {
      nonce,
      regex: new RegExp(`__BP_${nonce}_(\\d+)__`),
      done: false,
      resolve: () => {},
    };
    const done = new Promise<void>((resolve) => {
      waiter.resolve = resolve;
    });
    this.waiters.push(waiter);
    return { waiter, done };
  }

  /**
   * Wait for output newer than `cursor`; resolves when the stream goes quiet
   * (likely finished) or the timeout elapses while still producing output.
   */
  async waitOutput(cursor: number, timeoutMs = 20_000, quietMs = 1_000): Promise<WaitOutputResult> {
    const start = Date.now();
    const deadline = start + timeoutMs;
    const activityBaseline = this.lastDataAt;
    while (this.lastDataAt <= activityBaseline && Date.now() < deadline) {
      await sleep(TICK_MS);
    }
    if (this.lastDataAt <= activityBaseline) {
      return { status: 'timeout', nextCursor: cursor, text: '', hasMore: false };
    }
    const quietDeadline = Math.min(deadline, Date.now() + Math.max(quietMs, 200) + 5_000);
    while (Date.now() - this.lastDataAt < quietMs && Date.now() < quietDeadline) {
      await sleep(TICK_MS);
    }
    const stillFlowing = Date.now() - this.lastDataAt < quietMs && Date.now() >= deadline;
    const result = this.readText(cursor, 200_000);
    return {
      status: stillFlowing ? 'timeout' : 'quiet',
      nextCursor: result.nextCursor,
      text: result.text,
      hasMore: result.hasMore,
    };
  }

  private async waitQuietOrTimeout(
    sentAt: number,
    waitMs: number,
    quietMs: number
  ): Promise<'quiet' | 'timeout'> {
    const deadline = sentAt + waitMs;
    const baseline = sentAt - 1;
    while (Date.now() < deadline) {
      await sleep(TICK_MS);
      const sawData = this.lastDataAt > baseline;
      if (sawData && Date.now() - this.lastDataAt >= quietMs) return 'quiet';
    }
    return 'timeout';
  }

  private removeWaiter(waiter: SentinelWaiter) {
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }

  private buildResult(
    cursorBefore: number,
    status: CommandResult['status'],
    exitCode: number | null,
    command?: string
  ): CommandResult {
    const result = this.readText(cursorBefore, 200_000);
    return {
      status,
      exitCode,
      cursor: result.nextCursor,
      text: cleanCommandOutput(result.text, command),
      hasMore: result.hasMore,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hide the internal completion marker from tool results while retaining it in the raw buffer. */
function stripSentinelNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.includes('__BP_') || !/(?:\$\?__|_[0-9]+__)/.test(line))
    .join('\n');
}
