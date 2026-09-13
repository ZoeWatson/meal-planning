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
import { DEFAULT_NECESSITY, afterStockChange } from '../domain/pantry';
import { dropSlot, placeRecipe, reinstateSlot } from '../domain/planner/generate';
import type { TreatItem } from '../domain/treats';
import type { Ingredient, MealType, Recipe } from '../domain/types';
import type {
  Id, PantryItem, PantryNecessity, PantryStock, PlanSlot, SalePrice, StapleItem, WeekPlan,
  WildcardItem,
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

/**
 * Adds a recipe to the week by hand, straight from the library.
 *
 * Where it lands is `placeRecipe`'s decision, made next to the code that builds
 * slots in the first place; this is only the write.
 */
export async function addRecipeToPlan(
  planId: Id,
  recipe: Pick<Recipe, 'id' | 'mealType'>,
  servings: number,
): Promise<void> {
  await editPlan(planId, (plan) => ({
    ...plan,
    slots: placeRecipe(plan.slots, recipe, servings),
  }));
}

/**
 * Takes a meal out of the week.
 *
 * The inverse of `addRecipeToPlan`, and it shortens the week rather than leaving
 * a hole in it — `dropSlot` is where that choice is argued.
 */
export async function removeSlot(planId: Id, slotId: Id): Promise<void> {
  await editPlan(planId, (plan) => ({ ...plan, slots: dropSlot(plan.slots, slotId) }));
}

/**
 * Puts a removed meal back. What Undo on the week screen calls.
 *
 * The slot travels in from the screen rather than being read back out of
 * anything: it is no longer in the plan, which is the point, and the week screen
 * is the only thing that still has a copy.
 */
export async function restoreSlot(planId: Id, slot: PlanSlot, index: number): Promise<void> {
  await editPlan(planId, (plan) => ({ ...plan, slots: reinstateSlot(plan.slots, slot, index) }));
}

/**
 * Replaces the week's meals wholesale. Used by the per-section regenerate, which
 * rewrites one meal type and hands back the rest of the week unchanged.
 *
 * In place rather than as a new plan, unlike Regenerate. A new plan id would
 * untick the whole shopping list and push the week just replaced into the repeat
 * history, and "give me different snacks" asked for neither.
 */
export async function setSlots(planId: Id, slots: readonly PlanSlot[]): Promise<void> {
  await editPlan(planId, (plan) => ({ ...plan, slots }));
}

export async function setWildcardPromoted(planId: Id, ingredientId: Id, promoted: boolean): Promise<void> {
  await editPlan(planId, (plan) => ({
    ...plan,
    wildcards: plan.wildcards.map((w) =>
      w.ingredientId === ingredientId ? { ...w, promoted } : w),
  }));
}

/** Replaces the whole grab bag. Used by the redraw and by the size controls. */
export async function setWildcards(planId: Id, wildcards: readonly WildcardItem[]): Promise<void> {
  await editPlan(planId, (plan) => ({ ...plan, wildcards }));
}

export async function removeWildcard(planId: Id, ingredientId: Id): Promise<void> {
  await editPlan(planId, (plan) => ({
    ...plan,
    wildcards: plan.wildcards.filter((w) => w.ingredientId !== ingredientId),
  }));
}

// --- the treat bag ----------------------------------------------------------
// `plan.treats ?? []` throughout: plans written before the treat bag existed
// have no such field, and a plan is a stored document rather than a row with a
// schema, so nothing backfills it.

/** Keeps a treat through the next redraw. The treat equivalent of pinning a meal. */
export async function setTreatPinned(planId: Id, treatId: string, pinned: boolean): Promise<void> {
  await editPlan(planId, (plan) => ({
    ...plan,
    treats: (plan.treats ?? []).map((t) => (t.treatId === treatId ? { ...t, pinned } : t)),
  }));
}

/** Replaces the whole treat bag. Used by the redraw and by the size control. */
export async function setTreats(planId: Id, treats: readonly TreatItem[]): Promise<void> {
  await editPlan(planId, (plan) => ({ ...plan, treats }));
}

export async function removeTreat(planId: Id, treatId: string): Promise<void> {
  await editPlan(planId, (plan) => ({
    ...plan,
    treats: (plan.treats ?? []).filter((t) => t.treatId !== treatId),
  }));
}

// ---------------------------------------------------------------------------
// Grocery checks
// ---------------------------------------------------------------------------

export function checkId(planId: Id, ingredientId: Id): string {
  return `${planId}:${ingredientId}`;
}

/**
 * Writes one line's state, leaving the rest of the record alone.
 *
 * Read-modify-write, and every write to this table goes through it. Ticking a
 * line, pricing it and taking it off the list are three gestures against one
 * row, and a write that rebuilt the row out of its own argument silently dropped
 * whatever the other two had put there — which is how a price entered at the
 * shelf disappeared the moment the box beside it was ticked.
 *
 * An `undefined` in the patch clears its field rather than storing a key holding
 * nothing: "no price entered" is the absence of `amountCents`, and that is what
 * the screen asks.
 */
async function putCheck(
  planId: Id,
  ingredientId: Id,
  patch: Partial<Pick<GroceryCheck, 'checked' | 'amountCents' | 'removed' | 'inStock'>>,
): Promise<void> {
  const id = checkId(planId, ingredientId);
  const existing = await db.checks.get(id);

  const next: GroceryCheck = {
    checked: false,
    ...existing,
    ...patch,
    id,
    planId,
    ingredientId,
    updatedAtISO: new Date().toISOString(),
  };

  await syncedPut('checks', Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ));
}

export async function setChecked(planId: Id, ingredientId: Id, checked: boolean): Promise<void> {
  await putCheck(planId, ingredientId, { checked });
}

/**
 * Takes one line off this week's shopping list, or puts it back.
 *
 * Off the LIST, and nothing else: the meal that wanted the ingredient still
 * wants it, and the week is untouched. Taking a treat off does not empty it out
 * of the treat bag either — the ✕ on the week screen is the one that means "not
 * part of my week", and this one means "not in the trolley".
 *
 * Anything derived would be rebuilt without it and come straight back, which is
 * why this is stored at all; `withoutRemoved` in `grocery.ts` is where that is
 * argued.
 */
export async function setRemoved(planId: Id, ingredientId: Id, removed: boolean): Promise<void> {
  // A line back on the list has no reason for being off it. Left standing, a
  // stale `inStock` would relabel the line "already have" the next time it came
  // off for some quite different reason.
  await putCheck(planId, ingredientId, { removed, ...(removed ? {} : { inStock: undefined }) });
}

/**
 * Takes a line off this week's list because the cupboard already has it.
 *
 * `setRemoved` with a reason attached, rather than a second way to hide a line:
 * both put it in the same place, and the way back is the same one. All this adds
 * is what the line says about itself while it is down there, which is the whole
 * difference between "not this week" and "got it".
 *
 * It deliberately does NOT touch the pantry. Two reasons, and the second is the
 * important one. A pantry row is a standing claim about a cupboard, and this is a
 * remark about one shop — but more than that, a stocked pantry item is free to
 * the planner and invisible to the list builder, so writing one here would delete
 * the line rather than hide it, and there would be nothing left to offer back.
 * Promoting one to the pantry is a separate, deliberate act; `worthKeeping` in
 * `domain/pantry.ts` says which are worth offering it for.
 */
export async function setInStock(planId: Id, ingredientId: Id, inStock: boolean): Promise<void> {
  await putCheck(planId, ingredientId, {
    removed: inStock,
    inStock: inStock ? true : undefined,
  });
}

/**
 * Clears this plan's ticks, and the prices entered against them.
 *
 * What was taken off the list stays off. Neither of the two things that call
 * this asked for it back — Untick all is about ticks, and a finished shop is
 * over — and a line reappearing at the top of the list because the boxes had
 * been cleared reads as the ✕ never having worked.
 */
export async function clearChecks(planId: Id): Promise<void> {
  const rows = await db.checks.where('planId').equals(planId).toArray();

  for (const row of rows) {
    if (row.removed) {
      await putCheck(planId, row.ingredientId, { checked: false, amountCents: undefined });
      continue;
    }
    // Deleted one at a time so each gets its own tombstone. Without those, the other
    // device's next sync would simply re-upload its copies and every box would tick
    // itself again.
    await syncedDelete('checks', row.id);
  }
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

/**
 * Turns "I already have this" into a standing pantry row.
 *
 * The deliberate second act after marking a line as in stock, offered only for
 * things that keep — `worthKeeping` in `domain/pantry.ts` says which, and why
 * offering it for parsley would be a bug rather than a convenience.
 *
 * It arrives `alright-without`, like anything else added to the pantry: it is
 * here because it was in the cupboard, which is not the same as saying a week
 * without it is worth a trip. Necessity is set in Settings, where the rest of the
 * roster is.
 *
 * The line's off-list marks are cleared on the way past, and that is not tidying.
 * A stocked pantry item is invisible to the list builder, so the line stops being
 * built at all — and if the item is later run down to `out`, the line comes back.
 * A `removed` flag left behind from today would hide it when it did.
 */
export async function keepInPantry(planId: Id, ingredientId: Id): Promise<void> {
  await upsertPantryItem({
    ingredientId,
    status: 'stocked',
    necessity: DEFAULT_NECESSITY,
    usesSincePurchase: 0,
    lastPurchasedISO: new Date().toISOString(),
  });
  await putCheck(planId, ingredientId, { removed: false, inStock: undefined });
}

export async function setPantryStock(ingredientId: Id, status: PantryStock): Promise<void> {
  const item = await db.pantry.get(ingredientId);
  if (!item || item.status === status) return;

  await syncedPut('pantry', {
    ...afterStockChange(item, status),
    // Back in stock means it was just bought — reset the "probably low?" counter.
    ...(status === 'stocked'
      ? { lastPurchasedISO: new Date().toISOString(), usesSincePurchase: 0 }
      : {}),
  });
}

export async function setPantryNecessity(
  ingredientId: Id,
  necessity: PantryNecessity,
): Promise<void> {
  const item = await db.pantry.get(ingredientId);
  if (!item) return;
  // Any override is left standing: changing how much something matters is not a
  // retraction of "buy this", and silently dropping it off the list would be.
  await syncedPut('pantry', { ...item, necessity });
}

/**
 * Puts an item on this week's list, or takes it off, whatever the rule says.
 *
 * Always written as an explicit override rather than as "agrees with the rule
 * anyway, so store nothing": pressing the button and having the row not change
 * is indistinguishable from a bug, and the override clears itself the moment
 * stock or necessity moves.
 */
export async function setPantryRestock(ingredientId: Id, onList: boolean): Promise<void> {
  const item = await db.pantry.get(ingredientId);
  if (!item) return;
  await syncedPut('pantry', { ...item, restock: onList });
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
 * Sets what one planned line cost, or clears it.
 *
 * Upserts the check record, because a price can be entered for a line that has
 * not been ticked yet — you scan the shelf, then put it in the basket.
 */
export async function setLinePrice(
  planId: Id,
  ingredientId: Id,
  amountCents: number | null,
): Promise<void> {
  await putCheck(planId, ingredientId, { amountCents: amountCents ?? undefined });
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

/**
 * Changes one ad-hoc item, leaving the rest of the record alone.
 *
 * An `undefined` in the patch clears its field rather than storing a key holding
 * nothing, which is what `putCheck` does with the same fields on a planned line.
 * The same three things — a price, whether it is off the list, and why — are kept
 * in two tables depending on where the line came from, and the two shapes have to
 * match: code that reads them asks `=== undefined`, and one path leaving a key
 * behind is a difference that only shows up somewhere far from here.
 */
export async function updateCustomItem(id: Id, patch: Partial<CustomItem>): Promise<void> {
  const existing = await db.customItems.get(id);
  if (!existing) return;

  const next = { ...existing, ...patch, id, updatedAtISO: new Date().toISOString() };
  await syncedPut('customItems', Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ));
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
  // Recipes already on the device count too, so a file holding only "the same
  // curry but with squash" can be imported without shipping the curry again.
  const existingRecipes = await db.recipes.toArray();
  return importBundle(bundle, existing, { builtIn: false, existingRecipes });
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
