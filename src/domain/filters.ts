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
import { type CuisineRegionId, type DishTypeId, dishTypesOf, regionOf } from './taxonomy';
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

  /**
   * Must be one of these kinds of dish. Derived, not tagged — see `taxonomy.ts`.
   *
   * Matched against EVERY type the recipe is, not only the one it files under, so
   * asking for pasta finds the minestrone with ditalini in it. Filing and
   * filtering want different answers and that file says why.
   */
  readonly dishTypes?: readonly DishTypeId[];
  /** Must come from one of these culinary regions — nothing to do with `Region`. */
  readonly regions?: readonly CuisineRegionId[];

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
  | 'tags' | 'dish-type' | 'region' | 'season' | 'search'
  | 'too-many-ingredients' | 'origin';

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

  if (filter.dishTypes?.length) {
    const types = dishTypesOf(recipe, ctx.ingredients);
    if (!filter.dishTypes.some((t) => types.includes(t))) return 'dish-type';
  }
  if (filter.regions?.length && !filter.regions.includes(regionOf(recipe))) return 'region';

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

/**
 * What kind of question a preset answers.
 *
 * Seven chips in one row is a row you read left to right hunting for the one you
 * want. Three short labelled rows is three glances, because "I am vegetarian",
 * "I have twenty minutes" and "I want something worth eating" are separate
 * decisions that happen to be made on the same screen.
 */
export type FilterGroupId = 'diet' | 'effort' | 'quality';

export const FILTER_GROUPS: ReadonlyArray<{ id: FilterGroupId; label: string }> = [
  { id: 'diet', label: 'Diet' },
  { id: 'effort', label: 'Effort' },
  { id: 'quality', label: 'What is in it' },
];

export interface FilterPreset {
  readonly id: string;
  readonly label: string;
  readonly group: FilterGroupId;
  readonly filter: RecipeFilter;
}

/** Presets for one-tap filter chips in the UI. */
export const FILTER_PRESETS: readonly FilterPreset[] = [
  { id: 'vegetarian', label: 'Vegetarian', group: 'diet', filter: { diets: ['vegetarian'] } },
  { id: 'vegan', label: 'Vegan', group: 'diet', filter: { diets: ['vegan'] } },
  { id: 'gluten-free', label: 'Gluten free', group: 'diet', filter: { diets: ['gluten-free'] } },
  { id: 'quick', label: 'Under 30 min', group: 'effort', filter: { maxTotalMinutes: 30 } },
  { id: 'simple', label: '5 ingredients or fewer', group: 'effort', filter: { maxIngredientCount: 5 } },
  { id: 'high-protein', label: 'High protein', group: 'quality', filter: { highProteinOnly: true } },
  { id: 'in-season', label: 'In season', group: 'quality', filter: { seasonalOnly: true } },
];

const PRESETS_BY_ID: ReadonlyMap<string, FilterPreset> =
  new Map(FILTER_PRESETS.map((p) => [p.id, p]));

/** The label for an active preset, for UI summarising what is switched on. */
export function presetLabel(id: string): string {
  return PRESETS_BY_ID.get(id)?.label ?? id;
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/**
 * How a list of recipes is ordered on screen.
 *
 * Here rather than in the screen because the comparators are the same pure
 * functions over the same data the filters read, and because "quickest first"
 * has to mean prep AND cook — the same total the `maxTotalMinutes` filter uses,
 * from one place, rather than a second definition drifting inside a component.
 *
 * Ordering is NOT filtering and stays separate from `RecipeFilter` for that
 * reason: the planner consumes filters and has its own scoring, and giving it a
 * field it must ignore would invite somebody to make it obey one.
 */
export interface RecipeSort {
  readonly id: string;
  readonly label: string;
  /** Ties are broken by name in `sortRecipes`, so this need not be total. */
  readonly compare: (
    a: Recipe,
    b: Recipe,
    ingredients: ReadonlyMap<Id, Ingredient>,
  ) => number;
}

function totalMinutes(recipe: Recipe): number {
  return recipe.prepMinutes + recipe.cookMinutes;
}

export const RECIPE_SORTS: readonly RecipeSort[] = [
  { id: 'name', label: 'A to Z', compare: () => 0 },
  { id: 'quickest', label: 'Quickest first', compare: (a, b) => totalMinutes(a) - totalMinutes(b) },
  {
    id: 'simplest',
    label: 'Fewest ingredients',
    compare: (a, b) => a.ingredients.length - b.ingredients.length,
  },
  {
    id: 'protein',
    label: 'Most protein',
    // Recipes whose ingredients carry too little nutrition data to add up are
    // sorted as zero rather than dropped. A sort is not a filter, and a recipe
    // that vanishes when you change the order looks like a bug.
    compare: (a, b, ingredients) =>
      proteinFor(b, ingredients) - proteinFor(a, ingredients),
  },
];

function proteinFor(recipe: Recipe, ingredients: ReadonlyMap<Id, Ingredient>): number {
  const n = recipeNutrition(recipe, ingredients);
  return n.coverage > 0.7 ? n.proteinG : 0;
}

export const DEFAULT_SORT_ID = RECIPE_SORTS[0].id;

/**
 * Orders a list of recipes, breaking every tie by name.
 *
 * The tiebreak is the point. Half the library shares a cooking time and a third
 * of it shares an ingredient count, so without it the order within a tie is
 * whatever the database handed back — which changes when anything is imported,
 * and makes a list appear to reshuffle itself for no reason.
 */
export function sortRecipes(
  recipes: readonly Recipe[],
  sortId: string,
  ingredients: ReadonlyMap<Id, Ingredient>,
): Recipe[] {
  const sort = RECIPE_SORTS.find((s) => s.id === sortId) ?? RECIPE_SORTS[0];
  return [...recipes].sort(
    (a, b) => sort.compare(a, b, ingredients) || a.name.localeCompare(b.name),
  );
}
