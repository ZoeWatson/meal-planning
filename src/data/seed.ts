/**
 * Seed library loader.
 *
 * The seed data is authored in the *import format* and goes through the *real
 * importer* rather than being hand-written as `Ingredient` / `Recipe` objects.
 *
 * That is deliberate. It means the format documented in `docs/import-format.md`
 * is exercised on every startup, so it cannot quietly rot away from the code that
 * consumes it — and any bulk pipeline written later is targeting a format already
 * proven to work end to end.
 */

import { type ImportResult, type RawIngredient, type RawRecipe, importBundle } from '../domain/import/importer';
import rawIngredients from './seed-ingredients.json';
import rawRecipes from './seed-recipes.json';

let cached: ImportResult | null = null;

export function loadSeedData(): ImportResult {
  if (cached) return cached;
  cached = importBundle(
    {
      ingredients: rawIngredients as unknown as RawIngredient[],
      recipes: rawRecipes as unknown as RawRecipe[],
    },
    [],
    { builtIn: true },
  );
  return cached;
}
