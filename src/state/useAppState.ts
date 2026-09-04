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
import { getSettings, savePlan } from '../db/repository';
import { buildGroceryList, renderGroceryList, type DisplayLine } from '../domain/grocery';
import { getRegion } from '../domain/seasonality';
import { DEFAULT_WASTE_SETTINGS } from '../domain/waste';
import { generateWeekPlan, pickWildcards } from '../domain/planner/generate';
import type { PlanningContext } from '../domain/planner/scoring';
import type { RecipeFilter } from '../domain/filters';
import type {
  GroceryList, Id, Ingredient, PantryItem, Recipe, SalePrice, StapleItem, WeekPlan,
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

  const ctx = useMemo<PlanningContext | null>(() => {
    if (!settings || !ready) return null;
    return {
      ingredients,
      recipes,
      staples: staples ?? [],
      pantry: new Map((pantryRows ?? []).map((p) => [p.ingredientId, p])),
      sales: new Map((saleRows ?? []).map((s) => [s.ingredientId, s])),
      settings,
      recentlyUsed,
      month: new Date().getMonth() + 1,
      region: getRegion(settings.regionId),
      carriedOver: new Map((carryOverRows ?? []).map((c) => [c.ingredientId, c.grams])),
      wasteSettings: { ...DEFAULT_WASTE_SETTINGS, cycleDays: settings.cycleDays },
    };
  }, [settings, ready, ingredients, recipes, staples, pantryRows, saleRows, recentlyUsed, carryOverRows]);

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
  const fresh = pickWildcards(ctx, Math.max(0, settings.wildcardCount - keptWildcards.length), seed);

  const result = generateWeekPlan(ctx, {
    spec: settings.spec,
    pinnedSlots,
    wildcards: [...keptWildcards, ...fresh],
    filter: options.filter,
    seed,
  });

  await savePlan(result.plan);
  return result.plan;
}
