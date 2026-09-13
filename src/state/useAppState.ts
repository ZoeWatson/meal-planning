/**
 * The bridge between IndexedDB and React.
 *
 * `useLiveQuery` re-renders whenever the underlying tables change, so writes go
 * through the repository and the UI updates itself. There is no separate store to
 * keep in sync, and no cache to invalidate — the database *is* the state.
 */

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { db, DEFAULT_SETTINGS, type AppSettings } from '../db/database';
import { getSettings, savePlan, setTreats, setWildcards } from '../db/repository';
import { buildGroceryList, renderGroceryList, type DisplayLine } from '../domain/grocery';
import { getRegion } from '../domain/seasonality';
import { excludedByAllergens } from '../domain/allergens';
import { DEFAULT_WASTE_SETTINGS } from '../domain/waste';
import { fitTreats, treatTarget } from '../domain/treats';
import { type GrabBagId, bagOf, grabBagLanes } from '../domain/grabbag';
import { compileRules } from '../domain/weekRules';
import { type WildcardSizes, fitWildcards, generateWeekPlan } from '../domain/planner/generate';
import type { PlanningContext } from '../domain/planner/scoring';
import type { RecipeFilter } from '../domain/filters';
import type {
  GroceryList, Id, Ingredient, PantryItem, PlannerSettings, Recipe, SalePrice, StapleItem, WeekPlan,
} from '../domain/types';

export interface AppState {
  readonly ready: boolean;
  readonly settings: AppSettings;
  readonly ingredients: ReadonlyMap<Id, Ingredient>;
  readonly recipes: ReadonlyMap<Id, Recipe>;
  readonly plan: WeekPlan | null;
  readonly ctx: PlanningContext | null;
  readonly groceryList: GroceryList | null;
  readonly groceryLines: readonly DisplayLine[];
  readonly staples: readonly StapleItem[];
  readonly pantry: readonly PantryItem[];
  readonly sales: readonly SalePrice[];
  /** Ingredient ids ruled out by the active allergens, for UI that explains why. */
  readonly allergenExclusions: readonly Id[];
}

const EMPTY_SETTINGS: AppSettings = { ...DEFAULT_SETTINGS, id: 'settings' };

export function useAppState(): AppState {
  const settings = useLiveQuery(() => getSettings(), [], undefined);
  const ingredientRows = useLiveQuery(() => db.ingredients.toArray(), [], undefined);
  const recipeRows = useLiveQuery(() => db.recipes.toArray(), [], undefined);
  const staples = useLiveQuery(() => db.staples.toArray(), [], undefined);
  const pantryRows = useLiveQuery(() => db.pantry.toArray(), [], undefined);
  const saleRows = useLiveQuery(() => db.sales.toArray(), [], undefined);
  const carryOverRows = useLiveQuery(() => db.carryOver.toArray(), [], undefined);
  const planRows = useLiveQuery(() => db.plans.toArray(), [], undefined);
  const checkRows = useLiveQuery(() => db.checks.toArray(), [], undefined);

  const ready =
    settings !== undefined && ingredientRows !== undefined && recipeRows !== undefined &&
    staples !== undefined && pantryRows !== undefined && saleRows !== undefined &&
    planRows !== undefined && checkRows !== undefined && carryOverRows !== undefined;

  const ingredients = useMemo(
    () => new Map((ingredientRows ?? []).map((i) => [i.id, i])),
    [ingredientRows],
  );
  const recipes = useMemo(
    () => new Map((recipeRows ?? []).map((r) => [r.id, r])),
    [recipeRows],
  );

  const plan = useMemo(() => {
    if (!settings?.activePlanId) return null;
    return (planRows ?? []).find((p) => p.id === settings.activePlanId) ?? null;
  }, [planRows, settings?.activePlanId]);

  /**
   * Weeks since each recipe was last planned, so the repeat penalty has something
   * to work with. Derived from plan history rather than stored, because storing it
   * would just be a cache that can go stale.
   */
  const recentlyUsed = useMemo(() => {
    const out = new Map<Id, number>();
    const now = Date.now();
    for (const p of planRows ?? []) {
      if (p.id === settings?.activePlanId) continue;
      const weeksAgo = Math.floor((now - Date.parse(p.generatedAtISO)) / (7 * 86_400_000));
      for (const slot of p.slots) {
        if (!slot.recipeId) continue;
        const existing = out.get(slot.recipeId);
        if (existing === undefined || weeksAgo < existing) out.set(slot.recipeId, weeksAgo);
      }
    }
    return out;
  }, [planRows, settings?.activePlanId]);

  /**
   * Active allergens expanded to concrete ingredient ids.
   *
   * Folded into `excludedIngredients` rather than given a parallel mechanism, so
   * allergens travel through the exclusion path that generation, the grocery list
   * and the wildcard draw already use — code that is exercised constantly and
   * cannot quietly drift out of step with a second one.
   */
  const allergenExclusions = useMemo(
    () => excludedByAllergens(ingredients.values(), settings?.allergens ?? []),
    [ingredients, settings?.allergens],
  );

  /**
   * The week rules with their matching recipes worked out — once per library
   * change rather than once per candidate plan. `weekRules.ts` says why that
   * matters: the search scores thousands of plans and the season and protein
   * subjects are expensive to test.
   */
  const rules = useMemo(() => {
    if (!settings || !ready || settings.weekRules.length === 0) return [];
    return compileRules(settings.weekRules, recipes.values(), {
      ingredients,
      region: getRegion(settings.regionId),
      month: new Date().getMonth() + 1,
    });
  }, [settings, ready, recipes, ingredients]);

  const ctx = useMemo<PlanningContext | null>(() => {
    if (!settings || !ready) return null;
    return {
      ingredients,
      recipes,
      rules,
      staples: staples ?? [],
      pantry: new Map((pantryRows ?? []).map((p) => [p.ingredientId, p])),
      sales: new Map((saleRows ?? []).map((s) => [s.ingredientId, s])),
      settings: {
        ...settings,
        excludedIngredients: [
          ...new Set([...settings.excludedIngredients, ...allergenExclusions]),
        ],
      },
      recentlyUsed,
      month: new Date().getMonth() + 1,
      region: getRegion(settings.regionId),
      carriedOver: new Map((carryOverRows ?? []).map((c) => [c.ingredientId, c.grams])),
      wasteSettings: { ...DEFAULT_WASTE_SETTINGS, cycleDays: settings.cycleDays },
    };
  }, [settings, ready, ingredients, recipes, staples, pantryRows, saleRows, recentlyUsed,
      carryOverRows, allergenExclusions, rules]);

  const groceryList = useMemo(() => {
    if (!plan || !ctx) return null;
    const base = buildGroceryList(plan, ctx);

    // Ticked boxes live in their own table, so they are merged in here rather
    // than being part of what gets recomputed.
    const checkMap = new Map((checkRows ?? []).map((c) => [c.ingredientId, c]));
    return {
      ...base,
      lines: base.lines.map((line) => {
        const check = checkMap.get(line.ingredientId);
        return check && check.planId === plan.id
          ? { ...line, checked: check.checked, updatedAtISO: check.updatedAtISO }
          : line;
      }),
    };
  }, [plan, ctx, checkRows]);

  const groceryLines = useMemo(() => {
    if (!groceryList || !ctx || !settings) return [];
    const rendered = renderGroceryList(groceryList, ctx, settings.unitSystem);
    // renderGroceryList works from the stored lines, so re-apply check state.
    return rendered.map((line, i) => ({ ...line, checked: groceryList.lines[i].checked }));
  }, [groceryList, ctx, settings]);

  return {
    ready,
    settings: settings ?? EMPTY_SETTINGS,
    ingredients,
    recipes,
    plan,
    ctx,
    groceryList,
    groceryLines,
    staples: staples ?? [],
    pantry: pantryRows ?? [],
    sales: saleRows ?? [],
    allergenExclusions,
  };
}

/**
 * Generates and persists a new week.
 *
 * Pinned slots from the current plan are carried across, so "regenerate" means
 * "redo the parts I have not committed to" rather than throwing away a week you
 * were mostly happy with.
 */
export async function generateAndSave(
  ctx: PlanningContext,
  options: { filter?: RecipeFilter; keepPinnedFrom?: WeekPlan | null } = {},
): Promise<WeekPlan> {
  const settings = await getSettings();
  const seed = Math.floor(Math.random() * 2 ** 31);

  const pinnedSlots = (options.keepPinnedFrom?.slots ?? []).filter(
    (s) => s.pinned && s.recipeId !== null,
  );

  // Promoted wildcards are kept; the rest are redrawn so the grab bag stays fresh.
  const keptWildcards = (options.keepPinnedFrom?.wildcards ?? []).filter((w) => w.promoted);
  // Same bargain for treats: pinned ones carry over, everything else is new.
  const keptTreats = (options.keepPinnedFrom?.treats ?? []).filter((t) => t.pinned);

  const result = generateWeekPlan(ctx, {
    spec: settings.spec,
    pinnedSlots,
    wildcards: fitWildcards(ctx, grabBagLanes(settings), seed, keptWildcards),
    treats: fitTreats(settings, treatTarget(settings), seed, keptTreats),
    filter: options.filter,
    seed,
  });

  await savePlan(result.plan);
  return result.plan;
}

/** The grab bag half of settings, in the shape the draw wants. */
export function wildcardSizes(settings: PlannerSettings): WildcardSizes {
  return {
    split: settings.wildcardSplit,
    count: settings.wildcardCount,
    fruitCount: settings.wildcardFruitCount,
    vegCount: settings.wildcardVegCount,
  };
}

/**
 * Redraws the grab bag without touching the meals.
 *
 * The bag and the plan answer different questions — "what should I cook" versus
/**
 * Redraws a grab bag without touching the meals.
 *
 * The bags and the plan answer different questions — "what should I cook" versus
 * "what else is worth having in the house" — and a draw you do not like is not a
 * reason to lose a week of meals you do. Promoted items survive, because those
 * are the ones the plan was built around.
 *
 * One bag at a time, because they are separate suggestions: liking the produce
 * and wanting a different cheese is the ordinary case, and a single button that
 * rerolled all four would make the cheese cost the produce. Everything outside
 * the named bag is passed straight back through, so it comes out untouched.
 * Omitting `bag` redraws the lot.
 */
export async function redrawWildcards(
  ctx: PlanningContext,
  plan: WeekPlan,
  bag?: GrabBagId,
): Promise<void> {
  const settings = await getSettings();
  const keep = plan.wildcards.filter((w) => {
    if (w.promoted) return true;
    if (bag === undefined) return false;
    const ing = ctx.ingredients.get(w.ingredientId);
    return ing !== undefined && bagOf(ing) !== bag;
  });
  const seed = Math.floor(Math.random() * 2 ** 31);
  await setWildcards(plan.id, fitWildcards(ctx, grabBagLanes(settings), seed, keep));
}

/**
 * Brings every bag to whatever size the settings now ask for, keeping the items
 * already in them.
 *
 * Called after a size, split or on/off change so the control the user just moved
 * has a visible effect immediately. Only what is needed changes: raising a count
 * adds items, lowering it removes them, switching a bag off empties that bag, and
 * nothing already on screen is reshuffled.
 */
export async function resizeWildcards(ctx: PlanningContext, plan: WeekPlan): Promise<void> {
  const settings = await getSettings();
  const seed = Math.floor(Math.random() * 2 ** 31);
  const next = fitWildcards(ctx, grabBagLanes(settings), seed, plan.wildcards);

  const unchanged =
    next.length === plan.wildcards.length &&
    next.every((w, i) => w.ingredientId === plan.wildcards[i].ingredientId);
  if (unchanged) return;

  await setWildcards(plan.id, next);
}

// ---------------------------------------------------------------------------
// The treat bag
// ---------------------------------------------------------------------------
//
// No `PlanningContext` in either of these, unlike their produce equivalents. The
// treat draw reads the catalogue, the allergen list and the diets, and nothing
// else — it has no opinion about what is in season, what is on sale or what is
// being cooked, because a bar of soap has no opinion about any of that either.

/** Redraws the treat bag. Pinned treats survive; the meals are untouched. */
export async function redrawTreats(plan: WeekPlan): Promise<void> {
  const settings = await getSettings();
  const keep = (plan.treats ?? []).filter((t) => t.pinned);
  const seed = Math.floor(Math.random() * 2 ** 31);
  await setTreats(plan.id, fitTreats(settings, treatTarget(settings), seed, keep));
}

/**
 * Brings the current bag to whatever size the settings now ask for.
 *
 * Called after the stepper moves, so the control has a visible effect
 * immediately rather than at the start of next week.
 */
export async function resizeTreats(plan: WeekPlan): Promise<void> {
  const settings = await getSettings();
  const current = plan.treats ?? [];
  const seed = Math.floor(Math.random() * 2 ** 31);
  const next = fitTreats(settings, treatTarget(settings), seed, current);

  const unchanged =
    next.length === current.length &&
    next.every((t, i) => t.treatId === current[i].treatId);
  if (unchanged) return;

  await setTreats(plan.id, next);
}
