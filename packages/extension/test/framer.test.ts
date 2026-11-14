import { describe, expect, it } from 'vitest';
import { createFramer } from '../src/content/framer.js';

const encoder = new TextEncoder();

describe('framer: raw', () => {
  const framer = createFramer({ type: 'raw' });

  it('decodes strings and buffers to PTY bytes', () => {
    expect(new TextDecoder().decode(framer.decodeDown('ls\n'))).toBe('ls\n');
    expect(new TextDecoder().decode(framer.decodeDown(encoder.encode('abc').buffer))).toBe('abc');
  });

  it('encodes input as ArrayBuffer bytes', () => {
    const out = framer.encodeUp('echo hi\r');
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(out as ArrayBuffer)).toBe('echo hi\r');
  });
});

describe('framer: json', () => {
  it('extracts the configured data field (plain)', () => {
    const framer = createFramer({ type: 'json', dataField: 'data', encoding: 'plain' });
    const decoded = new TextDecoder().decode(
      framer.decodeDown(JSON.stringify({ type: 'output', data: 'hello\n' }))
    );
    expect(decoded).toBe('hello\n');
  });

  it('extracts the configured data field (base64)', () => {
    const framer = createFramer({ type: 'json', dataField: 'data', encoding: 'base64' });
    const b64 = btoa('pty-bytes');
    const decoded = new TextDecoder().decode(framer.decodeDown(JSON.stringify({ data: b64 })));
    expect(decoded).toBe('pty-bytes');
  });

  it('falls back to raw text for non-JSON frames', () => {
    const framer = createFramer({ type: 'json', dataField: 'data' });
    expect(new TextDecoder().decode(framer.decodeDown('plain'))).toBe('plain');
  });

  it('wraps input into the configured input field', () => {
    const framer = createFramer({ type: 'json', dataField: 'data', inputField: 'input' });
    expect(framer.encodeUp('ls')).toBe(JSON.stringify({ input: 'ls' }));
  });
});

describe('framer: base64', () => {
  it('decodes base64 payloads', () => {
    const framer = createFramer({ type: 'base64' });
    expect(new TextDecoder().decode(framer.decodeDown(btoa('payload')))).toBe('payload');
  });

  it('round-trips input through base64', () => {
    const framer = createFramer({ type: 'base64' });
    const encoded = framer.encodeUp('round-trip') as string;
    expect(new TextDecoder().decode(framer.decodeDown(encoded))).toBe('round-trip');
  });
});

describe('framer: guacamole', () => {
  const tes = (text: string): string => {
    const b64 = btoa(text);
    return `3.tes,${b64.length}.${b64};`;
  };

  it('extracts tes payloads and ignores other instructions', () => {
    const framer = createFramer({ type: 'guacamole' });
    const frame = `5.ready,1.0;${tes('hello\n')}3.ack,1.0;`;
    expect(new TextDecoder().decode(framer.decodeDown(frame))).toBe('hello\n');
  });

  it('reassembles an instruction split across WebSocket frames', () => {
    const framer = createFramer({ type: 'guacamole' });
    const whole = tes('split-output');
    const cut = 7;
    expect(new TextDecoder().decode(framer.decodeDown(whole.slice(0, cut)))).toBe('');
    expect(new TextDecoder().decode(framer.decodeDown(whole.slice(cut)))).toBe('split-output');
  });

  it('handles several tes instructions in one frame', () => {
    const framer = createFramer({ type: 'guacamole' });
    expect(new TextDecoder().decode(framer.decodeDown(tes('a') + tes('b')))).toBe('ab');
  });

  it('encodes input as a single tes instruction', () => {
    const framer = createFramer({ type: 'guacamole' });
    const out = framer.encodeUp('ls\r') as string;
    const match = /^3\.tes,(\d+)\.([A-Za-z0-9+/=]+);$/.exec(out);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(match![2]!.length);
    expect(atob(match![2]!)).toBe('ls\r');
  });

  it('translates LF to CR when enterAsCr is set', () => {
    const framer = createFramer({ type: 'guacamole', enterAsCr: true });
    const out = framer.encodeUp('ls\n') as string;
    const match = /^3\.tes,(\d+)\.([A-Za-z0-9+/=]+);$/.exec(out);
    expect(match).not.toBeNull();
    expect(atob(match![2]!)).toBe('ls\r');
  });

  it('decodes GB18030 payloads when configured', () => {
    const framer = createFramer({ type: 'guacamole', textEncoding: 'gb18030' });
    // D6 D0 CE C4 is "中文" in GB18030
    const b64 = btoa(String.fromCharCode(0xd6, 0xd0, 0xce, 0xc4));
    const frame = `3.tes,${b64.length}.${b64};`;
    expect(new TextDecoder().decode(framer.decodeDown(frame))).toBe('中文');
  });

  it('auto-detects GB18030 when UTF-8 validation fails', () => {
    const framer = createFramer({ type: 'guacamole', textEncoding: 'auto' });
    const b64 = btoa(String.fromCharCode(0xd6, 0xd0, 0xce, 0xc4));
    const frame = `3.tes,${b64.length}.${b64};`;
    expect(new TextDecoder().decode(framer.decodeDown(frame))).toBe('中文');
  });

  it('keeps UTF-8 intact in auto mode', () => {
    const framer = createFramer({ type: 'guacamole', textEncoding: 'auto' });
    const b64 = btoa(String.fromCharCode(0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87));
    const frame = `3.tes,${b64.length}.${b64};`;
    expect(new TextDecoder().decode(framer.decodeDown(frame))).toBe('中文');
  });
});
