/**
 * Bulk import.
 *
 * The contract is deliberately strict: a recipe whose ingredients cannot all be
 * resolved to known ingredients, with known units, is REJECTED — never imported
 * with holes in it.
 *
 * The reason is that a half-resolved recipe is worse than no recipe. The planner
 * treats grams as ground truth when computing waste and building the grocery
 * list, so a recipe with a silently-dropped ingredient will confidently tell you
 * to buy the wrong food. Failing loudly at import time turns that into a batch of
 * fixable error messages instead.
 *
 * See `docs/import-format.md` for the wire format and the authoring rules.
 */

import {
  type Id, type Ingredient, type IngredientCategory, type MealType,
  type Recipe, type RecipeIngredient, type ScalingRule,
} from '../types';
import { type NutritionFacts } from '../types';
import { type CarryOver } from '../waste';
import { deriveDiets } from '../nutrition';
import { parseIngredientLine } from './parseLine';
import { type DisplayPreference, UnitConversionError, toGrams } from '../units';

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export interface RawIngredient {
  id: string;
  name: string;
  aliases?: string[];
  category: IngredientCategory;
  gramsPerMl?: number;
  countUnits?: Record<string, number>;
  displayAs?: DisplayPreference;
  countUnit?: string;
  purchase: { unit: string; gramsPerPack: number; divisible: boolean; costPerKg: number };
  shelfLifeDays: number;
  carryOver?: CarryOver;
  backgroundUseGramsPerWeek?: number;
  wasteRisk?: number;
  seasonMonths?: number[];
  excludesDiets?: string[];
  allergens?: string[];
  allergensVerified?: boolean;
  nutritionPer100g?: NutritionFacts;
}

/**
 * One ingredient line, in either of two forms.
 *
 * Structured — `item` + `quantity` + `unit` — is what the importer ultimately
 * needs, and is the right form for anything machine-generated.
 *
 * Prose — a single `raw` string like "2 cloves garlic, minced" — is what every
 * recipe on earth is actually written in. It is parsed by `parseLine.ts` into the
 * structured form. When both are present the structured fields win, so a mostly
 * auto-parsed file can have individual lines corrected by hand without stripping
 * out the original text.
 */
export interface RawRecipeIngredient {
  /** A whole written line, e.g. "2 cloves garlic, minced". Parsed if present. */
  raw?: string;
  /** Ingredient NAME or alias, not an id. Resolution is the importer's job. */
  item?: string;
  quantity?: number;
  unit?: string;
  prep?: string;
  optional?: boolean;
  scaling?: ScalingRule;
}

export interface RawRecipe {
  id: string;
  name: string;
  mealType: MealType;
  baseServings: number;
  ingredients: RawRecipeIngredient[];
  steps: string[];
  prepMinutes: number;
  cookMinutes: number;
  tags?: string[];
  primaryProtein?: string;
  diets?: string[];
  source?: { title?: string; author?: string; url?: string };
}

export interface ImportBundle {
  ingredients?: RawIngredient[];
  recipes?: RawRecipe[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ImportIssue {
  readonly severity: 'error' | 'warning';
  /** Where the problem is, e.g. `recipes[12].ingredients[3]`. */
  readonly path: string;
  readonly message: string;
  /**
   * Set when the ingredient is genuinely unknown. The fix is to ADD an ingredient
   * (or an alias on an existing one).
   */
  readonly unresolvedItem?: string;
  /**
   * Set when the ingredient IS known but the unit could not be converted. The fix
   * is to add a `countUnits` entry or a density to that ingredient.
   *
   * Deliberately a separate field from `unresolvedItem`: conflating the two sends
   * you off creating a duplicate ingredient that already exists, which is both
   * wasted work and a corruption of the dictionary.
   */
  readonly unconvertible?: { readonly ingredientId: string; readonly unit: string };
}

export interface ImportResult {
  readonly ingredients: Ingredient[];
  readonly recipes: Recipe[];
  readonly issues: readonly ImportIssue[];
  /** Recipes rejected outright, with the reason. Fix these and re-import. */
  readonly rejected: ReadonlyArray<{ id: string; name: string; reasons: string[] }>;
  readonly ok: boolean;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Builds the name/alias → ingredient lookup that recipe import depends on. */
export function buildIngredientIndex(ingredients: readonly Ingredient[]): Map<string, Ingredient> {
  const index = new Map<string, Ingredient>();
  for (const ing of ingredients) {
    index.set(normalizeKey(ing.name), ing);
    index.set(normalizeKey(ing.id), ing);
    for (const alias of ing.aliases) index.set(normalizeKey(alias), ing);
  }
  return index;
}

function parseIngredient(raw: RawIngredient, path: string, issues: ImportIssue[]): Ingredient | null {
  const fail = (message: string): null => {
    issues.push({ severity: 'error', path, message });
    return null;
  };

  if (!raw.id || !raw.name) return fail('Ingredient requires both `id` and `name`.');
  if (!raw.purchase || typeof raw.purchase.gramsPerPack !== 'number' || raw.purchase.gramsPerPack <= 0) {
    return fail('Ingredient requires `purchase.gramsPerPack` > 0 — waste cannot be computed without a pack size.');
  }
  if (typeof raw.shelfLifeDays !== 'number' || raw.shelfLifeDays <= 0) {
    return fail('Ingredient requires `shelfLifeDays` > 0.');
  }

  if (raw.displayAs === 'volume' && raw.gramsPerMl === undefined) {
    issues.push({
      severity: 'warning', path,
      message: '`displayAs: "volume"` needs `gramsPerMl`; falling back to mass display.',
    });
  }
  if (raw.displayAs === 'count' && !raw.countUnits) {
    issues.push({
      severity: 'warning', path,
      message: '`displayAs: "count"` needs `countUnits`; falling back to mass display.',
    });
  }
  if (raw.seasonMonths?.some((m) => m < 1 || m > 12)) {
    return fail('`seasonMonths` entries must be 1-12.');
  }

  return {
    id: raw.id,
    name: raw.name,
    aliases: raw.aliases ?? [],
    category: raw.category,
    gramsPerMl: raw.gramsPerMl,
    countUnits: raw.countUnits,
    displayAs: raw.displayAs,
    countUnit: raw.countUnit,
    purchase: raw.purchase,
    shelfLifeDays: raw.shelfLifeDays,
    carryOver: raw.carryOver,
    backgroundUseGramsPerWeek: raw.backgroundUseGramsPerWeek,
    wasteRisk: raw.wasteRisk,
    seasonMonths: raw.seasonMonths,
    excludesDiets: raw.excludesDiets,
    allergens: raw.allergens,
    allergensVerified: raw.allergensVerified,
    nutritionPer100g: raw.nutritionPer100g,
  };
}

function parseRecipe(
  raw: RawRecipe,
  index: ReadonlyMap<string, Ingredient>,
  path: string,
  issues: ImportIssue[],
  builtIn: boolean,
): { recipe: Recipe } | { reasons: string[] } {
  const reasons: string[] = [];

  if (!raw.id || !raw.name) reasons.push('Recipe requires both `id` and `name`.');
  if (!raw.baseServings || raw.baseServings <= 0) reasons.push('`baseServings` must be > 0.');
  if (!Array.isArray(raw.ingredients) || raw.ingredients.length === 0) {
    reasons.push('Recipe has no ingredients.');
  }

  const resolved: RecipeIngredient[] = [];

  raw.ingredients?.forEach((rawLine, i) => {
    const itemPath = `${path}.ingredients[${i}]`;

    // Prose lines are parsed first; explicit fields then override the parse, so a
    // hand-corrected line still keeps its original text for reference.
    let ri = rawLine;
    if (rawLine.raw !== undefined && rawLine.item === undefined) {
      const parsed = parseIngredientLine(rawLine.raw);
      if (!parsed.ok) {
        reasons.push(`Could not read "${rawLine.raw}" — ${parsed.reason}`);
        issues.push({ severity: 'error', path: itemPath, message: parsed.reason });
        return;
      }
      ri = {
        ...rawLine,
        item: parsed.value.item,
        quantity: rawLine.quantity ?? parsed.value.quantity,
        unit: rawLine.unit ?? parsed.value.unit,
        prep: rawLine.prep ?? parsed.value.prep,
        optional: rawLine.optional ?? parsed.value.optional,
      };
      for (const note of parsed.value.notes ?? []) {
        issues.push({
          severity: 'warning', path: itemPath,
          message: `"${rawLine.raw}" — ${note}.`,
        });
      }
    }

    if (ri.item === undefined || ri.item.trim() === '') {
      reasons.push('Ingredient line has no `item` and no parseable `raw`.');
      issues.push({
        severity: 'error', path: itemPath,
        message: 'Provide either `item` + `quantity` + `unit`, or a `raw` line to parse.',
      });
      return;
    }

    const ing = index.get(normalizeKey(ri.item));

    if (!ing) {
      reasons.push(`Unknown ingredient "${ri.item}"`);
      issues.push({
        severity: 'error', path: itemPath, unresolvedItem: ri.item,
        message: `"${ri.item}" does not match any ingredient name, id, or alias. ` +
          `Add the ingredient, or add "${ri.item}" to an existing ingredient's aliases.`,
      });
      return;
    }

    if (typeof ri.quantity !== 'number' || ri.quantity <= 0) {
      reasons.push(`Invalid quantity for "${ri.item}"`);
      issues.push({ severity: 'error', path: itemPath, message: '`quantity` must be a number > 0.' });
      return;
    }

    const unit = ri.unit ?? 'each';

    try {
      resolved.push({
        ingredientId: ing.id,
        quantity: ri.quantity,
        unit,
        grams: toGrams(ri.quantity, unit, ing),
        prep: ri.prep,
        optional: ri.optional ?? false,
        scaling: ri.scaling ?? defaultScaling(ing),
      });
    } catch (err) {
      const message = err instanceof UnitConversionError ? err.message : String(err);
      reasons.push(`Cannot convert "${ri.quantity} ${unit} ${ri.item}" to grams`);
      issues.push({
        severity: 'error', path: itemPath, message,
        unconvertible: { ingredientId: ing.id, unit },
      });
    }
  });

  if (raw.primaryProtein && !index.has(normalizeKey(raw.primaryProtein))) {
    issues.push({
      severity: 'warning', path: `${path}.primaryProtein`,
      message: `"${raw.primaryProtein}" is not a known ingredient; variety scoring will ignore it.`,
    });
  }

  if (reasons.length > 0) return { reasons };

  // Diets are DERIVED from what the ingredients rule out, then unioned with any
  // authored claims. Deriving is uniform across the library and cannot be
  // forgotten; authored entries cover what ingredients alone cannot establish
  // (certified gluten-free processing, halal, kosher).
  const ingredientMap = new Map<Id, Ingredient>();
  for (const ing of index.values()) ingredientMap.set(ing.id, ing);
  const diets = [...new Set([...deriveDiets(resolved, ingredientMap), ...(raw.diets ?? [])])];

  return {
    recipe: {
      id: raw.id,
      name: raw.name,
      mealType: raw.mealType,
      baseServings: raw.baseServings,
      ingredients: resolved,
      steps: raw.steps ?? [],
      prepMinutes: raw.prepMinutes ?? 0,
      cookMinutes: raw.cookMinutes ?? 0,
      tags: raw.tags ?? [],
      primaryProtein: raw.primaryProtein
        ? index.get(normalizeKey(raw.primaryProtein))?.id
        : undefined,
      diets,
      source: raw.source,
      builtIn,
    },
  };
}

/**
 * Spices and oils do not scale with servings the way the main ingredients do.
 * This guess is overridable per-line via `scaling` in the wire format.
 */
function defaultScaling(ing: Ingredient): ScalingRule {
  if (ing.category === 'spice') return 'sublinear';
  if (ing.category === 'oil') return 'sublinear';
  return 'linear';
}

/**
 * Imports a bundle. Existing ingredients are passed in so recipe-only imports can
 * resolve against the library already on the device.
 */
export function importBundle(
  bundle: ImportBundle,
  existingIngredients: readonly Ingredient[] = [],
  options: { builtIn?: boolean } = {},
): ImportResult {
  const issues: ImportIssue[] = [];
  const rejected: Array<{ id: string; name: string; reasons: string[] }> = [];

  const newIngredients: Ingredient[] = [];
  (bundle.ingredients ?? []).forEach((raw, i) => {
    const parsed = parseIngredient(raw, `ingredients[${i}]`, issues);
    if (parsed) newIngredients.push(parsed);
  });

  const seen = new Set<Id>();
  for (const ing of [...existingIngredients, ...newIngredients]) {
    if (seen.has(ing.id)) {
      issues.push({
        severity: 'warning', path: `ingredients:${ing.id}`,
        message: `Duplicate ingredient id "${ing.id}" — the later definition wins.`,
      });
    }
    seen.add(ing.id);
  }

  const index = buildIngredientIndex([...existingIngredients, ...newIngredients]);

  const recipes: Recipe[] = [];
  (bundle.recipes ?? []).forEach((raw, i) => {
    const outcome = parseRecipe(raw, index, `recipes[${i}]`, issues, options.builtIn ?? false);
    if ('recipe' in outcome) recipes.push(outcome.recipe);
    else rejected.push({ id: raw.id ?? `recipes[${i}]`, name: raw.name ?? '(unnamed)', reasons: outcome.reasons });
  });

  return {
    ingredients: newIngredients,
    recipes,
    issues,
    rejected,
    ok: rejected.length === 0 && !issues.some((issue) => issue.severity === 'error'),
  };
}

/**
 * Groups unresolved item names by frequency. With 500 recipes the same twenty
 * missing ingredients account for most failures, so fixing them in that order
 * clears the backlog fastest.
 */
export function summarizeUnresolved(result: ImportResult): Array<{ item: string; count: number }> {
  const counts = new Map<string, number>();
  for (const issue of result.issues) {
    if (issue.unresolvedItem) {
      counts.set(issue.unresolvedItem, (counts.get(issue.unresolvedItem) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Groups unit-conversion failures by (ingredient, unit).
 *
 * A different fix from the list above and worth its own report: these ingredients
 * already exist and need a `countUnits` entry or a density, not a new record.
 */
export function summarizeUnconvertible(
  result: ImportResult,
): Array<{ ingredientId: string; unit: string; count: number }> {
  const counts = new Map<string, { ingredientId: string; unit: string; count: number }>();
  for (const issue of result.issues) {
    if (!issue.unconvertible) continue;
    const key = `${issue.unconvertible.ingredientId}|${issue.unconvertible.unit}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { ...issue.unconvertible, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}
