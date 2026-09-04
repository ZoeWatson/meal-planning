/**
 * Persistence operations.
 *
 * Everything here is a plain async function against Dexie. Components never touch
 * the database directly — they read through `useLiveQuery` and write through
 * these, so there is exactly one place where writes happen and exactly one place
 * a sync layer will need to hook into later.
 */

import { db, DEFAULT_SETTINGS, SEED_VERSION, type AppSettings, type GroceryCheck } from './database';
import { loadSeedData } from '../data/seed';
import { importBundle, type ImportBundle, type ImportResult } from '../domain/import/importer';
import { toJson } from '../domain/import/export';
import type {
  Id, PantryItem, SalePrice, StapleItem, WeekPlan,
} from '../domain/types';

/**
 * Loads the built-in library on first run.
 *
 * Only built-in recipes are replaced on a version bump — anything the user
 * imported themselves survives, which is the whole reason `builtIn` exists on the
 * recipe type.
 */
export async function ensureSeeded(): Promise<void> {
  const existing = await db.settings.get('settings');

  if (existing && existing.seedVersion >= SEED_VERSION) return;

  const seed = loadSeedData();

  if (!seed.ok) {
    // Loud, because a broken built-in library is a build error, not a user problem.
    console.error('Seed library failed to import cleanly', seed.rejected, seed.issues);
  }

  await db.transaction('rw', db.ingredients, db.recipes, db.settings, async () => {
    await db.ingredients.bulkPut(seed.ingredients);

    const staleBuiltIns = await db.recipes.filter((r) => r.builtIn).primaryKeys();
    await db.recipes.bulkDelete(staleBuiltIns);
    await db.recipes.bulkPut(seed.recipes);

    await db.settings.put({
      ...DEFAULT_SETTINGS,
      ...existing,
      id: 'settings',
      seedVersion: SEED_VERSION,
    });
  });
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await db.settings.get('settings');
  return stored ?? { ...DEFAULT_SETTINGS, id: 'settings' };
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  const current = await getSettings();
  await db.settings.put({ ...current, ...patch, id: 'settings' });
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function savePlan(plan: WeekPlan, makeActive = true): Promise<void> {
  await db.transaction('rw', db.plans, db.settings, async () => {
    await db.plans.put(plan);
    if (makeActive) {
      const current = await getSettings();
      await db.settings.put({ ...current, id: 'settings', activePlanId: plan.id });
    }
  });
}

export async function getActivePlan(): Promise<WeekPlan | undefined> {
  const settings = await getSettings();
  if (!settings.activePlanId) return undefined;
  return db.plans.get(settings.activePlanId);
}

/** Toggles a slot's pin. Pinned slots survive regeneration untouched. */
export async function setSlotPinned(planId: Id, slotId: Id, pinned: boolean): Promise<void> {
  const plan = await db.plans.get(planId);
  if (!plan) return;
  await db.plans.put({
    ...plan,
    slots: plan.slots.map((s) => (s.id === slotId ? { ...s, pinned } : s)),
  });
}

export async function setSlotServings(planId: Id, slotId: Id, servings: number): Promise<void> {
  const plan = await db.plans.get(planId);
  if (!plan) return;
  await db.plans.put({
    ...plan,
    slots: plan.slots.map((s) => (s.id === slotId ? { ...s, servings: Math.max(1, servings) } : s)),
  });
}

export async function setSlotRecipe(planId: Id, slotId: Id, recipeId: Id | null): Promise<void> {
  const plan = await db.plans.get(planId);
  if (!plan) return;
  await db.plans.put({
    ...plan,
    slots: plan.slots.map((s) => (s.id === slotId ? { ...s, recipeId } : s)),
  });
}

export async function setWildcardPromoted(planId: Id, ingredientId: Id, promoted: boolean): Promise<void> {
  const plan = await db.plans.get(planId);
  if (!plan) return;
  await db.plans.put({
    ...plan,
    wildcards: plan.wildcards.map((w) =>
      w.ingredientId === ingredientId ? { ...w, promoted } : w),
  });
}

export async function removeWildcard(planId: Id, ingredientId: Id): Promise<void> {
  const plan = await db.plans.get(planId);
  if (!plan) return;
  await db.plans.put({
    ...plan,
    wildcards: plan.wildcards.filter((w) => w.ingredientId !== ingredientId),
  });
}

// ---------------------------------------------------------------------------
// Grocery checks
// ---------------------------------------------------------------------------

export function checkId(planId: Id, ingredientId: Id): string {
  return `${planId}:${ingredientId}`;
}

export async function setChecked(planId: Id, ingredientId: Id, checked: boolean): Promise<void> {
  const entry: GroceryCheck = {
    id: checkId(planId, ingredientId),
    planId,
    ingredientId,
    checked,
    updatedAtISO: new Date().toISOString(),
  };
  await db.checks.put(entry);
}

export async function clearChecks(planId: Id): Promise<void> {
  const keys = await db.checks.where('planId').equals(planId).primaryKeys();
  await db.checks.bulkDelete(keys);
}

// ---------------------------------------------------------------------------
// Staples, pantry, sales, carry-over
// ---------------------------------------------------------------------------

export async function upsertStaple(item: StapleItem): Promise<void> {
  await db.staples.put(item);
}

export async function removeStaple(ingredientId: Id): Promise<void> {
  await db.staples.delete(ingredientId);
}

export async function upsertPantryItem(item: PantryItem): Promise<void> {
  await db.pantry.put(item);
}

export async function removePantryItem(ingredientId: Id): Promise<void> {
  await db.pantry.delete(ingredientId);
}

export async function cyclePantryStatus(ingredientId: Id): Promise<void> {
  const item = await db.pantry.get(ingredientId);
  if (!item) return;
  const next: PantryItem['status'] =
    item.status === 'stocked' ? 'low' : item.status === 'low' ? 'out' : 'stocked';

  await db.pantry.put({
    ...item,
    status: next,
    // Returning to stocked means it was just bought — reset the "probably low?" counter.
    ...(next === 'stocked'
      ? { lastPurchasedISO: new Date().toISOString(), usesSincePurchase: 0 }
      : {}),
  });
}

export async function upsertSale(sale: SalePrice): Promise<void> {
  await db.sales.put(sale);
}

export async function removeSale(ingredientId: Id): Promise<void> {
  await db.sales.delete(ingredientId);
}

export async function setCarryOver(ingredientId: Id, grams: number): Promise<void> {
  if (grams <= 0) {
    await db.carryOver.delete(ingredientId);
    return;
  }
  await db.carryOver.put({ ingredientId, grams, updatedAtISO: new Date().toISOString() });
}

/**
 * Records what a completed shop leaves in the cupboard.
 *
 * Called when a week is finished: pantry-stable surplus becomes next week's
 * carry-over, so buying the 1 kg bag genuinely stops counting against you.
 */
export async function recordCarryOverFromPlan(
  entries: ReadonlyArray<{ ingredientId: Id; grams: number }>,
): Promise<void> {
  await db.transaction('rw', db.carryOver, async () => {
    for (const entry of entries) {
      const existing = await db.carryOver.get(entry.ingredientId);
      const grams = (existing?.grams ?? 0) + entry.grams;
      await db.carryOver.put({
        ingredientId: entry.ingredientId,
        grams,
        updatedAtISO: new Date().toISOString(),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Library import / export
// ---------------------------------------------------------------------------

/**
 * Validates a bundle against the ingredients already on the device, without
 * writing anything.
 *
 * Separated from committing so the UI can show what will happen before it
 * happens. Importing a few hundred recipes is not something to discover you got
 * wrong afterwards.
 */
export async function dryRunImport(bundle: ImportBundle): Promise<ImportResult> {
  const existing = await db.ingredients.toArray();
  return importBundle(bundle, existing, { builtIn: false });
}

/**
 * Writes a validated import.
 *
 * Recipes that failed validation are already absent from `result` — this only
 * ever writes what the importer accepted, so a partial import is a set of whole
 * recipes rather than whole recipes with holes in them.
 */
export async function commitImport(result: ImportResult): Promise<{ ingredients: number; recipes: number }> {
  await db.transaction('rw', db.ingredients, db.recipes, async () => {
    if (result.ingredients.length > 0) await db.ingredients.bulkPut(result.ingredients);
    if (result.recipes.length > 0) await db.recipes.bulkPut(result.recipes);
  });
  return { ingredients: result.ingredients.length, recipes: result.recipes.length };
}

/**
 * The whole library as an import bundle.
 *
 * Doubles as the only backup there is until sync exists, which is why the round
 * trip is covered by a test rather than assumed — an export that does not
 * re-import looks like a backup right up until you need it.
 */
export async function exportLibrary(): Promise<string> {
  const [ingredients, recipes] = await Promise.all([
    db.ingredients.toArray(),
    db.recipes.toArray(),
  ]);
  return toJson(ingredients, recipes);
}

/** Wipes everything and re-seeds. Exposed in Settings as a recovery path. */
export async function resetAll(): Promise<void> {
  await db.delete();
  await db.open();
  await ensureSeeded();
}
