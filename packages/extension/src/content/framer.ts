import type { FramerConfig } from '../profiles.js';

export interface Framer {
  /** Decode a downstream WebSocket frame into raw PTY bytes. */
  decodeDown(data: string | ArrayBuffer): Uint8Array;
  /** Encode text to be typed into the terminal as an upstream frame. */
  encodeUp(text: string): string | ArrayBuffer;
}

const encoder = new TextEncoder();

export function createFramer(cfg: FramerConfig): Framer {
  switch (cfg.type) {
    case 'raw':
      return {
        decodeDown: (data) =>
          typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data),
        encodeUp: (text) => encoder.encode(text).buffer,
      };
    case 'base64':
      return {
        decodeDown: (data) => {
          if (data instanceof ArrayBuffer) return new Uint8Array(data);
          return base64ToBytes(data);
        },
        encodeUp: (text) => bytesToBase64(encoder.encode(text)),
      };
    case 'json': {
      const field = cfg.dataField ?? 'data';
      const useB64 = cfg.encoding === 'base64';
      return {
        decodeDown: (data) => {
          if (data instanceof ArrayBuffer) return new Uint8Array(data);
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return encoder.encode(data); // not JSON: treat as raw text
          }
          if (parsed === null || typeof parsed !== 'object') return new Uint8Array();
          const payload = (parsed as Record<string, unknown>)[field];
          if (typeof payload === 'string') {
            return useB64 ? base64ToBytes(payload) : encoder.encode(payload);
          }
          return new Uint8Array();
        },
        encodeUp: (text) => JSON.stringify(cfg.inputField ? { [cfg.inputField]: text } : text),
      };
    }
    case 'guacamole':
      return createGuacamoleFramer(cfg);
  }
}

/**
 * Guacamole-style instruction framing.
 *
 * Wire format: `<len>.<opcode>,<len>.<arg>,...;` — an instruction may be split
 * across WebSocket frames, so we keep a carry buffer. Terminal output travels
 * in the `tes` opcode as a base64 string; input is sent the same way.
 *
 * This is what Anheng Mingyu V2.0 (mingyu V2.0) bastion uses for its SSH web terminal:
 * xterm.js on the front-end, but a Guacamole instruction stream on the wire.
 */
function createGuacamoleFramer(cfg: FramerConfig): Framer {
  let pending = '';
  const frameDecoder = new TextDecoder();
  const configured = cfg.textEncoding ?? 'auto';

  let mode: 'utf-8' | 'gb18030' | 'unknown' =
    configured === 'utf-8' ? 'utf-8' : configured === 'gb18030' ? 'gb18030' : 'unknown';
  let gbDecoder: TextDecoder | null = null;
  const utf8Probe = new TextDecoder('utf-8', { fatal: true });

  const toUtf8Bytes = (bytes: Uint8Array): Uint8Array => {
    if (mode === 'unknown') {
      if (!bytes.some((byte) => byte >= 0x80)) return bytes; // pure ASCII: either encoding
      try {
        // streaming probe: incomplete trailing sequences are buffered, only
        // definitely-invalid bytes throw
        utf8Probe.decode(bytes, { stream: true });
        mode = 'utf-8';
        return bytes;
      } catch {
        mode = 'gb18030';
      }
    }
    if (mode === 'utf-8') return bytes;
    gbDecoder ??= new TextDecoder('gb18030');
    const text = gbDecoder.decode(bytes, { stream: true });
    return text ? encoder.encode(text) : new Uint8Array();
  };

  return {
    decodeDown: (data) => {
      pending += typeof data === 'string' ? data : frameDecoder.decode(data);
      if (pending.length > 2_000_000) pending = pending.slice(-100_000); // never grow unbounded
      const drained = scanGuacamole(pending);
      pending = drained.rest;
      if (drained.tes.length === 0) return new Uint8Array();
      const parts: Uint8Array[] = [];
      for (const payload of drained.tes) {
        try {
          parts.push(toUtf8Bytes(base64ToBytes(payload)));
        } catch {
          /* malformed base64: skip this payload */
        }
      }
      return concatBytes(parts);
    },
    encodeUp: (text) => {
      const payload = cfg.enterAsCr ? text.replace(/\r?\n/g, '\r') : text;
      return guacInstruction('tes', bytesToBase64(encoder.encode(payload)));
    },
  };
}

interface GuacInstruction {
  opcode: string;
  args: string[];
}

type GuacRead =
  | { kind: 'ok'; instruction: GuacInstruction; next: number }
  | { kind: 'incomplete' }
  | { kind: 'malformed'; next: number };

/** Pull every complete instruction out of the carry buffer. */
function scanGuacamole(input: string): { tes: string[]; rest: string } {
  const tes: string[] = [];
  let i = 0;
  while (i < input.length) {
    const read = readGuacInstruction(input, i);
    if (read.kind === 'incomplete') break;
    if (read.kind === 'malformed') {
      i = Math.max(read.next, i + 1);
      continue;
    }
    if (read.instruction.opcode === 'tes') {
      const payload = read.instruction.args[0];
      if (payload) tes.push(payload);
    }
    i = read.next;
  }
  return { tes, rest: input.slice(i) };
}

function readGuacInstruction(input: string, start: number): GuacRead {
  const elements: string[] = [];
  let i = start;
  for (;;) {
    let dot = -1;
    for (let j = i; j < input.length && j < i + 12; j++) {
      const code = input.charCodeAt(j);
      if (code === 46) {
        dot = j; // '.'
        break;
      }
      if (code < 48 || code > 57) return { kind: 'malformed', next: j + 1 };
    }
    if (dot === -1) return { kind: 'incomplete' };

    const length = Number(input.slice(i, dot));
    if (!Number.isSafeInteger(length) || length < 0 || length > 10_000_000) {
      return { kind: 'malformed', next: dot + 1 };
    }
    const valueStart = dot + 1;
    if (valueStart + length > input.length) return { kind: 'incomplete' };
    elements.push(input.slice(valueStart, valueStart + length));
    i = valueStart + length;
    if (i >= input.length) return { kind: 'incomplete' };

    const separator = input[i];
    if (separator === ',') {
      i += 1;
      continue;
    }
    if (separator === ';') {
      i += 1;
      break;
    }
    return { kind: 'malformed', next: i + 1 };
  }
  const [opcode = '', ...args] = elements;
  return { kind: 'ok', instruction: { opcode, args }, next: i };
}

function guacInstruction(opcode: string, ...args: string[]): string {
  return [opcode, ...args].map((value) => `${value.length}.${value}`).join(',') + ';';
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}
