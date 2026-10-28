import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface InlineOutput {
  text: string;
  /** Absolute path of the full output when it was truncated. */
  file?: string;
  truncated: boolean;
  totalChars: number;
}

/**
 * Keeps tool results small enough to feed a model: oversized terminal output
 * is persisted to `<home>/outputs/` (chmod 600) and replaced by a head+tail
 * excerpt that references the file. Brain agents (e.g. Claude Code) can then
 * read the full file with their own file tools.
 */
export class OutputStore {
  constructor(
    private readonly dir: string,
    private readonly maxInlineChars: number,
  ) {}

  async process(text: string, label: string): Promise<InlineOutput> {
    if (text.length <= this.maxInlineChars) {
      return { text, truncated: false, totalChars: text.length };
    }
    await fsp.mkdir(this.dir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'output';
    const file = path.join(
      this.dir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeLabel}-${crypto.randomBytes(3).toString('hex')}.log`,
    );
    await fsp.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
    const head = Math.max(200, Math.floor(this.maxInlineChars * 0.7));
    const tail = Math.max(0, this.maxInlineChars - head);
    const omitted = text.length - head - tail;
    const excerpt =
      text.slice(0, head) +
      `\n\n[... ${omitted} characters truncated — full output saved to ${file} ...]\n\n` +
      (tail > 0 ? text.slice(-tail) : '');
    return { text: excerpt, file, truncated: true, totalChars: text.length };
  }
}
