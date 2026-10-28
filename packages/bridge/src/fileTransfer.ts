/**
 * File transfer over the terminal.
 *
 * There is no SFTP behind a bastion web terminal, so transfers ride the PTY
 * itself: base64 text through `send_command`, decoded locally (download) or
 * reassembled remotely (upload). The command builders are pure functions so
 * they are unit-testable without a terminal.
 *
 * Constraints that shape the design:
 * - Terminal canonical mode caps one input line at 4096 bytes → upload data
 *   lines stay at 2000 base64 chars.
 * - Uploaded chunks are batched into heredocs (~40 KB per command) to keep the
 *   number of round trips sane.
 * - Downloads capture only lines that are pure base64, which filters out the
 *   echoed command, prompt and sentinel noise.
 */

export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
export const CHUNK_LINE_CHARS = 2000;
export const LINES_PER_BATCH = 20;

export interface CommandResultLike {
  status: 'completed' | 'quiet' | 'timeout';
  exitCode: number | null;
  cursor: number;
  text: string;
  hasMore: boolean;
}

export interface ReadResultLike {
  text: string;
  nextCursor: number;
  hasMore: boolean;
}

export type SessionExec = (
  command: string,
  opts?: { waitMs?: number }
) => Promise<CommandResultLike>;

export type SessionRead = (cursor: number, maxChars: number) => Promise<ReadResultLike>;

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** Single-quote a string for POSIX shells ('' escapes a literal quote). */
export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A per-transfer nonce used for temp files and heredoc delimiters. */
export function newTransferNonce(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function buildSizeCommand(remotePath: string): string {
  return `wc -c < ${quoteShell(remotePath)}`;
}

export function buildDumpCommand(remotePath: string): string {
  return `base64 ${quoteShell(remotePath)}`;
}

export function buildExistsCommand(remotePath: string): string {
  return `test -e ${quoteShell(remotePath)}`;
}

export function buildUploadInit(nonce: string): string {
  return `rm -f ${quoteShell(uploadTempPath(nonce))}`;
}

export function uploadTempPath(nonce: string): string {
  return `/tmp/.bp_upload_${nonce}.b64`;
}

/**
 * Append a batch of base64 chunks through a heredoc. `chunks` are pure base64
 * strings (no newlines) — each becomes one line under the 4096-byte limit.
 */
export function buildUploadAppend(nonce: string, chunks: readonly string[]): string {
  if (chunks.length === 0) throw new Error('empty upload batch');
  for (const chunk of chunks) {
    if (!/^[A-Za-z0-9+/=]+$/.test(chunk)) {
      throw new Error('upload chunks must be pure base64');
    }
    if (chunk.length > CHUNK_LINE_CHARS) {
      throw new Error(`upload chunk too long: ${chunk.length} > ${CHUNK_LINE_CHARS}`);
    }
  }
  const delimiter = `BP_EOF_${nonce}`;
  return `cat >> ${quoteShell(uploadTempPath(nonce))} <<'${delimiter}'\n${chunks.join('\n')}\n${delimiter}`;
}

export function buildUploadFinish(nonce: string, remotePath: string): string {
  return (
    `base64 -d ${quoteShell(uploadTempPath(nonce))} > ${quoteShell(remotePath)} && ` +
    `rm -f ${quoteShell(uploadTempPath(nonce))}`
  );
}

/** Parse `wc -c` output (ignoring echo/prompt noise around it). */
export function extractSize(text: string): number | null {
  const matches = [...text.matchAll(/^\s*(\d+)\s*$/gm)].map((m) => Number.parseInt(m[1]!, 10));
  return matches.length > 0 ? matches[matches.length - 1]! : null;
}

/**
 * Extract the base64 payload from captured terminal output: keep only lines
 * that are entirely base64 characters (drops echoed commands, prompts, the
 * sentinel line and empty lines).
 */
export function extractBase64Payload(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => /^[A-Za-z0-9+/=]{4,}$/.test(line.trim()));
  return lines.join('');
}

export function encodeToBase64Chunks(data: Buffer): string[] {
  const full = data.toString('base64');
  const chunks: string[] = [];
  for (let i = 0; i < full.length; i += CHUNK_LINE_CHARS) {
    chunks.push(full.slice(i, i + CHUNK_LINE_CHARS));
  }
  return chunks.length > 0 ? chunks : [''];
}

/* ------------------------------------------------------------------ */
/* Executor                                                            */
/* ------------------------------------------------------------------ */

export class FileTransfer {
  constructor(
    private readonly exec: SessionExec,
    private readonly read: SessionRead
  ) {}

  /**
   * Download a remote file: size check → `base64 <file>` → collect output
   * (result text + follow-up reads) → decode. Returns the decoded bytes.
   */
  async download(remotePath: string): Promise<Buffer> {
    const sizeResult = await this.exec(buildSizeCommand(remotePath), { waitMs: 30_000 });
    const size = extractSize(sizeResult.text);
    if (size === null) {
      throw new Error(
        `could not stat ${quoteShell(remotePath)} (exit ${sizeResult.exitCode}) — does the file exist and is it readable?`
      );
    }
    if (size > MAX_TRANSFER_BYTES) {
      throw new Error(
        `file is ${size} bytes; transfers are capped at ${MAX_TRANSFER_BYTES} bytes over a terminal stream`
      );
    }

    const dump = await this.exec(buildDumpCommand(remotePath), {
      waitMs: 600_000,
    });
    if (dump.status !== 'completed') {
      throw new Error(`base64 dump did not complete (${dump.status}); transfer aborted`);
    }
    let captured = dump.text;
    let cursor = dump.cursor;
    while (dump.hasMore) {
      const next = await this.read(cursor, 100_000);
      captured += next.text;
      cursor = next.nextCursor;
      if (!next.hasMore) break;
    }
    const payload = extractBase64Payload(captured);
    const data = Buffer.from(payload, 'base64');
    if (data.length !== size) {
      throw new Error(
        `transfer incomplete: expected ${size} bytes, got ${data.length} (terminal dropped data; retry)`
      );
    }
    return data;
  }

  /**
   * Upload a file: exists check → heredoc batches of base64 → remote decode.
   */
  async upload(data: Buffer, remotePath: string, overwrite = false): Promise<number> {
    if (data.length > MAX_TRANSFER_BYTES) {
      throw new Error(
        `file is ${data.length} bytes; transfers are capped at ${MAX_TRANSFER_BYTES} bytes over a terminal stream`
      );
    }

    if (!overwrite) {
      const exists = await this.exec(buildExistsCommand(remotePath), { waitMs: 30_000 });
      if (exists.status === 'completed' && exists.exitCode === 0) {
        throw new Error(`${remotePath} already exists on the remote (use overwrite=true)`);
      }
    }

    const nonce = newTransferNonce();
    await this.exec(buildUploadInit(nonce), { waitMs: 30_000 });

    const chunks = encodeToBase64Chunks(data);
    for (let i = 0; i < chunks.length; i += LINES_PER_BATCH) {
      const batch = chunks.slice(i, i + LINES_PER_BATCH);
      const append = await this.exec(buildUploadAppend(nonce, batch), { waitMs: 120_000 });
      if (append.status === 'timeout') {
        throw new Error('remote terminal stopped accepting input during upload; aborted');
      }
    }

    const finish = await this.exec(buildUploadFinish(nonce, remotePath), {
      waitMs: 300_000,
    });
    if (finish.status !== 'completed' || finish.exitCode !== 0) {
      throw new Error(
        `remote decode failed (status ${finish.status}, exit ${finish.exitCode}); ` +
          `the temp file ${uploadTempPath(nonce)} may still be on the remote`
      );
    }
    return data.length;
  }
}
