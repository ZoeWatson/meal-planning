/**
 * Recipe filtering.
 *
 * One filter type serves two callers: browsing the library by hand, and
 * constraining what the generator is allowed to pick. Keeping them the same
 * object means "show me high-protein meals under 30 minutes" and "plan me a week
 * of high-protein meals under 30 minutes" cannot drift apart, and the UI can
 * offer the same controls in both places.
 *
 * Everything here is a HARD constraint — it removes recipes from consideration.
 * Soft preferences (prefer seasonal, prefer variety, prefer cheap) live in
 * `planner/scoring.ts` and merely make recipes expensive.
 */

import { type RecipeNutrition, isHighProtein, recipeNutrition } from './nutrition';
import { type Region, isInSeason, seasonStatus } from './seasonality';
import type { Id, Ingredient, MealType, Recipe } from './types';

export interface RecipeFilter {
  readonly mealTypes?: readonly MealType[];
  /** Recipe must satisfy every listed diet. */
  readonly diets?: readonly string[];

  /** Must contain ALL of these — "what can I make with the chicken in my fridge". */
  readonly includeIngredients?: readonly Id[];
  /** Must contain NONE of these. */
  readonly excludeIngredients?: readonly Id[];

  /** Prep + cook, in minutes. The one people actually reach for. */
  readonly maxTotalMinutes?: number;
  readonly maxPrepMinutes?: number;

  /** Convenience for the 20 g + 25%-of-calories convention. */
  readonly highProteinOnly?: boolean;
  readonly minProteinG?: number;
  readonly maxKcal?: number;
  readonly minFibreG?: number;

  /** Must carry at least one of these tags. */
  readonly anyTags?: readonly string[];
  readonly excludeTags?: readonly string[];

  /** Drop recipes containing produce that is out of season in the active region. */
  readonly seasonalOnly?: boolean;
  /** Stricter: every produce item must be at peak, not merely available from storage. */
  readonly peakSeasonOnly?: boolean;

  /** Case-insensitive substring match on name and tags. */
  readonly search?: string;

  readonly maxIngredientCount?: number;
  /** Only recipes the user imported, or only the built-in library. */
  readonly builtIn?: boolean;
}

export interface FilterContext {
  readonly ingredients: ReadonlyMap<Id, Ingredient>;
  readonly region: Region;
  readonly month: number;
}

/** Why a recipe was excluded. Surfaced in the UI so an empty result set is explicable. */
export type RejectionReason =
  | 'meal-type' | 'diet' | 'missing-ingredient' | 'excluded-ingredient'
  | 'too-slow' | 'protein' | 'calories' | 'fibre'
  | 'tags' | 'season' | 'search' | 'too-many-ingredients' | 'origin';

export function testRecipe(
  recipe: Recipe,
  filter: RecipeFilter,
  ctx: FilterContext,
  nutrition?: RecipeNutrition,
): RejectionReason | null {
  if (filter.mealTypes?.length && !filter.mealTypes.includes(recipe.mealType)) return 'meal-type';

  if (filter.builtIn !== undefined && recipe.builtIn !== filter.builtIn) return 'origin';

  if (filter.diets?.length) {
    for (const diet of filter.diets) {
      if (!recipe.diets.includes(diet)) return 'diet';
    }
  }

  const ids = new Set(recipe.ingredients.map((ri) => ri.ingredientId));

  for (const id of filter.includeIngredients ?? []) {
    if (!ids.has(id)) return 'missing-ingredient';
  }
  for (const id of filter.excludeIngredients ?? []) {
    if (ids.has(id)) return 'excluded-ingredient';
  }

  const total = recipe.prepMinutes + recipe.cookMinutes;
  if (filter.maxTotalMinutes !== undefined && total > filter.maxTotalMinutes) return 'too-slow';
  if (filter.maxPrepMinutes !== undefined && recipe.prepMinutes > filter.maxPrepMinutes) return 'too-slow';

  if (filter.maxIngredientCount !== undefined && recipe.ingredients.length > filter.maxIngredientCount) {
    return 'too-many-ingredients';
  }

  if (filter.anyTags?.length && !filter.anyTags.some((t) => recipe.tags.includes(t))) return 'tags';
  if (filter.excludeTags?.some((t) => recipe.tags.includes(t))) return 'tags';

  const needsNutrition =
    filter.highProteinOnly || filter.minProteinG !== undefined ||
    filter.maxKcal !== undefined || filter.minFibreG !== undefined;

  if (needsNutrition) {
    const n = nutrition ?? recipeNutrition(recipe, ctx.ingredients);
    if (filter.highProteinOnly && !isHighProtein(n)) return 'protein';
    if (filter.minProteinG !== undefined && n.proteinG < filter.minProteinG) return 'protein';
    if (filter.maxKcal !== undefined && n.kcal > filter.maxKcal) return 'calories';
    if (filter.minFibreG !== undefined && (n.fibreG ?? 0) < filter.minFibreG) return 'fibre';
  }

  if (filter.seasonalOnly || filter.peakSeasonOnly) {
    for (const ri of recipe.ingredients) {
      if (ri.optional) continue;
      const ing = ctx.ingredients.get(ri.ingredientId);
      if (!ing || ing.category !== 'produce') continue;

      if (filter.peakSeasonOnly) {
        if (seasonStatus(ing, ctx.month, ctx.region) === 'out-of-season') return 'season';
        if (seasonStatus(ing, ctx.month, ctx.region) === 'available') return 'season';
      } else if (!isInSeason(ing, ctx.month, ctx.region)) {
        return 'season';
      }
    }
  }

  if (filter.search) {
    const needle = filter.search.trim().toLowerCase();
    const haystack = `${recipe.name} ${recipe.tags.join(' ')}`.toLowerCase();
    if (!haystack.includes(needle)) return 'search';
  }

  return null;
}

export function applyFilter(
  recipes: Iterable<Recipe>,
  filter: RecipeFilter,
  ctx: FilterContext,
): Recipe[] {
  return [...recipes].filter((r) => testRecipe(r, filter, ctx) === null);
}

/**
 * Counts why recipes were rejected.
 *
 * "0 recipes match" is a dead end; "0 match — 34 dropped for season, 12 for time"
 * tells the user which slider to move. Worth the extra pass.
 */
export function explainFilter(
  recipes: Iterable<Recipe>,
  filter: RecipeFilter,
  ctx: FilterContext,
): { matched: Recipe[]; rejections: Map<RejectionReason, number> } {
  const matched: Recipe[] = [];
  const rejections = new Map<RejectionReason, number>();

  for (const recipe of recipes) {
    const reason = testRecipe(recipe, filter, ctx);
    if (reason === null) matched.push(recipe);
    else rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
  }

  return { matched, rejections };
}

/** Presets for one-tap filter chips in the UI. */
export const FILTER_PRESETS: ReadonlyArray<{ id: string; label: string; filter: RecipeFilter }> = [
  { id: 'quick', label: 'Under 30 min', filter: { maxTotalMinutes: 30 } },
  { id: 'high-protein', label: 'High protein', filter: { highProteinOnly: true } },
  { id: 'vegetarian', label: 'Vegetarian', filter: { diets: ['vegetarian'] } },
  { id: 'vegan', label: 'Vegan', filter: { diets: ['vegan'] } },
  { id: 'gluten-free', label: 'Gluten free', filter: { diets: ['gluten-free'] } },
  { id: 'in-season', label: 'In season', filter: { seasonalOnly: true } },
  { id: 'simple', label: '5 ingredients or fewer', filter: { maxIngredientCount: 5 } },
];
