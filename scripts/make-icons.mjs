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
/** The one warm note: what is in the bowl, and what is in the cup. */
const APRICOT = [235, 158, 94];
const CLEAR = [0, 0, 0, 0];

/**
 * Averages a grid of samples per pixel, which is the whole of the anti-aliasing.
 *
 * Everything here is drawn by testing whether a point is inside a shape, and a
 * single test per pixel gives a hard edge — fine for a bar, ugly on the curve of
 * a cup at 48px, where the jaggies are a third of the width of the handle. Three
 * by three is enough to look drawn rather than computed, and costs nothing at
 * these sizes.
 */
function antialias(shape, samples = 3) {
  const step = 1 / (samples + 1);

  return (x, y) => {
    let r = 0, g = 0, b = 0, a = 0;

    for (let sy = 1; sy <= samples; sy++) {
      for (let sx = 1; sx <= samples; sx++) {
        const [sr, sg, sb, sa = 255] = shape(x + sx * step, y + sy * step);
        // Premultiplied, so a transparent sample contributes no colour rather
        // than dragging the average toward black.
        const alpha = sa / 255;
        r += sr * alpha;
        g += sg * alpha;
        b += sb * alpha;
        a += sa;
      }
    }

    const n = samples * samples;
    const alpha = a / n;
    if (alpha === 0) return CLEAR;
    const weight = a / 255;
    return [
      Math.round(r / weight), Math.round(g / weight), Math.round(b / weight),
      Math.round(alpha),
    ];
  };
}

/**
 * A bowl of something, and a cup of tea beside it.
 *
 * Drawn to survive 48px, which rules out most of what makes a picture charming.
 * What is left is silhouette: two objects of clearly different size, one round
 * and one with a handle, far enough apart that the gap between them reads as a
 * gap rather than as mush. The food and the tea are the only warm colour, which
 * is what stops the whole thing being a cream blob on a green square.
 *
 * `inset` shrinks the artwork without moving it. The maskable PWA variant and the
 * Android adaptive foreground are the same drawing at different insets, because
 * both are asking the same question — how much of this can be cropped away by a
 * launcher I know nothing about.
 */
/** A line with rounded ends, which is what stops a bar looking like a tab. */
function capsule(px, py, x0, x1, y, half) {
  const nearest = Math.min(Math.max(px, x0), x1);
  return Math.hypot(px - nearest, py - y) <= half;
}

function drawIcon(size, { inset = 0, background = GREEN } = {}) {
  const c = size / 2;
  const u = (size / 2) * (1 - inset);

  // The pair sits slightly low and slightly left of centre: the cup's handle
  // sticks out to the right, and balancing on the ink rather than the bounding
  // box is what keeps it from looking shunted.
  const bowlCx = c - u * 0.28;
  const bowlCy = c + u * 0.18;
  const bowlR = u * 0.46;
  const rimY = bowlCy - bowlR * 0.34;

  const cupCx = c + u * 0.52;
  const cupCy = c + u * 0.30;
  const cupR = u * 0.24;
  const teaY = cupCy - cupR * 0.62;

  /**
   * The cup's silhouette, optionally fattened.
   *
   * Asked twice per pixel: once at its true size to draw it, and once fattened
   * to carve a gap out of the bowl behind it. Without that gap the two shapes
   * are both cream and merely adjacent, so they fuse into one blob with a dent
   * in it — the single thing most likely to make this unreadable small.
   */
  const cupPart = (px, py, grow = 0) => {
    const handleD = Math.hypot(px - (cupCx + cupR * 0.86), py - (cupCy - cupR * 0.04));
    if (px > cupCx + cupR * 0.72
      && handleD <= cupR * 0.62 + grow && handleD >= cupR * 0.32 - grow) return 'cup';

    if (Math.hypot(px - cupCx, py - cupCy) <= cupR + grow && py >= teaY - grow) return 'cup';

    if (capsule(px, py, cupCx - cupR * 1.15, cupCx + cupR * 1.15,
      cupCy + cupR * 1.06, cupR * 0.15 + grow)) return 'cup';

    return null;
  };

  const solid = (colour) => [...colour, 255];

  return (px, py) => {
    // --- the cup of tea ---------------------------------------------------
    if (cupPart(px, py)) {
      // The tea itself: a band across the top, inset so a rim of cream shows
      // either side and the cup does not read as brim-full.
      if (Math.abs(py - teaY) <= cupR * 0.22 && Math.abs(px - cupCx) <= cupR * 0.84) {
        return solid(APRICOT);
      }
      return solid(CREAM);
    }
    // The gap that keeps the cup off the bowl.
    if (cupPart(px, py, u * 0.055)) return background ? solid(background) : CLEAR;

    // --- the bowl ---------------------------------------------------------
    if (Math.hypot(px - bowlCx, py - bowlCy) <= bowlR && py >= rimY) return solid(CREAM);
    // Rim: a capsule a little wider than the body, which is what makes it a bowl
    // rather than a circle with a flat top.
    if (capsule(px, py, bowlCx - bowlR * 1.02, bowlCx + bowlR * 1.02, rimY, bowlR * 0.15)) {
      return solid(CREAM);
    }
    // What is in it: a dome sitting on the rim, clipped to above the rim so it
    // rises out of the bowl instead of floating over it.
    if (py < rimY && Math.hypot(px - bowlCx, py - (rimY + bowlR * 0.10)) <= bowlR * 0.60) {
      return solid(APRICOT);
    }

    // --- steam ------------------------------------------------------------
    // Two strokes rather than three: three read as a fence at this size. Tall,
    // thin, and leaning through a single slow S — a fuller wave turns them into
    // quotation marks, which is exactly what the first attempt looked like.
    const steamTop = rimY - bowlR * 1.55;
    const steamBottom = rimY - bowlR * 0.55;
    if (py > steamTop && py < steamBottom) {
      const t = (py - steamTop) / (steamBottom - steamTop);
      const wave = Math.sin(t * Math.PI);
      // Fades out at both ends so the strokes taper instead of stopping dead.
      const taper = Math.min(1, Math.sin(t * Math.PI) * 2.2);
      for (const offset of [-0.34, 0.30]) {
        const cx = bowlCx + offset * bowlR + wave * bowlR * 0.16;
        if (Math.abs(px - cx) <= bowlR * 0.085 * taper) return solid(CREAM);
      }
    }

    return background ? solid(background) : CLEAR;
  };
}

/** Keeps the art inside a circle, for launchers that crop to one. */
function round(shape, size) {
  const c = size / 2;
  return (px, py) => (Math.hypot(px - c, py - c) <= c ? shape(px, py) : CLEAR);
}

const icon = (size, opts) => png(size, antialias(drawIcon(size, opts)));

mkdirSync('public', { recursive: true });

writeFileSync('public/icon-192.png', icon(192));
writeFileSync('public/icon-512.png', icon(512));
writeFileSync('public/icon-maskable-512.png', icon(512, { inset: 0.22 }));

/**
 * Android launcher icons.
 *
 * Three files per density, because Android has changed its mind twice and still
 * supports all three answers: a square for old launchers, a pre-cropped circle
 * for the ones that wanted circles, and — since API 26 — a transparent
 * foreground the launcher masks to whatever shape it likes over a flat colour
 * background, which is the one modern devices actually use.
 *
 * The foreground is drawn on a 108dp canvas of which only the middle 72dp is
 * guaranteed to survive cropping, so the art is inset to exactly that fraction.
 * Anything outside it is parallax margin, not picture.
 */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/**
 * How far the drawing actually reaches from the centre, as a fraction of `u`.
 *
 * Measured from the geometry above — the steam at the top and the cup's handle
 * at the right are the extremes. It matters because `inset` shrinks the drawing
 * space, not the drawing: insetting by the safe-zone fraction and stopping there
 * leaves the art at 75% of the safe zone rather than filling it, which on a
 * launcher that crops to a circle reads as a small picture adrift in a big
 * coloured disc.
 */
const ART_REACH = 0.75;

/** The inset that makes the art reach exactly `fraction` of the canvas radius. */
const insetForReach = (fraction) => 1 - fraction / ART_REACH;

// Adaptive icons guarantee only the middle 72 of 108dp survives cropping.
const SAFE_ZONE_INSET = insetForReach(72 / 108);

for (const [density, scale] of Object.entries(DENSITIES)) {
  const dir = `android/app/src/main/res/mipmap-${density}`;
  mkdirSync(dir, { recursive: true });

  const legacy = Math.round(48 * scale);
  const adaptive = Math.round(108 * scale);

  writeFileSync(`${dir}/ic_launcher.png`, icon(legacy));
  writeFileSync(
    `${dir}/ic_launcher_round.png`,
    png(legacy, antialias(round(drawIcon(legacy), legacy))),
  );
  writeFileSync(
    `${dir}/ic_launcher_foreground.png`,
    png(adaptive, antialias(drawIcon(adaptive, { inset: SAFE_ZONE_INSET, background: null }))),
  );
}

console.log('Wrote public/ icons and android/ mipmaps for 5 densities');
