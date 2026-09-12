/**
 * Reads a recipe out of a saved web page.
 *
 * Almost every recipe site on the internet already publishes its recipes as
 * schema.org JSON-LD, because Google requires it for rich results. That is a
 * enormous stroke of luck: the ingredient list, the yield and the times are
 * available as *data*, exactly as the author entered them, rather than as text to
 * be guessed at. Reading it is both the least work and by far the most accurate
 * route, so it is tried first and the prose parser is only ever the fallback.
 *
 * Three tiers, best first:
 *
 *   1. JSON-LD   — structured, authored, unambiguous.
 *   2. Microdata — the older markup, still common on long-running blogs.
 *   3. Page text — strip the tags and hand the remains to `parseRecipeText`.
 *
 * Which tier produced a draft is recorded on it, because the user is entitled to
 * know whether they are looking at data the author published or a guess made
 * from a wall of text.
 *
 * Everything here is regex-based rather than DOM-based, deliberately: it runs
 * identically in the browser and under `tsx` in the test suite, and a recipe page
 * saved from the wild is malformed often enough that a strict parser is a
 * liability anyway.
 */

import {
  type RecipeDraft,
  guessMealType, parseDuration, parseServings,
} from './draft';
import { parseRecipeText } from './parseRecipeText';

// ---------------------------------------------------------------------------
// HTML plumbing
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  frac12: '½', frac13: '⅓', frac23: '⅔', frac14: '¼', frac34: '¾',
  frac18: '⅛', frac38: '⅜', frac58: '⅝', frac78: '⅞',
  deg: '°', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', middot: '·', bull: '•', times: '×', eacute: 'é',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Block-level tags that should become a line break rather than disappear. */
const BLOCK_TAGS =
  /<\/?(?:p|div|li|ul|ol|tr|td|th|br|h[1-6]|section|article|header|footer|table|dl|dt|dd|blockquote)\b[^>]*>/gi;

/**
 * Flattens HTML to text, keeping the line structure the prose parser depends on.
 *
 * Scripts, styles and templates are removed rather than stripped, because their
 * *contents* are not page text — a page whose JSON-LD survived tag-stripping
 * would hand the parser a line of raw JSON to classify.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(BLOCK_TAGS, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function pageTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return undefined;
  // Sites append their own name: "Lemon Chicken - Simply Recipes".
  return decodeEntities(match[1]).replace(/\s+/g, ' ').trim().split(/\s+[|–—-]\s+/)[0] || undefined;
}

// ---------------------------------------------------------------------------
// Tier 1 — JSON-LD
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecipeNode(node: unknown): node is Json {
  if (typeof node !== 'object' || node === null) return false;
  const type = (node as Json)['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && t.toLowerCase() === 'recipe');
}

/**
 * Walks a parsed JSON-LD document for Recipe nodes.
 *
 * They turn up at the top level, inside `@graph`, inside arrays, and nested in
 * other entities, and different platforms pick different ones. Walking
 * everything is far cheaper than tracking which CMS does what.
 */
function findRecipeNodes(value: unknown, found: Json[] = [], depth = 0): Json[] {
  if (depth > 8 || value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const entry of value) findRecipeNodes(entry, found, depth + 1);
    return found;
  }
  if (isRecipeNode(value)) found.push(value as Json);
  for (const entry of Object.values(value as Json)) findRecipeNodes(entry, found, depth + 1);
  return found;
}

export function extractJsonLdRecipes(html: string): Json[] {
  const found: Json[] = [];
  const blocks = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of blocks) {
    const body = block[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try {
      findRecipeNodes(JSON.parse(body), found);
    } catch {
      // Malformed JSON-LD is common and never fatal — there is always another
      // tier below this one. A page with one broken block and one good block
      // should still import cleanly, which is why this continues rather than
      // aborting the whole tier.
    }
  }
  return found;
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = asText(entry);
      if (text) return text;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const node = value as Json;
    return asText(node.name ?? node.text ?? node['@value']);
  }
  return undefined;
}

/** Flattens `recipeInstructions` out of every shape schema.org permits. */
function readInstructions(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === undefined || value === null) return [];
  if (typeof value === 'string') {
    // Some sites put the entire method in one string, with or without markup.
    return htmlToText(value)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }
  if (Array.isArray(value)) return value.flatMap((entry) => readInstructions(entry, depth + 1));
  if (typeof value === 'object') {
    const node = value as Json;
    // HowToSection carries its steps in itemListElement; HowToStep carries text.
    if (node.itemListElement !== undefined) return readInstructions(node.itemListElement, depth + 1);
    const text = asText(node.text ?? node.name);
    return text ? readInstructions(text, depth + 1) : [];
  }
  return [];
}

function readAuthor(value: unknown): string | undefined {
  return asText(value);
}

function readTags(node: Json): string[] {
  const raw = [node.recipeCategory, node.recipeCuisine, node.keywords]
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : []));
  return [...new Set(raw.map((t) => t.trim().toLowerCase()).filter((t) => t !== '' && t.length < 30))]
    .slice(0, 8);
}

function draftFromJsonLd(node: Json, sourceUrl?: string): RecipeDraft | null {
  const name = asText(node.name) ?? '';
  const ingredientSource = node.recipeIngredient ?? node.ingredients;
  const ingredientLines = (Array.isArray(ingredientSource) ? ingredientSource : [ingredientSource])
    .map((entry) => asText(entry))
    .filter((line): line is string => line !== undefined)
    .map((line) => decodeEntities(line).replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');

  // A Recipe node with no ingredients is not a recipe for our purposes — it is
  // usually a stub node cross-referencing the real one from elsewhere on the
  // page. Returning null lets the caller fall through to the next candidate.
  if (ingredientLines.length === 0) return null;

  const notes: string[] = [];
  const prep = parseDuration(node.prepTime);
  const cook = parseDuration(node.cookTime);
  const total = parseDuration(node.totalTime);
  const servings = parseServings(node.recipeYield);

  let prepMinutes = prep ?? 0;
  let cookMinutes = cook ?? 0;
  if (prep === null && cook === null && total !== null) {
    cookMinutes = total;
    notes.push(`The page gave only a total time (${total} min); it is recorded as cooking time.`);
  } else if (cook === null && total !== null && prep !== null) {
    cookMinutes = Math.max(0, total - prep);
  }

  if (servings === null) {
    notes.push('The page did not state a yield. Four servings is assumed — correct it if that is wrong.');
  }
  if (prep === null && cook === null && total === null) {
    notes.push('No times were published on the page, so this counts as zero against your weekly time budget.');
  }

  const steps = readInstructions(node.recipeInstructions);
  if (steps.length === 0) notes.push('No method was published in the page data.');

  const tags = readTags(node);

  return {
    name: decodeEntities(name).trim(),
    mealType: guessMealType(name, tags),
    baseServings: servings ?? 4,
    prepMinutes,
    cookMinutes,
    ingredientLines,
    steps,
    tags,
    source: {
      title: decodeEntities(name).trim() || undefined,
      author: readAuthor(node.author),
      url: sourceUrl ?? asText(node.url),
    },
    notes,
    origin: 'json-ld',
  };
}

// ---------------------------------------------------------------------------
// Tier 2 — microdata
// ---------------------------------------------------------------------------

/**
 * Pulls the text of every element carrying a given `itemprop`.
 *
 * Naive about nesting on purpose: microdata ingredient lines are leaf elements
 * (`<li itemprop="recipeIngredient">`) in every real-world case, and a full
 * matching-tag walk would be a lot of machinery to handle a case that does not
 * occur. Anything it gets wrong falls through to the text tier.
 */
function microdataValues(html: string, prop: string): string[] {
  const pattern = new RegExp(
    `<(\\w+)[^>]*itemprop\\s*=\\s*["'][^"']*\\b${prop}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'gi',
  );
  const out: string[] = [];
  for (const match of html.matchAll(pattern)) {
    const text = htmlToText(match[2]).replace(/\s*\n\s*/g, ' ').trim();
    if (text !== '') out.push(text);
  }
  return out;
}

function draftFromMicrodata(html: string, sourceUrl?: string): RecipeDraft | null {
  const ingredientLines = [
    ...microdataValues(html, 'recipeIngredient'),
    ...microdataValues(html, 'ingredients'),
  ];
  if (ingredientLines.length === 0) return null;

  const name = microdataValues(html, 'name')[0] ?? pageTitle(html) ?? '';
  const steps = microdataValues(html, 'recipeInstructions')
    .flatMap((block) => block.split(/\n+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const servings = parseServings(microdataValues(html, 'recipeYield')[0]);
  const prep = parseDuration(microdataValues(html, 'prepTime')[0]);
  const cook = parseDuration(microdataValues(html, 'cookTime')[0]);

  const notes = [
    'Read from older microdata markup rather than the structured recipe data most ' +
    'sites publish, so it is worth checking the list against the page.',
  ];
  if (servings === null) notes.push('No yield was marked up. Four servings is assumed.');

  return {
    name,
    mealType: guessMealType(name),
    baseServings: servings ?? 4,
    prepMinutes: prep ?? 0,
    cookMinutes: cook ?? 0,
    ingredientLines,
    steps,
    tags: [],
    source: { title: name || undefined, url: sourceUrl },
    notes,
    origin: 'microdata',
  };
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * Every recipe this page appears to contain, best-quality tier first.
 *
 * Plural because a page genuinely can hold several — a "three ways with squash"
 * post publishes three Recipe nodes — and picking one for the user would be
 * picking wrong a third of the time. The caller offers the choice.
 */
export function draftsFromHtml(html: string, sourceUrl?: string): RecipeDraft[] {
  const fromJsonLd = extractJsonLdRecipes(html)
    .map((node) => draftFromJsonLd(node, sourceUrl))
    .filter((draft): draft is RecipeDraft => draft !== null);
  if (fromJsonLd.length > 0) return dedupe(fromJsonLd);

  const fromMicrodata = draftFromMicrodata(html, sourceUrl);
  if (fromMicrodata) return [fromMicrodata];

  const text = htmlToText(html);
  const draft = parseRecipeText(text, {
    origin: 'html-text',
    fallbackTitle: pageTitle(html),
    sourceUrl,
  });
  draft.notes.unshift(
    'This page published no recipe data, so the ingredients were picked out of the ' +
    'page text. Check the list carefully — navigation and comments can end up in it.',
  );
  return draft.ingredientLines.length > 0 ? [draft] : [];
}

/** Same recipe published in two blocks — common when a page has a print view. */
function dedupe(drafts: readonly RecipeDraft[]): RecipeDraft[] {
  const seen = new Map<string, RecipeDraft>();
  for (const draft of drafts) {
    const key = `${draft.name.toLowerCase()}|${draft.ingredientLines.length}`;
    const existing = seen.get(key);
    // Keep whichever copy carries more, since print views often drop the method.
    if (!existing || draft.steps.length > existing.steps.length) seen.set(key, draft);
  }
  return [...seen.values()];
}

/**
 * Decides whether pasted input is a page or plain text, and parses it either way.
 *
 * Users paste both, usually without saying which, and being wrong in the
 * forgiving direction costs nothing: HTML handed to the prose parser produces
 * visible rubbish on the review screen, and text handed to the HTML path simply
 * falls through all three tiers to the same prose parser anyway.
 */
export function draftsFromPaste(input: string, sourceUrl?: string): RecipeDraft[] {
  const looksLikeHtml = /<\/?(?:html|head|body|div|script|li|ul|p|h[1-6]|span)\b/i.test(input);
  if (looksLikeHtml) return draftsFromHtml(input, sourceUrl);
  const draft = parseRecipeText(input, { origin: 'text', sourceUrl });
  return [draft];
}
