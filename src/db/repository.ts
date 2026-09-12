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
import { syncedBulkPut, syncedDelete, syncedPut } from './syncWrites';
import type { BarcodeEntry, CustomItem, Expense } from '../domain/budget';
import {
  addDays, estimateKeeping, localDate,
  type CookedMeal, type Leftover, type MealLogEntry, type MealSource, type StorageKind,
} from '../domain/cooking';
import type { Ingredient, MealType, Recipe } from '../domain/types';
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

  // Defaults are merged UNDER the stored row rather than used only as a fallback.
  // A settings row written before a field existed simply lacks it, and returning
  // it raw hands `undefined` to code expecting a number — which is how a missing
  // budget became `$NaN` on screen rather than an unset goal. Merging means every
  // field added from now on gets its default on existing installs for free.
  return { ...DEFAULT_SETTINGS, ...stored, id: 'settings' };
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  const current = await getSettings();
  // The changed keys are passed through so settings merge per field: changing the
  // region on the laptop must not discard a unit-system change made on the phone.
  await syncedPut('settings', { ...current, ...patch, id: 'settings' }, Object.keys(patch));
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function savePlan(plan: WeekPlan, makeActive = true): Promise<void> {
  await syncedPut('plans', plan as unknown as Record<string, unknown>);
  if (makeActive) await updateSettings({ activePlanId: plan.id });
}

export async function getActivePlan(): Promise<WeekPlan | undefined> {
  const settings = await getSettings();
  if (!settings.activePlanId) return undefined;
  return db.plans.get(settings.activePlanId);
}

/** Applies an edit to a plan and queues the whole plan for sync. */
async function editPlan(planId: Id, edit: (plan: WeekPlan) => WeekPlan): Promise<void> {
  const plan = await db.plans.get(planId);
  if (!plan) return;
  await syncedPut('plans', edit(plan) as unknown as Record<string, unknown>);
}

/** Toggles a slot's pin. Pinned slots survive regeneration untouched. */
export async function setSlotPinned(planId: Id, slotId: Id, pinned: boolean): Promise<void> {
  await editPlan(planId, (plan) => ({
    ...plan,
    slots: plan.slots.map((s) => (s.id === slotId ? { ...s, pinned } : s)),
  }));
}

export async function setSlotServings(planId: Id, slotId: Id, servings: number): Promise<void> {
  await editPlan(planId, (plan) => ({
    ...plan,
    slots: plan.slots.map((s) => (s.id === slotId ? { ...s, servings: Math.max(1, servings) } : s)),
  }));
}

export async function setSlotRecipe(planId: Id, slotId: Id, recipeId: Id | null): Promise<void> {
  await editPlan(planId, (plan) => ({
    ...plan,
    slots: plan.slots.map((s) => (s.id === slotId ? { ...s, recipeId } : s)),
  }));
}

export async function setWildcardPromoted(planId: Id, ingredientId: Id, promoted: boolean): Promise<void> {
  await editPlan(planId, (plan) => ({
    ...plan,
    wildcards: plan.wildcards.map((w) =>
      w.ingredientId === ingredientId ? { ...w, promoted } : w),
  }));
}

export async function removeWildcard(planId: Id, ingredientId: Id): Promise<void> {
  await editPlan(planId, (plan) => ({
    ...plan,
    wildcards: plan.wildcards.filter((w) => w.ingredientId !== ingredientId),
  }));
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
  await syncedPut('checks', entry as unknown as Record<string, unknown>);
}

export async function clearChecks(planId: Id): Promise<void> {
  const keys = await db.checks.where('planId').equals(planId).primaryKeys();
  // Deleted one at a time so each gets its own tombstone. Without those, the other
  // device's next sync would simply re-upload its copies and every box would tick
  // itself again.
  for (const key of keys) await syncedDelete('checks', key);
}

// ---------------------------------------------------------------------------
// Staples, pantry, sales, carry-over
// ---------------------------------------------------------------------------

export async function upsertStaple(item: StapleItem): Promise<void> {
  await syncedPut('staples', item as unknown as Record<string, unknown>);
}

export async function removeStaple(ingredientId: Id): Promise<void> {
  await syncedDelete('staples', ingredientId);
}

export async function upsertPantryItem(item: PantryItem): Promise<void> {
  await syncedPut('pantry', item as unknown as Record<string, unknown>);
}

export async function removePantryItem(ingredientId: Id): Promise<void> {
  await syncedDelete('pantry', ingredientId);
}

export async function cyclePantryStatus(ingredientId: Id): Promise<void> {
  const item = await db.pantry.get(ingredientId);
  if (!item) return;
  const next: PantryItem['status'] =
    item.status === 'stocked' ? 'low' : item.status === 'low' ? 'out' : 'stocked';

  await syncedPut('pantry', {
    ...item,
    status: next,
    // Returning to stocked means it was just bought — reset the "probably low?" counter.
    ...(next === 'stocked'
      ? { lastPurchasedISO: new Date().toISOString(), usesSincePurchase: 0 }
      : {}),
  });
}

export async function upsertSale(sale: SalePrice): Promise<void> {
  await syncedPut('sales', sale as unknown as Record<string, unknown>);
}

export async function removeSale(ingredientId: Id): Promise<void> {
  await syncedDelete('sales', ingredientId);
}

export async function setCarryOver(ingredientId: Id, grams: number): Promise<void> {
  if (grams <= 0) {
    await syncedDelete('carryOver', ingredientId);
    return;
  }
  await syncedPut('carryOver', { ingredientId, grams, updatedAtISO: new Date().toISOString() });
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
  for (const entry of entries) {
    const existing = await db.carryOver.get(entry.ingredientId);
    await setCarryOver(entry.ingredientId, (existing?.grams ?? 0) + entry.grams);
  }
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function addExpense(
  input: Omit<Expense, 'id' | 'createdAtISO'> & { id?: Id },
): Promise<Expense> {
  const expense: Expense = {
    ...input,
    id: input.id ?? newId('exp'),
    createdAtISO: new Date().toISOString(),
  };
  await syncedPut('expenses', expense as unknown as Record<string, unknown>);
  return expense;
}

export async function updateExpense(id: Id, patch: Partial<Expense>): Promise<void> {
  const existing = await db.expenses.get(id);
  if (!existing) return;
  await syncedPut('expenses', { ...existing, ...patch, id } as unknown as Record<string, unknown>);
}

export async function removeExpense(id: Id): Promise<void> {
  await syncedDelete('expenses', id);
}

/**
 * Records what a shop actually cost.
 *
 * `planId` is kept so estimated and actual can be compared later — the only
 * feedback available on how wrong the per-kilo price guesses are.
 */
export async function recordShopTotal(
  planId: Id,
  amountCents: number,
  label: string,
  dateISO: string,
): Promise<Expense> {
  return addExpense({ kind: 'groceries', planId, amountCents, label, dateISO });
}

// --- per-line prices --------------------------------------------------------

/**
 * Sets what one planned line cost.
 *
 * Upserts the check record, because a price can be entered for a line that has
 * not been ticked yet — you scan the shelf, then put it in the basket.
 */
export async function setLinePrice(
  planId: Id,
  ingredientId: Id,
  amountCents: number | null,
): Promise<void> {
  const id = checkId(planId, ingredientId);
  const existing = await db.checks.get(id);

  await syncedPut('checks', {
    id,
    planId,
    ingredientId,
    checked: existing?.checked ?? false,
    ...(amountCents === null ? {} : { amountCents }),
    updatedAtISO: new Date().toISOString(),
  });
}

// --- ad-hoc items -----------------------------------------------------------

export async function addCustomItem(
  input: Omit<CustomItem, 'id' | 'updatedAtISO'> & { id?: Id },
): Promise<CustomItem> {
  const item: CustomItem = {
    ...input,
    id: input.id ?? newId('item'),
    updatedAtISO: new Date().toISOString(),
  };
  await syncedPut('customItems', item as unknown as Record<string, unknown>);
  return item;
}

export async function updateCustomItem(id: Id, patch: Partial<CustomItem>): Promise<void> {
  const existing = await db.customItems.get(id);
  if (!existing) return;
  await syncedPut('customItems', {
    ...existing, ...patch, id, updatedAtISO: new Date().toISOString(),
  } as unknown as Record<string, unknown>);
}

export async function removeCustomItem(id: Id): Promise<void> {
  await syncedDelete('customItems', id);
}

// --- barcodes ---------------------------------------------------------------

/** What a scanned barcode turned out to be. Learned once, reused forever. */
export async function rememberBarcode(entry: Omit<BarcodeEntry, 'updatedAtISO'>): Promise<void> {
  await syncedPut('barcodes', {
    ...entry, updatedAtISO: new Date().toISOString(),
  } as unknown as Record<string, unknown>);
}

export async function lookupBarcode(barcode: string): Promise<BarcodeEntry | undefined> {
  return db.barcodes.get(barcode);
}

// ---------------------------------------------------------------------------
// Cooking
// ---------------------------------------------------------------------------

/**
 * Records a cooking session, banking any leftovers and logging one serving eaten.
 *
 * All three in one call because they are one real-world event. Splitting them
 * across separate user actions would mean the common case — cooked it, ate some,
 * fridged the rest — takes three taps and gets abandoned halfway, leaving the
 * data in a state that never happened.
 */
export async function recordCooked(input: {
  recipe: Recipe;
  ingredients: ReadonlyMap<Id, Ingredient>;
  servingsMade: number;
  servingsEaten: number;
  storage: StorageKind;
  slotId?: Id;
  planId?: Id;
  notes?: string;
  dateISO?: string;
}): Promise<{ cooked: CookedMeal; leftover: Leftover | null }> {
  const dateISO = input.dateISO ?? localDate();
  const cooked: CookedMeal = {
    id: newId('cook'),
    recipeId: input.recipe.id,
    recipeName: input.recipe.name,
    slotId: input.slotId,
    planId: input.planId,
    cookedAtISO: new Date().toISOString(),
    servingsMade: input.servingsMade,
    notes: input.notes,
  };
  await syncedPut('cookedMeals', cooked as unknown as Record<string, unknown>);

  if (input.servingsEaten > 0) {
    await logMeal({
      dateISO,
      mealType: input.recipe.mealType,
      source: 'cooked',
      label: input.recipe.name,
      servings: input.servingsEaten,
      recipeId: input.recipe.id,
      cookedMealId: cooked.id,
    });
  }

  const remaining = input.servingsMade - input.servingsEaten;
  if (remaining <= 0) return { cooked, leftover: null };

  // The keeping window is computed once and stored, not recomputed on read: it
  // depends on when the dish went in the fridge, and a recipe edited later must
  // not silently move the use-by date on food already sitting there.
  const keeping = estimateKeeping(input.recipe, input.ingredients, input.storage);
  const leftover: Leftover = {
    id: newId('left'),
    cookedMealId: cooked.id,
    recipeId: input.recipe.id,
    label: input.recipe.name,
    servingsRemaining: remaining,
    storedAtISO: dateISO,
    storage: input.storage,
    useByISO: addDays(dateISO, keeping.days),
  };
  await syncedPut('leftovers', leftover as unknown as Record<string, unknown>);

  return { cooked, leftover };
}

/** Eats from a leftover, logging it and closing the record when it runs out. */
export async function eatLeftover(
  leftoverId: Id,
  servings: number,
  mealType: MealType | 'other' = 'other',
): Promise<void> {
  const leftover = await db.leftovers.get(leftoverId);
  if (!leftover) return;

  const taken = Math.min(servings, leftover.servingsRemaining);
  const remaining = leftover.servingsRemaining - taken;

  await syncedPut('leftovers', {
    ...leftover,
    servingsRemaining: remaining,
    ...(remaining === 0 ? { closedAtISO: new Date().toISOString() } : {}),
  } as unknown as Record<string, unknown>);

  await logMeal({
    dateISO: localDate(),
    mealType,
    source: 'leftover',
    label: leftover.label,
    servings: taken,
    recipeId: leftover.recipeId,
    leftoverId: leftover.id,
  });
}

/**
 * Closes a leftover without logging it as eaten.
 *
 * Kept distinct from eating it: food thrown away is not food consumed, and
 * conflating the two would quietly overstate what the household actually ate.
 */
export async function discardLeftover(leftoverId: Id): Promise<void> {
  const leftover = await db.leftovers.get(leftoverId);
  if (!leftover) return;
  await syncedPut('leftovers', {
    ...leftover, closedAtISO: new Date().toISOString(), discarded: true,
  } as unknown as Record<string, unknown>);
}

export async function updateLeftover(id: Id, patch: Partial<Leftover>): Promise<void> {
  const existing = await db.leftovers.get(id);
  if (!existing) return;
  await syncedPut('leftovers', { ...existing, ...patch, id } as unknown as Record<string, unknown>);
}

// --- meal log ---------------------------------------------------------------

export async function logMeal(
  input: Omit<MealLogEntry, 'id' | 'createdAtISO'> & { id?: Id },
): Promise<MealLogEntry> {
  const entry: MealLogEntry = {
    ...input,
    id: input.id ?? newId('meal'),
    createdAtISO: new Date().toISOString(),
  };
  await syncedPut('mealLog', entry as unknown as Record<string, unknown>);
  return entry;
}

export async function removeMealLogEntry(id: Id): Promise<void> {
  await syncedDelete('mealLog', id);
}

/**
 * Logs a meal out, optionally recording what it cost.
 *
 * One action, because eating out is one event — logging the meal and then
 * separately remembering to add the spend is how the budget quietly drifts from
 * reality.
 */
export async function logMealOut(input: {
  label: string;
  servings: number;
  mealType: MealType | 'other';
  dateISO: string;
  amountCents?: number;
  source?: MealSource;
}): Promise<void> {
  let expenseId: Id | undefined;

  if (input.amountCents !== undefined && input.amountCents > 0) {
    const expense = await addExpense({
      kind: 'dining',
      dateISO: input.dateISO,
      amountCents: input.amountCents,
      label: input.label,
    });
    expenseId = expense.id;
  }

  await logMeal({
    dateISO: input.dateISO,
    mealType: input.mealType,
    source: input.source ?? 'out',
    label: input.label,
    servings: input.servings,
    expenseId,
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
  // Through the synced path, so an import on the laptop reaches the phone. Built-in
  // library rows are seeded separately and stay device-local.
  await syncedBulkPut('ingredients', result.ingredients as unknown as Record<string, unknown>[]);
  await syncedBulkPut('recipes', result.recipes as unknown as Record<string, unknown>[]);
  return { ingredients: result.ingredients.length, recipes: result.recipes.length };
}

/**
 * Writes ingredient records that capture had to CHANGE rather than create.
 *
 * The case this exists for: a recipe says "1 can coconut milk", the ingredient
 * already exists, and it simply has no `can` weight. The fix is a `countUnits`
 * entry on the record that is already there — emphatically not a second
 * "canned coconut milk" ingredient, which would split the dictionary in two and
 * make the optimizer treat one food as two that never overlap.
 *
 * Separate from `commitImport` because that one only ever writes new records,
 * and conflating the two would let an import quietly overwrite an ingredient a
 * user had corrected by hand.
 */
export async function updateIngredients(ingredients: readonly Ingredient[]): Promise<void> {
  if (ingredients.length === 0) return;
  await syncedBulkPut('ingredients', ingredients as unknown as Record<string, unknown>[]);
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
