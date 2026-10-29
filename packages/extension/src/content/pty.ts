/**
 * Heuristics that distinguish a PTY byte stream from unrelated binary
 * WebSocket traffic (analytics, protobuf heartbeats, ...). Terminal output is
 * overwhelmingly printable text, whitespace, ESC sequences and UTF-8.
 */
export function isPtyLikeBytes(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data);
  const n = Math.min(bytes.length, 2048);
  if (n === 0) return false;
  let good = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (
      (b >= 0x20 && b <= 0x7e) || // printable ASCII
      b === 0x0a ||
      b === 0x0d ||
      b === 0x09 ||
      b === 0x1b || // \n \r \t ESC
      b >= 0x80 // UTF-8 lead/continuation bytes (CJK output etc.)
    ) {
      good++;
    }
  }
  return good / n >= 0.9;
}
