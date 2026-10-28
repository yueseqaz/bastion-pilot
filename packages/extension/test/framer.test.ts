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
