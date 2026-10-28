/**
 * Incremental renderer that turns a stream of PTY text (already UTF-8 decoded,
 * escape sequences included) into plain text an LLM can read.
 *
 * It applies the same overwrite semantics a real terminal would:
 * - `\r` returns the cursor to column 0, so subsequent characters overwrite
 *   the current line (progress bars, spinners, `psql` status lines ...).
 * - `\b` moves the cursor one column left.
 * - `\n` commits the current line.
 * - `\t` advances to the next multiple of 8.
 * Escape sequences (CSI / OSC / DCS / APC / PM / SOS and 2-3 char ESC pairs)
 * are consumed and dropped.
 *
 * Limitations (documented on purpose): every code point occupies exactly one
 * column, so East-Asian wide characters may shift overwriting slightly. This
 * is acceptable for log/command consumption by LLMs.
 */
export class TerminalTextRenderer {
  /** Safety valve: a string state consuming more than this many characters is
   * treated as garbage and abandoned, so a malformed emitter can never eat an
   * entire session's output. */
  private static readonly MAX_STR_CHARS = 8192;

  private line = '';
  private col = 0;
  private strLen = 0;
  private state: 'ground' | 'esc' | 'esc-int' | 'csi' | 'osc' | 'osc-esc' | 'str' | 'str-esc' =
    'ground';
  private completed: string[] = [];

  /**
   * Feed a chunk; returns the lines completed by this chunk (each ending with
   * `\n`). The trailing line still being built is available via `pending()`.
   */
  push(chunk: string): string {
    this.completed.length = 0;
    for (const ch of chunk) this.step(ch);
    return this.completed.join('');
  }

  /** The line currently being built (not yet terminated by `\n`). */
  pending(): string {
    return this.line;
  }

  private commit() {
    this.completed.push(this.line + '\n');
    this.line = '';
    this.col = 0;
  }

  private put(ch: string) {
    if (this.col < this.line.length) {
      this.line = this.line.slice(0, this.col) + ch + this.line.slice(this.col + 1);
    } else {
      while (this.line.length < this.col) this.line += ' ';
      this.line += ch;
    }
    this.col++;
  }

  private step(ch: string) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (this.state === 'osc' ||
        this.state === 'str' ||
        this.state === 'osc-esc' ||
        this.state === 'str-esc') &&
      ++this.strLen > TerminalTextRenderer.MAX_STR_CHARS
    ) {
      // Unterminated string sequence: give up on it and resume printing.
      this.state = 'ground';
      this.strLen = 0;
    }
    switch (this.state) {
      case 'ground': {
        if (ch === '\x1b') {
          this.state = 'esc';
        } else if (ch === '\n') {
          this.commit();
        } else if (ch === '\r') {
          this.col = 0;
        } else if (ch === '\b') {
          if (this.col > 0) this.col--;
        } else if (ch === '\t') {
          this.col += 8 - (this.col % 8);
        } else if (code < 0x20 || code === 0x7f) {
          // Other C0 controls and DEL are dropped.
        } else {
          this.put(ch);
        }
        return;
      }
      case 'esc': {
        switch (ch) {
          case '[':
            this.state = 'csi';
            break;
          case ']':
            this.state = 'osc';
            this.strLen = 0;
            break;
          case 'P':
          case '^':
          case '_':
          case 'X':
            this.state = 'str';
            this.strLen = 0;
            break;
          case '(':
          case ')':
          case '*':
          case '+':
          case '#':
          case '%':
            this.state = 'esc-int';
            break;
          default:
            // 2-char ESC sequence (ESC 7, ESC =, ...): swallowed.
            this.state = 'ground';
        }
        return;
      }
      case 'esc-int': {
        this.state = 'ground';
        return;
      }
      case 'csi': {
        // Parameter/intermediate bytes 0x20-0x3F, final byte 0x40-0x7E.
        if (code >= 0x40 && code <= 0x7e) this.state = 'ground';
        return;
      }
      case 'osc': {
        if (ch === '\x07') {
          this.state = 'ground';
          this.strLen = 0;
        } else if (ch === '\x1b') {
          this.state = 'osc-esc';
        }
        return;
      }
      case 'osc-esc': {
        // ESC inside OSC: ST (ESC \) terminates; anything else ends the OSC and
        // the ESC starts a fresh escape sequence (xterm-compatible).
        if (ch === '\\') {
          this.state = 'ground';
          this.strLen = 0;
        } else {
          this.state = 'esc';
          this.strLen = 0;
          this.step(ch);
        }
        return;
      }
      case 'str': {
        // DCS/APC/PM/SOS are terminated by ST (ESC \).
        if (ch === '\x1b') this.state = 'str-esc';
        return;
      }
      case 'str-esc': {
        if (ch === '\\') {
          this.state = 'ground';
          this.strLen = 0;
        } else if (ch === '\x1b') {
          this.state = 'str-esc';
        } else {
          this.state = 'str';
        }
        return;
      }
    }
  }
}

/**
 * Bounded ring buffer of rendered terminal lines addressed by a monotonic
 * character cursor, so consumers can read incrementally without missing or
 * re-reading content (unless the buffer overflowed and old lines were dropped).
 */
export class TextRingBuffer {
  private lines: string[] = []; // each line ends with '\n'
  private offsets: number[] = []; // absolute start offset of lines[i]
  private base = 0; // absolute offset of lines[0]
  private head = 0; // absolute offset of the next write
  private chars = 0;
  private droppedAny = false;

  constructor(private readonly capacity = 200_000) {}

  /** Append completed lines (each ending with '\n'). */
  writeLines(lines: readonly string[]) {
    for (const line of lines) {
      this.lines.push(line);
      this.offsets.push(this.head);
      this.head += line.length;
      this.chars += line.length;
    }
    while (this.chars > this.capacity && this.lines.length > 1) {
      const removed = this.lines.shift()!;
      this.offsets.shift();
      this.base += removed.length;
      this.chars -= removed.length;
      this.droppedAny = true;
    }
  }

  /** Absolute offset of the oldest retained character. */
  get startCursor(): number {
    return this.base;
  }

  /** Absolute offset just past the newest committed character. */
  get endCursor(): number {
    return this.head;
  }

  get hasDropped(): boolean {
    return this.droppedAny;
  }

  readFromCursor(
    cursor: number,
    maxChars: number
  ): {
    text: string;
    nextCursor: number;
    hasMore: boolean;
    dropped: boolean;
  } {
    const dropped = cursor < this.base;
    const start = Math.max(cursor, this.base);
    const pieces: string[] = [];
    let taken = 0;
    let next = start;
    let hasMore = false;
    for (let i = 0; i < this.lines.length; i++) {
      const lineStart = this.offsets[i]!;
      const line = this.lines[i]!;
      const lineEnd = lineStart + line.length;
      if (lineEnd <= start) continue;
      const from = Math.max(0, start - lineStart);
      const available = line.length - from;
      if (taken + available > maxChars) {
        const take = maxChars - taken;
        if (take > 0) {
          pieces.push(line.slice(from, from + take));
          next = lineStart + from + take;
          taken += take;
        }
        hasMore = true;
        break;
      }
      pieces.push(line.slice(from));
      next = lineEnd;
      taken += available;
    }
    hasMore = hasMore || next < this.head;
    return { text: pieces.join(''), nextCursor: next, hasMore, dropped };
  }

  /** Last `n` committed lines (for screen fallbacks). */
  tailLines(n: number): string[] {
    return this.lines.slice(Math.max(0, this.lines.length - n));
  }
}
