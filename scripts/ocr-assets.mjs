/**
 * Stages the OCR runtime into `public/tesseract/`.
 *
 * Photo import runs Tesseract in the browser, which needs three things at
 * runtime: a worker script, a WebAssembly core, and a trained language model.
 * All three are large, and where they are served from is a design decision
 * rather than a detail.
 *
 * They are served from this app's own origin, for two reasons. The app is
 * offline-first — a recipe photographed in a kitchen with no signal should still
 * import — and reaching out to a CDN mid-task breaks that for the one feature
 * most likely to be used away from a desk. And it keeps the runtime free of
 * third-party requests, which is the same call made for link import.
 *
 * They are NOT committed. Roughly 20 MB of wasm has no business in a git history
 * when `node_modules` already contains all but one of the files, so this copies
 * what is already on disk and downloads only the language model — once, and
 * skipped entirely if it is already there.
 *
 *   npm run ocr-assets              # copy cores, download the model if missing
 *   npm run ocr-assets -- --offline # copy cores only, never touch the network
 *
 * Failure here is deliberately not fatal. A missing model leaves photo import
 * falling back to the Tesseract project's CDN on first use, which the app says
 * plainly on screen rather than doing quietly.
 */

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'tesseract');
const OFFLINE = process.argv.includes('--offline');

/**
 * The LSTM cores, one of which the browser picks at runtime by feature-detecting
 * SIMD support. All three are needed because the choice is the browser's, and a
 * missing variant is a hard failure on exactly the devices that would have used
 * the fastest one. The legacy non-LSTM cores are not copied — nothing here asks
 * for them.
 */
const CORES = [
  'tesseract-core-relaxedsimd-lstm.wasm',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm',
  'tesseract-core-lstm.wasm.js',
];

/**
 * The `_fast` model rather than the full one: 2 MB against 11 MB, for a small
 * accuracy cost on clean printed text, which is what a photographed cookbook
 * page or a screenshot is. The full model's advantage is on degraded scans and
 * handwriting, and neither is going to import cleanly anyway.
 */
const MODEL_URL = 'https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz';
const MODEL_FILE = 'eng.traineddata.gz';

async function main() {
  await mkdir(OUT, { recursive: true });

  const worker = join(ROOT, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
  const coreDir = join(ROOT, 'node_modules', 'tesseract.js-core');

  if (!existsSync(worker) || !existsSync(coreDir)) {
    console.warn('[ocr] tesseract.js is not installed — skipping. Run `npm install` first.');
    return;
  }

  await copyFile(worker, join(OUT, 'worker.min.js'));
  let copied = 1;
  for (const name of CORES) {
    const from = join(coreDir, name);
    if (!existsSync(from)) {
      console.warn(`[ocr] ${name} is missing from tesseract.js-core — skipping it.`);
      continue;
    }
    await copyFile(from, join(OUT, name));
    copied++;
  }

  const model = join(OUT, MODEL_FILE);
  if (existsSync(model)) {
    const { size } = await stat(model);
    console.log(`[ocr] ${copied} runtime files staged; language model already present (${mb(size)}).`);
    return;
  }

  if (OFFLINE) {
    console.log(`[ocr] ${copied} runtime files staged. No language model — photo import will ` +
      'fetch one from the Tesseract CDN on first use.');
    return;
  }

  try {
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(model, bytes);
    console.log(`[ocr] ${copied} runtime files staged; language model downloaded (${mb(bytes.byteLength)}).`);
  } catch (err) {
    // Not fatal, and not silent. The app degrades to fetching the model itself
    // and says so on screen, which is a worse experience than this script
    // succeeding but a far better one than photo import failing with no
    // explanation on a machine that happened to be offline at install time.
    console.warn(`[ocr] Could not download the language model (${err.message}).`);
    console.warn('[ocr] Photo import will fetch one from the Tesseract CDN on first use.');
    console.warn('[ocr] Re-run `npm run ocr-assets` when you are online to make it fully offline.');
  }
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

await main();
