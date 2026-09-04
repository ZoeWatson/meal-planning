/**
 * Generates the PWA icons as real PNGs.
 *
 * Written by hand rather than pulled from an image library because the only thing
 * needed is a couple of flat-colour bitmaps, and a dependency that exists solely
 * to draw two circles is a dependency that will need updating forever.
 *
 * Run with: npm run icons
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @param {(x: number, y: number) => [number, number, number, number]} pixel */
function png(size, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with a filter byte; 0 means "no filter".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GREEN = [31, 111, 74];
const CREAM = [250, 249, 247];

/**
 * A bowl: a filled circle with a bite taken out of the top, which reads clearly
 * at 48px on a home screen where anything more detailed turns to mush.
 *
 * `inset` shrinks the artwork for the maskable variant, whose outer ~10% can be
 * cropped to whatever shape the launcher prefers.
 */
function drawIcon(size, { inset = 0, background = GREEN, foreground = CREAM } = {}) {
  const c = size / 2;
  const usable = (size / 2) * (1 - inset);
  const bowlR = usable * 0.62;
  const rimY = c - bowlR * 0.28;

  return (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    const d = Math.hypot(px - c, py - c);

    // Bowl body: lower two-thirds of a circle.
    const inBowl = d <= bowlR && py >= rimY;
    // Rim: a bar across the top of the bowl, slightly wider than the body.
    const inRim = Math.abs(py - rimY) <= bowlR * 0.11 && Math.abs(px - c) <= bowlR * 1.12;
    // Steam: three short vertical strokes above the rim.
    const steamY = py > rimY - bowlR * 0.72 && py < rimY - bowlR * 0.2;
    const inSteam = steamY && [-0.42, 0, 0.42].some(
      (o) => Math.abs(px - (c + o * bowlR)) <= bowlR * 0.08,
    );

    if (inBowl || inRim || inSteam) return [...foreground, 255];
    return [...background, 255];
  };
}

mkdirSync('public', { recursive: true });

writeFileSync('public/icon-192.png', png(192, drawIcon(192)));
writeFileSync('public/icon-512.png', png(512, drawIcon(512)));
writeFileSync('public/icon-maskable-512.png', png(512, drawIcon(512, { inset: 0.22 })));

console.log('Wrote public/icon-192.png, icon-512.png, icon-maskable-512.png');
