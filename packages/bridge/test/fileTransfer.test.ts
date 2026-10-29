import { describe, expect, it } from 'vitest';
import {
  buildDumpCommand,
  buildExistsCommand,
  buildSizeCommand,
  buildUploadAppend,
  buildUploadFinish,
  buildUploadInit,
  encodeToBase64Chunks,
  extractBase64Payload,
  extractSize,
  FileTransfer,
  quoteShell,
  uploadTempPath,
  type CommandResultLike,
} from '../src/fileTransfer.js';

describe('command builders', () => {
  it('single-quotes remote paths safely', () => {
    expect(quoteShell('/etc/hosts')).toBe("'/etc/hosts'");
    expect(quoteShell("it's here")).toBe(`'it'\\''s here'`);
    expect(buildSizeCommand('/a b/file.txt')).toBe(`wc -c < '/a b/file.txt'`);
    expect(buildDumpCommand('/x')).toBe(`base64 '/x'`);
    expect(buildExistsCommand('/x')).toBe(`test -e '/x'`);
  });

  it('builds heredoc appends that respect the terminal line limit', () => {
    const chunks = ['QUJD'.repeat(500), 'REVGOo=' + 'A'.repeat(1993)];
    const cmd = buildUploadAppend('n1', chunks);
    const lines = cmd.split('\n');
    expect(lines[0]).toBe(`cat >> '/tmp/.bp_upload_n1.b64' <<'BP_EOF_n1'`);
    expect(lines[1]).toBe(chunks[0]);
    expect(lines[2]).toBe(chunks[1]);
    expect(lines[3]).toBe('BP_EOF_n1');
    for (const line of lines) expect(line.length).toBeLessThan(4096);
  });

  it('rejects non-base64 or oversized upload chunks', () => {
    expect(() => buildUploadAppend('n1', ['not base64!'])).toThrow(/pure base64/);
    expect(() => buildUploadAppend('n1', ['x'.repeat(3000)])).toThrow(/too long/);
    expect(() => buildUploadAppend('n1', [])).toThrow(/empty/);
  });

  it('builds init and finish commands around the temp file', () => {
    expect(buildUploadInit('n2')).toBe(`rm -f '/tmp/.bp_upload_n2.b64'`);
    const finish = buildUploadFinish('n2', '/data/out.bin');
    expect(finish).toBe(
      `base64 -d '/tmp/.bp_upload_n2.b64' > '/data/out.bin' && rm -f '/tmp/.bp_upload_n2.b64'`
    );
    expect(uploadTempPath('n2')).toBe('/tmp/.bp_upload_n2.b64');
  });

  it('splits data into 2000-char base64 lines', () => {
    const chunks = encodeToBase64Chunks(Buffer.from('x'.repeat(5000)));
    const joined = chunks.join('');
    expect(Buffer.from(joined, 'base64').length).toBe(5000);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
  });
});

describe('output parsing', () => {
  it('extracts the size from wc -c output with echo noise', () => {
    const text = ["wc -c < '/var/log/x'", '4096', '__BP_ab12cd34_0__', 'prompt$ '].join('\n');
    expect(extractSize(text)).toBe(4096);
  });

  it('returns null when no size line exists', () => {
    expect(extractSize('no size here\nprompt$ ')).toBeNull();
  });

  it('filters base64 payload from echoed commands, prompts and sentinels', () => {
    const b64 = Buffer.from('hello transfer').toString('base64'); // aGVsbG8gdHJhbnNmZXI=
    const wrapped = b64.match(/.{1,8}/g)!.join('\n');
    const text = [
      "base64 '/data/file.bin'",
      wrapped,
      '__BP_ab12cd34_0__',
      '[user@web-01 ~]$ ',
    ].join('\n');
    expect(extractBase64Payload(text)).toBe(b64);
  });

  it('keeps a single long base64 line unwrapped', () => {
    const oneLine = 'QUJD'.repeat(1000);
    const text = ["base64 '/x'", oneLine, '__BP_ab12cd34_0__'].join('\n');
    expect(extractBase64Payload(text)).toBe(oneLine);
  });
});

describe('FileTransfer executor', () => {
  function fakeExec(responses: Array<Partial<CommandResultLike>>) {
    const issued: string[] = [];
    const exec = async (command: string): Promise<CommandResultLike> => {
      issued.push(command);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected command: ${command}`);
      return {
        status: 'completed',
        exitCode: 0,
        cursor: 100,
        text: '',
        hasMore: false,
        ...next,
      };
    };
    return { issued, exec };
  }

  it('downloads and decodes a file end to end', async () => {
    const content = Buffer.from('binary-\x00-\xff-content'.repeat(10));
    const b64 = content.toString('base64');
    const { exec } = fakeExec([
      { text: "wc -c < '/f'\n123456\n__BP_a_0__\n" }, // 123456? must equal content length
      {
        text: `base64 '/f'\n${b64}\n__BP_a_0__\n`,
        cursor: 500,
        hasMore: false,
      },
    ]);
    // Fix the size line to the actual byte count.
    const size = content.length;
    const { exec: exec2 } = fakeExec([
      { text: `wc -c < '/f'\n${size}\n__BP_a_0__\n` },
      { text: `base64 '/f'\n${b64}\n__BP_a_0__\n` },
    ]);
    void exec;
    const ft = new FileTransfer(exec2, async () => {
      throw new Error('should not need follow-up reads');
    });
    const data = await ft.download('/f');
    expect(data.equals(content)).toBe(true);
  });

  it('follows read_output cursors for large dumps', async () => {
    const content = Buffer.alloc(200_000, 7);
    const b64 = content.toString('base64'); // ~267k chars → exceeds one read
    let readCalls = 0;
    const ft = new FileTransfer(
      async (command) => {
        if (command.startsWith('wc')) {
          return {
            status: 'completed',
            exitCode: 0,
            cursor: 10,
            text: `wc -c\n${content.length}\n__BP_a_0__\n`,
            hasMore: false,
          };
        }
        // base64 dump: first result already exhausted; the follow-up read
        // carries the whole payload.
        return { status: 'completed', exitCode: 0, cursor: 100, text: '', hasMore: true };
      },
      async (cursor, maxChars) => {
        readCalls++;
        expect(cursor).toBe(100);
        expect(maxChars).toBe(100_000);
        return { text: b64, nextCursor: 999, hasMore: false };
      }
    );
    expect(readCalls).toBe(0);
    const data = await ft.download('/big');
    expect(readCalls).toBe(1);
    expect(data.equals(content)).toBe(true);
  });

  it('refuses oversized remote files', async () => {
    const ft = new FileTransfer(
      async () => ({
        status: 'completed',
        exitCode: 0,
        cursor: 1,
        text: `\n${64 * 1024 * 1024 + 1}\n__BP_a_0__\n`,
        hasMore: false,
      }),
      async () => {
        throw new Error('unreachable');
      }
    );
    await expect(ft.download('/huge')).rejects.toThrow(/capped/);
  });

  it('refuses to overwrite existing remote files by default', async () => {
    const ft = new FileTransfer(
      async () => ({
        status: 'completed',
        exitCode: 0,
        cursor: 1,
        text: '',
        hasMore: false,
      }),
      async () => {
        throw new Error('unreachable');
      }
    );
    await expect(ft.upload(Buffer.from('x'), '/etc/hosts', false)).rejects.toThrow(
      /already exists/
    );
  });

  it('uploads through init → heredoc batches → decode', async () => {
    const content = Buffer.alloc(60_000, 3);
    const issued: string[] = [];
    const ft = new FileTransfer(
      async (command) => {
        issued.push(command);
        return { status: 'completed', exitCode: 0, cursor: 1, text: '', hasMore: false };
      },
      async () => {
        throw new Error('unreachable');
      }
    );
    const bytes = await ft.upload(content, '/tmp/out.bin', true);
    expect(bytes).toBe(content.length);
    expect(issued[0]).toMatch(/^rm -f '\/tmp\/\.bp_upload_/); // overwrite=true: no exists check
    expect(issued.filter((c) => c.startsWith('rm -f'))).toHaveLength(1);
    const appends = issued.filter((c) => c.includes('<<'));
    expect(appends.length).toBe(2);
    const appended = appends.map((c) => c.split('\n').slice(1, -1).join('')).join('');
    expect(Buffer.from(appended, 'base64').equals(content)).toBe(true);
    expect(issued[issued.length - 1]).toContain(`base64 -d`);
  });

  it('aborts when a batch times out mid-upload', async () => {
    const ft = new FileTransfer(
      async (command) => {
        if (command.includes('<<')) {
          return { status: 'timeout', exitCode: null, cursor: 1, text: '', hasMore: false };
        }
        return { status: 'completed', exitCode: 0, cursor: 1, text: '', hasMore: false };
      },
      async () => {
        throw new Error('unreachable');
      }
    );
    await expect(ft.upload(Buffer.alloc(50_000, 1), '/out', true)).rejects.toThrow(
      /stopped accepting input/
    );
  });

  it('aborts the upload when the terminal is busy (unverifiable exists probe)', async () => {
    const ft = new FileTransfer(
      async () => ({ status: 'quiet', exitCode: null, cursor: 1, text: '', hasMore: false }),
      async () => {
        throw new Error('unreachable');
      }
    );
    await expect(ft.upload(Buffer.from('x'), '/etc/hosts', false)).rejects.toThrow(
      /terminal is busy/
    );
  });

  it('aborts when the init command cannot be confirmed', async () => {
    let calls = 0;
    const ft = new FileTransfer(
      async () => {
        calls++;
        // overwrite=true skips the exists probe; init fails to confirm.
        return {
          status: calls === 1 ? 'quiet' : 'completed',
          exitCode: 0,
          cursor: 1,
          text: '',
          hasMore: false,
        };
      },
      async () => {
        throw new Error('unreachable');
      }
    );
    await expect(ft.upload(Buffer.from('x'), '/out', true)).rejects.toThrow(
      /temp file could not be cleared/
    );
  });

  it('aborts when a remote append fails with a non-zero exit', async () => {
    const ft = new FileTransfer(
      async (command) => {
        if (command.includes('<<')) {
          return { status: 'completed', exitCode: 1, cursor: 1, text: '', hasMore: false };
        }
        return { status: 'completed', exitCode: 0, cursor: 1, text: '', hasMore: false };
      },
      async () => {
        throw new Error('unreachable');
      }
    );
    await expect(ft.upload(Buffer.alloc(50_000, 1), '/out', true)).rejects.toThrow(
      /remote append failed/
    );
  });

  it('aborts the download when the size probe cannot complete', async () => {
    const ft = new FileTransfer(
      async () => ({ status: 'quiet', exitCode: null, cursor: 1, text: '', hasMore: false }),
      async () => {
        throw new Error('unreachable');
      }
    );
    await expect(ft.download('/f')).rejects.toThrow(/terminal is busy/);
  });
});
