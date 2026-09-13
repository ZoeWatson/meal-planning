/**
 * Export: the library back out in the exact format the importer accepts.
 *
 * Two jobs, both load-bearing:
 *
 * 1. **Round trip.** Export → edit in a text editor → re-import is the only
 *    practical way to bulk-fix a few hundred ingredients. Doing that surgery in a
 *    phone UI would be miserable.
 *
 * 2. **Backup.** There is no sync yet, so an export file is currently the only
 *    thing standing between a cleared browser storage and starting over.
 *
 * The round trip is verified by a test rather than assumed: exporting something
 * that does not re-import cleanly would be worse than having no export at all,
 * because it looks like a backup right up until you need it.
 */

import type { Ingredient, Recipe } from '../types';
import type { ImportBundle, RawIngredient, RawRecipe } from './importer';

/** Drops undefined entries so exported JSON stays readable rather than full of nulls. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}

export function ingredientToRaw(ing: Ingredient): RawIngredient {
  return compact({
    id: ing.id,
    name: ing.name,
    aliases: ing.aliases.length > 0 ? [...ing.aliases] : undefined,
    category: ing.category,
    gramsPerMl: ing.gramsPerMl,
    countUnits: ing.countUnits ? { ...ing.countUnits } : undefined,
    displayAs: ing.displayAs,
    countUnit: ing.countUnit,
    purchase: { ...ing.purchase },
    shelfLifeDays: ing.shelfLifeDays,
    carryOver: ing.carryOver,
    backgroundUseGramsPerWeek: ing.backgroundUseGramsPerWeek,
    wasteRisk: ing.wasteRisk,
    seasonMonths: ing.seasonMonths ? [...ing.seasonMonths] : undefined,
    excludesDiets: ing.excludesDiets ? [...ing.excludesDiets] : undefined,
    allergens: ing.allergens ? [...ing.allergens] : undefined,
    allergensVerified: ing.allergensVerified,
    nutritionPer100g: ing.nutritionPer100g ? { ...ing.nutritionPer100g } : undefined,
  } as RawIngredient);
}

export function recipeToRaw(recipe: Recipe): RawRecipe {
  return compact({
    id: recipe.id,
    name: recipe.name,
    mealType: recipe.mealType,
    baseServings: recipe.baseServings,
    ingredients: recipe.ingredients.map((ri) =>
      compact({
        // Exported structured, never as `raw`: these quantities have already been
        // resolved and re-parsing prose on the way back in would be a needless
        // opportunity to lose them.
        item: ri.ingredientId,
        quantity: ri.quantity,
        unit: ri.unit,
        prep: ri.prep,
        optional: ri.optional || undefined,
        scaling: ri.scaling,
      }),
    ),
    steps: [...recipe.steps],
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    tags: recipe.tags.length > 0 ? [...recipe.tags] : undefined,
    primaryProtein: recipe.primaryProtein,
    variantOf: recipe.variantOf,
    variantLabel: recipe.variantLabel,
    diets: recipe.diets.length > 0 ? [...recipe.diets] : undefined,
    source: recipe.source ? { ...recipe.source } : undefined,
  } as RawRecipe);
}

export function toBundle(
  ingredients: readonly Ingredient[],
  recipes: readonly Recipe[],
): ImportBundle {
  return {
    ingredients: ingredients.map(ingredientToRaw),
    recipes: recipes.map(recipeToRaw),
  };
}

export function toJson(
  ingredients: readonly Ingredient[],
  recipes: readonly Recipe[],
): string {
  return JSON.stringify(toBundle(ingredients, recipes), null, 2);
}
