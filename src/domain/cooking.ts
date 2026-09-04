/**
 * Cooking, leftovers and the meal log.
 *
 * Three events that are easy to conflate and must not be:
 *
 *   COOKED   — you made a dish. Happens once, may produce leftovers.
 *   LEFTOVER — portions sitting in the fridge, with a life expectancy.
 *   ATE      — you consumed a meal. Happens several times per cook, and also
 *              happens for things you never cooked at all.
 *
 * Modelling "eaten" as a property of the cook would mean a batch cooked on Sunday
 * and finished on Wednesday is one event on Sunday, which makes the meal log
 * wrong in exactly the way that matters — it would show you ate nothing for three
 * days.
 */

import type { Id, Ingredient, MealType, Recipe } from './types';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type StorageKind = 'fridge' | 'freezer';

/** One cooking session. */
export interface CookedMeal {
  readonly id: Id;
  readonly recipeId: Id;
  /** Denormalised so history survives a recipe being edited or deleted. */
  readonly recipeName: string;
  /** The plan slot this came from, when it came from the week. */
  readonly slotId?: Id;
  readonly planId?: Id;
  readonly cookedAtISO: string;
  readonly servingsMade: number;
  readonly notes?: string;
}

export interface Leftover {
  readonly id: Id;
  readonly cookedMealId: Id;
  readonly recipeId: Id;
  readonly label: string;
  readonly servingsRemaining: number;
  readonly storedAtISO: string;
  readonly storage: StorageKind;
  /** Computed at storage time from `estimateKeepingDays`, then fixed. */
  readonly useByISO: string;
  /** Set when the last portion is eaten or the rest is thrown out. */
  readonly closedAtISO?: string;
  readonly discarded?: boolean;
}

export type MealSource = 'cooked' | 'leftover' | 'out' | 'other';

/** One eating event. */
export interface MealLogEntry {
  readonly id: Id;
  /** Local `YYYY-MM-DD`. */
  readonly dateISO: string;
  readonly mealType: MealType | 'other';
  readonly source: MealSource;
  readonly label: string;
  readonly servings: number;
  readonly recipeId?: Id;
  readonly leftoverId?: Id;
  readonly cookedMealId?: Id;
  /** Links an "ate out" entry to the spend it created. */
  readonly expenseId?: Id;
  readonly createdAtISO: string;
}

// ---------------------------------------------------------------------------
// Keeping times
// ---------------------------------------------------------------------------

/**
 * How long a cooked dish keeps.
 *
 * These follow standard public food-safety guidance (Health Canada / USDA give
 * 3–4 days refrigerated for cooked meat, poultry, fish, soups, stews and cooked
 * vegetables; cooked rice is the notable exception at about a day because of
 * Bacillus cereus, which survives cooking and multiplies as rice cools).
 *
 * Two deliberate choices:
 *
 *  - The SHORTEST applicable rule wins. A chicken-and-rice dish gets rice's
 *    single day, not chicken's three.
 *  - The bottom of each published range is used, not the top. Being a day
 *    conservative costs a portion; being a day optimistic costs rather more.
 *
 * This is a reminder, not a verdict. It cannot know how fast the dish was cooled,
 * how cold the fridge runs, or how many times it has been reheated — and the app
 * says so where the number is shown.
 */
export interface KeepingRule {
  readonly days: number;
  readonly reason: string;
}

const DEFAULT_FRIDGE: KeepingRule = { days: 3, reason: 'cooked dishes generally keep 3–4 days' };

/** Freezer life is quality-limited rather than safety-limited, hence the long window. */
const DEFAULT_FREEZER: KeepingRule = { days: 90, reason: 'frozen cooked dishes keep about 3 months' };

interface CategoryRule {
  readonly test: (ing: Ingredient) => boolean;
  readonly rule: KeepingRule;
}

const SHORT_LIFE_RULES: readonly CategoryRule[] = [
  {
    // Cooked rice is the one everyday case where the usual 3–4 days is wrong.
    test: (ing) => /\brice\b/i.test(ing.name) || ing.aliases.some((a) => /\brice\b/i.test(a)),
    rule: { days: 1, reason: 'cooked rice should be eaten within a day' },
  },
  {
    test: (ing) => ing.category === 'seafood',
    rule: { days: 2, reason: 'cooked seafood keeps about 2 days' },
  },
];

/**
 * Estimates how long a cooked recipe keeps, and why.
 *
 * The reason travels with the number so the UI can explain a surprisingly short
 * window rather than just displaying it — "1 day" on a rice dish looks like a bug
 * until you know it is the rice.
 */
export function estimateKeeping(
  recipe: Recipe,
  ingredients: ReadonlyMap<Id, Ingredient>,
  storage: StorageKind,
): KeepingRule {
  if (storage === 'freezer') return DEFAULT_FREEZER;

  let shortest = DEFAULT_FRIDGE;
  for (const line of recipe.ingredients) {
    const ing = ingredients.get(line.ingredientId);
    if (!ing) continue;
    for (const { test, rule } of SHORT_LIFE_RULES) {
      if (test(ing) && rule.days < shortest.days) shortest = rule;
    }
  }
  return shortest;
}

/** Local `YYYY-MM-DD` for a date. `toISOString` would shift across a timezone. */
export function localDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function addDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

export type FreshnessState = 'fresh' | 'use-soon' | 'today' | 'past';

export interface Freshness {
  readonly state: FreshnessState;
  /** Negative once past the use-by date. */
  readonly daysLeft: number;
  readonly label: string;
}

/**
 * Turns a use-by date into something worth reading at a fridge door.
 *
 * "Use today" and "2 days left" prompt action; a bare date does not.
 */
export function freshness(useByISO: string, today: string = localDate()): Freshness {
  const [ty, tm, td] = today.split('-').map(Number);
  const [uy, um, ud] = useByISO.split('-').map(Number);
  const daysLeft = Math.round(
    (Date.UTC(uy, um - 1, ud) - Date.UTC(ty, tm - 1, td)) / 86_400_000,
  );

  if (daysLeft < 0) {
    return {
      state: 'past', daysLeft,
      label: daysLeft === -1 ? 'A day past' : `${Math.abs(daysLeft)} days past`,
    };
  }
  if (daysLeft === 0) return { state: 'today', daysLeft, label: 'Use today' };
  if (daysLeft === 1) return { state: 'use-soon', daysLeft, label: 'Use tomorrow' };
  return { state: 'fresh', daysLeft, label: `${daysLeft} days left` };
}

/** Leftovers still worth showing: portions remaining and not closed off. */
export function isActive(leftover: Leftover): boolean {
  return leftover.closedAtISO === undefined && leftover.servingsRemaining > 0;
}

// ---------------------------------------------------------------------------
// Cook from what you have
// ---------------------------------------------------------------------------

export interface PantryMatch {
  readonly recipe: Recipe;
  readonly haveIds: readonly Id[];
  readonly missingIds: readonly Id[];
  /** Fraction of required ingredients already in the house, 0..1. */
  readonly coverage: number;
}

/**
 * Ingredients you plausibly have right now.
 *
 * Three sources, and the third is the interesting one:
 *
 *  - pantry items marked `stocked`
 *  - shelf-stable surplus banked from previous weeks
 *  - **grocery lines already ticked off**, because a ticked box means it went in
 *    the basket. Without this the feature is nearly useless mid-week: the whole
 *    point is "I shopped on Saturday, what can I make on Tuesday", and the pantry
 *    alone only knows about salt and oil.
 */
export function availableIngredients(sources: {
  readonly pantryStocked: readonly Id[];
  readonly carriedOver: readonly Id[];
  readonly purchased: readonly Id[];
  readonly staples: readonly Id[];
}): Set<Id> {
  return new Set([
    ...sources.pantryStocked,
    ...sources.carriedOver,
    ...sources.purchased,
    ...sources.staples,
  ]);
}

/**
 * Ranks recipes by how much of each you already have.
 *
 * Optional ingredients are ignored entirely — being told a recipe is "missing"
 * the garnish is noise, and it would push genuinely cookable dishes down the list.
 */
export function matchFromPantry(
  recipes: Iterable<Recipe>,
  available: ReadonlySet<Id>,
  options: { readonly maxMissing?: number } = {},
): PantryMatch[] {
  const maxMissing = options.maxMissing ?? 3;
  const matches: PantryMatch[] = [];

  for (const recipe of recipes) {
    const required = recipe.ingredients.filter((line) => !line.optional);
    if (required.length === 0) continue;

    const haveIds: Id[] = [];
    const missingIds: Id[] = [];
    for (const line of required) {
      (available.has(line.ingredientId) ? haveIds : missingIds).push(line.ingredientId);
    }

    if (missingIds.length > maxMissing) continue;
    matches.push({
      recipe, haveIds, missingIds,
      coverage: haveIds.length / required.length,
    });
  }

  return matches.sort((a, b) =>
    a.missingIds.length !== b.missingIds.length
      ? a.missingIds.length - b.missingIds.length
      : b.coverage - a.coverage);
}

// ---------------------------------------------------------------------------
// The week's eating
// ---------------------------------------------------------------------------

/** Monday-start week containing `date`, as local `YYYY-MM-DD`. */
export function weekStart(date: Date = new Date()): string {
  const day = (date.getDay() + 6) % 7; // Monday = 0
  return localDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() - day));
}

export interface DayLog {
  readonly dateISO: string;
  readonly entries: readonly MealLogEntry[];
  readonly servings: number;
}

export interface WeekLog {
  readonly startISO: string;
  readonly days: readonly DayLog[];
  readonly totalEntries: number;
  readonly bySource: Readonly<Record<MealSource, number>>;
  /** Days in the week so far with nothing logged. */
  readonly daysWithNothing: number;
  readonly homeCookedShare: number;
}

const ZERO_SOURCES: Readonly<Record<MealSource, number>> = {
  cooked: 0, leftover: 0, out: 0, other: 0,
};

/**
 * Groups a week's eating by day.
 *
 * Every day in the week is present even when empty, so the view shows a shape
 * rather than a list — a gap is information, and a list of only the days you
 * remembered to log looks like a complete record when it is not.
 */
export function summariseWeek(
  entries: readonly MealLogEntry[],
  startISO: string,
  today: string = localDate(),
): WeekLog {
  const days: DayLog[] = [];
  const bySource = { ...ZERO_SOURCES };
  let totalEntries = 0;
  let daysWithNothing = 0;

  for (let i = 0; i < 7; i++) {
    const dateISO = addDays(startISO, i);
    const dayEntries = entries.filter((e) => e.dateISO === dateISO);

    days.push({
      dateISO,
      entries: dayEntries,
      servings: dayEntries.reduce((sum, e) => sum + e.servings, 0),
    });

    totalEntries += dayEntries.length;
    for (const entry of dayEntries) bySource[entry.source] += 1;
    if (dayEntries.length === 0 && dateISO <= today) daysWithNothing += 1;
  }

  const home = bySource.cooked + bySource.leftover;
  return {
    startISO,
    days,
    totalEntries,
    bySource,
    daysWithNothing,
    homeCookedShare: totalEntries > 0 ? home / totalEntries : 0,
  };
}
