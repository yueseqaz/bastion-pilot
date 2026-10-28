import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface AuditEntry {
  ts: string;
  kind: 'tool_call';
  source: string;
  tool: string;
  sessionId?: string;
  params: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
  exitCode?: number | null;
  outputChars?: number;
  outputFile?: string;
}

/**
 * Local JSONL audit log, one file per day under `<home>/audit/`.
 * Appends are serialized so concurrent tool calls cannot interleave lines.
 */
export class AuditLogger {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  append(entry: AuditEntry): void {
    this.chain = this.chain
      .then(async () => {
        const file = path.join(this.dir, `${entry.ts.slice(0, 10)}.jsonl`);
        await fsp.appendFile(file, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
      })
      .catch((err) => {
        console.error('[audit] failed to append:', (err as Error).message);
      });
  }

  /** Test/debug helper: wait until all queued appends hit disk. */
  async flush(): Promise<void> {
    await this.chain;
  }
}
