import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface TranscriptEntry {
  ts: string;
  source: string;
  tool: string;
  sessionId: string;
  exitCode?: number | null;
  text?: string;
}

/**
 * Per-session terminal transcripts for post-incident review. Every tool
 * result that carries terminal text is appended to
 * `<dir>/<sessionId>.log` between header lines, so a transcript reads like a
 * replay of what the agent saw and did.
 */
export class TranscriptRecorder {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  append(entry: TranscriptEntry): void {
    this.chain = this.chain
      .then(async () => {
        const file = path.join(this.dir, `${sanitizeSessionId(entry.sessionId)}.log`);
        const header = `\n===== ${entry.ts} · ${entry.source} · ${entry.tool}${
          entry.exitCode !== undefined && entry.exitCode !== null ? ` · exit ${entry.exitCode}` : ''
        } =====\n`;
        const body = entry.text && entry.text.length > 0 ? `${entry.text}\n` : '(no output)\n';
        await fsp.appendFile(file, header + body, { encoding: 'utf8' });
      })
      .catch((err) => {
        console.error('[transcripts] failed to append:', (err as Error).message);
      });
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  list(): Array<{ sessionId: string; file: string; bytes: number; modified: string }> {
    fs.mkdirSync(this.dir, { recursive: true });
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const full = path.join(this.dir, f);
        const stat = fs.statSync(full);
        return {
          sessionId: f.replace(/\.log$/, ''),
          file: full,
          bytes: stat.size,
          modified: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  }

  read(sessionId: string, tailLines?: number): string | null {
    const file = path.join(this.dir, `${sanitizeSessionId(sessionId)}.log`);
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8');
    if (!tailLines) return content;
    const lines = content.split('\n');
    return lines.slice(Math.max(0, lines.length - tailLines)).join('\n');
  }
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}
