/**
 * Generates the extension icons (a terminal prompt glyph on a rounded tile)
 * without any image dependency: hand-rolled PNG encoder + shape rasterizer.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'extension',
  'static',
  'icons'
);
fs.mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return Math.hypot(dx, dy);
}

const BG = [15, 23, 42, 255]; // slate-900
const BG_OUT = [0, 0, 0, 0];
const FG = [248, 250, 252, 255]; // slate-50

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.24;
  const thickness = Math.max(1.5, size * 0.085);
  const p = (fx, fy) => [fx * size, fy * size];
  const [ax, ay] = p(0.3, 0.28);
  const [bx, by] = p(0.5, 0.5);
  const [cx, cy] = p(0.3, 0.72);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // rounded-rect membership
      const rx = Math.max(radius - px, px - (size - radius), 0);
      const ry = Math.max(radius - py, py - (size - radius), 0);
      const inside = Math.hypot(rx, ry) <= radius;
      let color = inside ? BG : BG_OUT;

      if (inside) {
        const d1 = distToSegment(px, py, ax, ay, bx, by);
        const d2 = distToSegment(px, py, bx, by, cx, cy);
        const isChevron = Math.min(d1, d2) <= thickness / 2;
        const inUnderscore =
          px >= 0.56 * size && px <= 0.78 * size && py >= 0.655 * size && py <= 0.745 * size;
        if (isChevron || inUnderscore) color = FG;
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = color[0];
      rgba[idx + 1] = color[1];
      rgba[idx + 2] = color[2];
      rgba[idx + 3] = color[3];
    }
  }
  return encodePng(size, size, rgba);
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, drawIcon(size));
  console.log('wrote', file);
}
