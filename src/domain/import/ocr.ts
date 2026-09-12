/**
 * Text recognition for photo import.
 *
 * WHAT OCR CAN AND CANNOT DO, stated up front because it is easy to be
 * disappointed by: it reads printed text off a flat, well-lit page rather well,
 * and it reads a curved cookbook spine, a handwritten card or a photograph taken
 * at an angle rather badly. A few mangled lines per page is normal.
 *
 * That is survivable here only because of how the rest of the import works. A
 * line OCR wrecks fails to parse, and a line that fails to parse is REJECTED
 * with its text shown, rather than guessed at. So the failure mode of a bad
 * photograph is a review screen with three lines flagged for retyping — not a
 * recipe that silently entered the library with the wrong amount of flour.
 *
 * The engine is loaded on demand, never at startup. It is roughly 20 MB and
 * nobody ticking off a shopping list should pay for it.
 */

export type OcrStage = 'loading' | 'recognising';

export interface OcrProgress {
  readonly stage: OcrStage;
  /** 0..1 where the engine reports it, otherwise indeterminate. */
  readonly ratio: number;
  readonly message: string;
}

export interface OcrOutcome {
  readonly text: string;
  /**
   * Mean per-word confidence, 0..100.
   *
   * Surfaced rather than acted on. There is no threshold below which text is
   * worth discarding — the parser already rejects what it cannot read — but a
   * low number is the single best prompt to retake the photo, and only the
   * person holding the camera can act on that.
   */
  readonly confidence: number;
}

/** Where `ocr-assets` stages the runtime. Same origin, so it works offline. */
const LOCAL_BASE = '/tesseract';

let assetsChecked: Promise<boolean> | null = null;

/**
 * Whether the language model was staged locally.
 *
 * Checked once and remembered. If it is absent — someone installed while
 * offline, or skipped the postinstall — recognition still works by falling back
 * to the Tesseract project's CDN, and the UI says so rather than making a
 * network request the user did not expect and cannot see.
 */
export function hasLocalOcrAssets(): Promise<boolean> {
  assetsChecked ??= (async () => {
    try {
      const response = await fetch(`${LOCAL_BASE}/eng.traineddata.gz`, { method: 'HEAD' });
      // A dev server that answers every path with index.html would otherwise
      // report a 2 MB language model as present and then hand over HTML.
      const type = response.headers.get('content-type') ?? '';
      return response.ok && !type.includes('text/html');
    } catch {
      return false;
    }
  })();
  return assetsChecked;
}

/**
 * Reads the text out of an image.
 *
 * Returns the raw recognised text. Turning it into a recipe is
 * `parseRecipeText`'s job — keeping recognition and interpretation apart means
 * the fiddly, untestable half stays in this file and the half worth testing
 * stays in one that can run under `tsx`.
 */
export async function recogniseText(
  image: Blob,
  onProgress?: (progress: OcrProgress) => void,
): Promise<OcrOutcome> {
  const local = await hasLocalOcrAssets();

  onProgress?.({
    stage: 'loading',
    ratio: 0,
    message: local
      ? 'Starting the text reader…'
      : 'Downloading the text reader (about 2 MB, once)…',
  });

  // Dynamic so the engine is fetched the first time someone imports a photo and
  // never on an ordinary visit.
  const { createWorker } = await import('tesseract.js');

  const worker = await createWorker('eng', 1, {
    ...(local
      ? {
          workerPath: `${LOCAL_BASE}/worker.min.js`,
          corePath: LOCAL_BASE,
          langPath: LOCAL_BASE,
          gzip: true,
        }
      : {}),
    logger: (packet: { status?: string; progress?: number }) => {
      const status = packet.status ?? '';
      const ratio = typeof packet.progress === 'number' ? packet.progress : 0;
      if (status === 'recognizing text') {
        onProgress?.({ stage: 'recognising', ratio, message: 'Reading the photo…' });
      } else if (status !== '') {
        onProgress?.({ stage: 'loading', ratio, message: 'Starting the text reader…' });
      }
    },
  });

  try {
    const { data } = await worker.recognize(image);
    return { text: data.text ?? '', confidence: data.confidence ?? 0 };
  } finally {
    // Always terminated. The worker holds the whole wasm core in memory, which
    // is a lot to leave running on a phone between imports.
    await worker.terminate();
  }
}

/**
 * Tidies recognised text before parsing.
 *
 * Only the substitutions where OCR has a systematic, well-understood bias and
 * the correct reading is unambiguous. Anything requiring judgement is left alone
 * for a human: a wrong guess here would be invisible, since the line would then
 * parse cleanly and look correct.
 */
export function tidyOcrText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Common fraction manglings. "1/2" arriving as "V2" or "1⁄2" is the single
    // most frequent OCR error on a recipe page, and it is unambiguous.
    .replace(/(\d)\s*⁄\s*(\d)/g, '$1/$2')
    .replace(/\b([½⅓⅔¼¾⅛⅜⅝⅞])/g, ' $1')
    // Degree signs become a zero or an 'o' next to a temperature.
    .replace(/(\d{2,3})\s*[o°º]\s*([CF])\b/g, '$1°$2')
    // Bullet glyphs that the tag stripper and the line parser both understand.
    .replace(/^[°º*■□●○©®]\s+/gm, '• ')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
