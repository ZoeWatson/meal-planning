/**
 * Recipe nutrition, computed from ingredients.
 *
 * "High protein" has to be *derived*, not a tag. Tags on a 500-recipe library are
 * only as good as whoever remembered to write them, and an unlabelled recipe is
 * indistinguishable from a labelled-false one — so a tag-based protein filter
 * silently hides most of the library. Summing macros from the ingredients is
 * approximate, but it is approximate in a consistent and inspectable way, and it
 * works on every recipe including ones you imported yourself.
 *
 * Accuracy caveat: this is raw-ingredient nutrition. It ignores moisture loss
 * during cooking, fat rendered off and discarded, and oil left in the pan. For
 * ranking and filtering that is fine. It is not a nutrition label.
 */

import { type Ingredient, type NutritionFacts, type Recipe, scaledGrams } from './types';

export type { NutritionFacts };

/** Per-serving nutrition, plus the coverage figure needed to know whether to trust it. */
export interface RecipeNutrition extends NutritionFacts {
  /**
   * Fraction of the recipe's mass that had nutrition data (0..1).
   * Below ~0.8 the numbers are guesses — the UI should say so rather than print
   * a confident wrong figure.
   */
  readonly coverage: number;
  /** Share of calories from protein. The more meaningful "high protein" measure. */
  readonly proteinRatio: number;
}

const EMPTY: RecipeNutrition = {
  kcal: 0, proteinG: 0, carbG: 0, fatG: 0, fibreG: 0, coverage: 0, proteinRatio: 0,
};

/** Per-serving nutrition for a recipe at its base serving count. */
export function recipeNutrition(
  recipe: Recipe,
  ingredients: ReadonlyMap<string, Ingredient>,
  servings: number = recipe.baseServings,
): RecipeNutrition {
  let kcal = 0, proteinG = 0, carbG = 0, fatG = 0, fibreG = 0;
  let totalGrams = 0, coveredGrams = 0;

  for (const ri of recipe.ingredients) {
    if (ri.optional) continue;
    const ing = ingredients.get(ri.ingredientId);
    if (!ing) continue;

    const grams = scaledGrams(ri, servings, recipe.baseServings);
    totalGrams += grams;

    const n = ing.nutritionPer100g;
    if (!n) continue;

    coveredGrams += grams;
    const factor = grams / 100;
    kcal += n.kcal * factor;
    proteinG += n.proteinG * factor;
    carbG += n.carbG * factor;
    fatG += n.fatG * factor;
    fibreG += (n.fibreG ?? 0) * factor;
  }

  if (totalGrams === 0) return EMPTY;

  const perServing = <T extends number>(v: T): number => v / servings;
  const servingKcal = perServing(kcal);

  return {
    kcal: servingKcal,
    proteinG: perServing(proteinG),
    carbG: perServing(carbG),
    fatG: perServing(fatG),
    fibreG: perServing(fibreG),
    coverage: coveredGrams / totalGrams,
    // 4 kcal per gram of protein.
    proteinRatio: servingKcal > 0 ? (perServing(proteinG) * 4) / servingKcal : 0,
  };
}

/**
 * Conventional "high protein" threshold: at least 20 g per serving AND at least a
 * quarter of calories from protein. Both are needed — the gram threshold alone
 * passes an enormous plate of pasta, and the ratio alone passes a lettuce leaf.
 */
export const HIGH_PROTEIN_MIN_GRAMS = 20;
export const HIGH_PROTEIN_MIN_RATIO = 0.25;

export function isHighProtein(n: RecipeNutrition): boolean {
  return n.proteinG >= HIGH_PROTEIN_MIN_GRAMS && n.proteinRatio >= HIGH_PROTEIN_MIN_RATIO;
}

/**
 * Diets a recipe satisfies, derived from what its ingredients rule out.
 *
 * Derivation beats authored tags for the same reason as protein: it is uniform
 * across the library and cannot be forgotten. Authored diets are unioned in for
 * claims that cannot be derived from ingredients alone (certified gluten-free
 * processing, halal, kosher).
 */
export const DERIVABLE_DIETS: readonly string[] = [
  'vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'nut-free', 'pescatarian',
];

export function deriveDiets(
  recipeIngredients: readonly { ingredientId: string; optional: boolean }[],
  ingredients: ReadonlyMap<string, Ingredient>,
): string[] {
  const excluded = new Set<string>();
  let sawUnknown = false;

  for (const ri of recipeIngredients) {
    if (ri.optional) continue;
    const ing = ingredients.get(ri.ingredientId);
    if (!ing) { sawUnknown = true; continue; }
    for (const diet of ing.excludesDiets ?? []) excluded.add(diet);
  }

  // An unresolvable ingredient means we cannot certify anything.
  if (sawUnknown) return [];

  return DERIVABLE_DIETS.filter((diet) => !excluded.has(diet));
}
