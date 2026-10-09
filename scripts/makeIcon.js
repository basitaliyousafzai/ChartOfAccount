'use strict';

/**
 * Generate the application icon, no image tooling required.
 *
 *     node scripts/makeIcon.js   ->   build/icon.ico  (256x256, 32-bit PNG)
 *
 * A hand-rolled PNG (zlib is built into Node) wrapped in an ICO container.
 * Everything is drawn with a signed-distance rounded-rectangle, which gives
 * free anti-aliasing: alpha = clamp(0.5 - sdf, 0, 1).
 *
 * Motif: two ledger columns (green debit / blue credit) standing on the total
 * rule beneath them — the shape of a balanced Trial Balance.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const OUT_DIR = path.join(__dirname, '..', 'build');

/* ------------------------------------------------------------- PNG ----- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // Filter byte 0 (None) prepended to every scanline.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + stride)] = 0;
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------- primitives --- */

/** Signed distance to a rounded rectangle; negative inside. */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - radius;
}

function mix(a, b, t) { return a + (b - a) * t; }

/** Composite `src` (premultiplied-ish RGBA + coverage) over the buffer. */
function paint(buf, x, y, r, g, b, a) {
  if (a <= 0) return;
  const i = (y * SIZE + x) * 4;
  const inv = 1 - a;
  buf[i] = Math.round(r * a + buf[i] * inv);
  buf[i + 1] = Math.round(g * a + buf[i + 1] * inv);
  buf[i + 2] = Math.round(b * a + buf[i + 2] * inv);
  buf[i + 3] = Math.min(255, Math.round(255 * a + buf[i + 3] * inv));
}

function draw() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);

  // Background plate: dark rounded square with a soft top-to-bottom gradient,
  // matching the shell's own '#0f1117' window background.
  const bgTop = [0x1b, 0x22, 0x30];
  const bgBottom = [0x0f, 0x11, 0x17];

  // Foreground: two ledger columns standing on the total rule.
  const green = [0x3d, 0xdc, 0x97];
  const blue = [0x5a, 0xa9, 0xff];
  const rule = [0xff, 0xc1, 0x4d];

  const shapes = [
    // cx, cy, halfW, halfH, radius, colour
    { cx: 92, cy: 140, hw: 24, hh: 62, r: 12, c: green },   // debit column
    { cx: 164, cy: 116, hw: 24, hh: 86, r: 12, c: blue },   // credit column
    { cx: 128, cy: 216, hw: 74, hh: 11, r: 8, c: rule },    // total rule
  ];

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      // Centre of each pixel, so edges land on half-integers and anti-alias.
      const px = x + 0.5;
      const py = y + 0.5;

      const bg = roundedRectSdf(px, py, 128, 128, 112, 112, 52);
      const bgA = Math.min(1, Math.max(0, 0.5 - bg));
      if (bgA <= 0) continue;

      const t = y / (SIZE - 1);
      paint(buf, x, y,
        mix(bgTop[0], bgBottom[0], t),
        mix(bgTop[1], bgBottom[1], t),
        mix(bgTop[2], bgBottom[2], t),
        bgA);

      for (const s of shapes) {
        const d = roundedRectSdf(px, py, s.cx, s.cy, s.hw, s.hh, s.r);
        const a = Math.min(1, Math.max(0, 0.5 - d));
        if (a <= 0) continue;
        // Tiny inner shading so the columns read as solid, not flat stickers.
        const shade = 0.92 + 0.08 * (1 - Math.min(1, Math.max(0, (py - (s.cy - s.hh)) / (2 * s.hh))));
        paint(buf, x, y, s.c[0] * shade, s.c[1] * shade, s.c[2] * shade, a * bgA);
      }
    }
  }

  return buf;
}

/* -------------------------------------------------------------- ICO ---- */

function encodeIco(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);       // reserved
  header.writeUInt16LE(1, 2);       // type: icon
  header.writeUInt16LE(1, 4);       // one image

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 0 means 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;                     // palette colours
  entry[3] = 0;                     // reserved
  entry.writeUInt16LE(1, 4);        // colour planes
  entry.writeUInt16LE(32, 6);       // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, pngBuf]);
}

/* ------------------------------------------------------------ build ---- */

fs.mkdirSync(OUT_DIR, { recursive: true });

const png = encodePng(SIZE, SIZE, draw());
const ico = encodeIco(png, SIZE);

fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

// Sanity: the ICO must be parseable before electron-builder is handed it.
if (ico.readUInt16LE(4) !== 1) throw new Error('ICO image count is wrong');
if (ico.readUInt32LE(14) !== png.length) throw new Error('ICO entry length mismatch');

console.log(`ICON OK  ${path.join(OUT_DIR, 'icon.ico')}  ${(ico.length / 1024).toFixed(1)} KB`);
