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
  }
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
