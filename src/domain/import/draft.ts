/**
 * The intermediate form every single-recipe import passes through.
 *
 * A link, a photo and a block of pasted text are three different problems right
 * up until the moment they become text; after that they are the same problem.
 * So each source produces a `RecipeDraft` — a recipe still in its written form,
 * with ingredient lines as prose — and everything downstream is shared.
 *
 * The draft is deliberately NOT a `RawRecipe`. It is the thing a human edits.
 * Extraction from a web page or a photograph is guesswork in a way that reading a
 * hand-authored JSON file is not, so the draft carries its guesses as `notes`
 * rather than presenting them as facts, and nothing reaches the library until
 * someone has looked at it.
 *
 * `draftToRawRecipe` then hands it to the existing importer, which applies the
 * same strict resolution rules as a bulk import. There is no second, laxer path
 * into the library: a recipe captured from a photo is held to exactly the same
 * standard as one typed into a bundle by hand.
 */

import type { MealType } from '../types';
import type { RawRecipe } from './importer';
import { slugify } from './stubs';

export interface RecipeDraft {
  name: string;
  mealType: MealType;
  baseServings: number;
  prepMinutes: number;
  cookMinutes: number;
  /** Ingredients as written, one line each. Parsed by `parseLine.ts` at import. */
  ingredientLines: string[];
  steps: string[];
  tags: string[];
  source?: { title?: string; author?: string; url?: string };
  /**
   * Every judgement call made while extracting this, in plain English.
   *
   * Shown to the user rather than logged. A draft that quietly assumed four
   * servings is indistinguishable from one that read "Serves 4" off the page,
   * and the difference decides whether the grocery list is right.
   */
  notes: string[];
  /** How the draft was obtained, for the review screen to explain itself. */
  origin: DraftOrigin;
}

export type DraftOrigin = 'json-ld' | 'microdata' | 'html-text' | 'text' | 'photo';

export const ORIGIN_LABELS: Readonly<Record<DraftOrigin, string>> = {
  'json-ld': 'structured recipe data on the page',
  microdata: 'microdata markup on the page',
  'html-text': 'the page text, with no recipe markup to read',
  text: 'the text you pasted',
  photo: 'text recognised in the photo',
};

/** A draft with nothing in it, for the "type it yourself" path. */
export function emptyDraft(origin: DraftOrigin = 'text'): RecipeDraft {
  return {
    name: '',
    mealType: 'full',
    baseServings: 4,
    prepMinutes: 0,
    cookMinutes: 0,
    ingredientLines: [],
    steps: [],
    tags: [],
    notes: [],
    origin,
  };
}

// ---------------------------------------------------------------------------
// Servings
// ---------------------------------------------------------------------------

/**
 * Reads a serving count out of whatever the source called it.
 *
 * Returns `null` rather than a default when it cannot tell. The caller supplies
 * the fallback and records it as a guess — every quantity in the recipe is
 * relative to this number, so silently inventing it would scale the whole
 * grocery list by an arbitrary factor with nothing on screen to say so.
 */
export function parseServings(input: unknown): number | null {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  }
  if (Array.isArray(input)) {
    for (const entry of input) {
      const parsed = parseServings(entry);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof input !== 'string') return null;

  // "4 to 6 servings" / "4-6" — the low end, not the average. Under-scaling
  // leaves a portion short; over-scaling buys food that gets thrown away, and
  // waste is the thing this app exists to avoid.
  const range = /(\d+)\s*(?:-|–|—|to)\s*(\d+)/.exec(input);
  if (range) return Number(range[1]);

  const single = /(\d+(?:\.\d+)?)/.exec(input);
  if (!single) return null;
  const value = Number(single[1]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/**
 * Minutes from an ISO 8601 duration (`PT1H30M`, which is what schema.org uses)
 * or from prose (`1 hr 30 mins`, `45 minutes`).
 *
 * Returns `null` when there is no time to read, which the caller reports as zero
 * — the same thing the bulk format does for a missing `cookMinutes`.
 */
export function parseDuration(input: unknown): number | null {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 ? Math.round(input) : null;
  }
  if (Array.isArray(input)) {
    for (const entry of input) {
      const parsed = parseDuration(entry);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof input !== 'string') return null;

  const text = input.trim();
  if (text === '') return null;

  // ISO 8601. Days are included because slow-cooker and proving times use them,
  // and reading "P1D" as nothing would report a two-day recipe as instant.
  const iso =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
      .exec(text);
  if (iso && iso.slice(1).some((part) => part !== undefined)) {
    const [, days, hours, minutes, seconds] = iso;
    const total =
      Number(days ?? 0) * 1440 + Number(hours ?? 0) * 60 +
      Number(minutes ?? 0) + Number(seconds ?? 0) / 60;
    return Math.round(total);
  }

  let total = 0;
  let matched = false;
  const patterns: ReadonlyArray<readonly [RegExp, number]> = [
    [/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/gi, 60],
    [/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/gi, 1],
  ];
  for (const [pattern, multiplier] of patterns) {
    for (const match of text.matchAll(pattern)) {
      total += Number(match[1]) * multiplier;
      matched = true;
    }
  }
  return matched ? Math.round(total) : null;
}

// ---------------------------------------------------------------------------
// Meal type
// ---------------------------------------------------------------------------

/**
 * Words in a title that place a recipe in the snack or light slots.
 *
 * Guessing here is acceptable where guessing at a quantity is not, and the
 * difference is worth being explicit about: a wrong `mealType` puts a cake in the
 * dinner rotation, which announces itself the moment you look at the plan. A
 * wrong quantity sends you to a shop for the wrong amount of food and never says
 * anything at all.
 */
const SNACK_HINTS =
  /\b(cookies?|biscuits?|brownies?|flapjacks?|bars?|muffins?|scones?|granola|trail mix|dip|hummus|guacamole|salsa|popcorn|crackers?|smoothie|shake|energy balls?)\b/i;
const LIGHT_HINTS =
  /\b(salad|soup|sandwich|toastie|wrap|bruschetta|omelette|omelet|porridge|oatmeal|breakfast|brunch|side|starter|appetiser|appetizer|snack)\b/i;

export function guessMealType(name: string, tags: readonly string[] = []): MealType {
  const haystack = [name, ...tags].join(' ');
  if (SNACK_HINTS.test(haystack)) return 'snack';
  if (LIGHT_HINTS.test(haystack)) return 'light';
  return 'full';
}

// ---------------------------------------------------------------------------
// Handing off to the importer
// ---------------------------------------------------------------------------

/**
 * Turns a reviewed draft into the strict wire format.
 *
 * Ingredient lines go across as `raw`, so the same conservative parser that
 * handles bulk imports reads them, and a line it will not accept is rejected here
 * exactly as it would be there.
 */
export function draftToRawRecipe(draft: RecipeDraft, id: string): RawRecipe {
  return {
    id,
    name: draft.name.trim(),
    mealType: draft.mealType,
    baseServings: draft.baseServings,
    ingredients: draft.ingredientLines
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((raw) => ({ raw })),
    steps: draft.steps.map((step) => step.trim()).filter((step) => step !== ''),
    prepMinutes: draft.prepMinutes,
    cookMinutes: draft.cookMinutes,
    tags: draft.tags,
    source: draft.source,
  };
}

/**
 * A recipe id that does not collide with one already in the library.
 *
 * Ids are permanent — plans and the meal log reference them — so a clash has to
 * be resolved at creation rather than by overwriting. Importing the same recipe
 * twice gives you two recipes, which is a visible and deletable mistake, rather
 * than silently replacing the one you had already corrected by hand.
 */
export function uniqueRecipeId(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name) || 'recipe';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
