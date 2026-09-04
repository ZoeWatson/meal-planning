/**
 * Grocery list construction.
 *
 * The list is derived from the plan, never authored directly — except for the
 * `checked` flag, which is the one piece of state that belongs to the shopper
 * standing in the aisle. That split matters for sync: everything else can be
 * recomputed from the plan on any device, so the only thing two devices can ever
 * genuinely disagree about is which boxes are ticked.
 */

import {
  type GroceryLine, type GroceryList, type Id, type Ingredient,
  type PlanSlot, type WeekPlan,
} from './types';
import { type PlanningContext, aggregateNeeds, resolveAllPurchases } from './planner/scoring';
import { analyzeSurplus } from './waste';
import { type UnitSystem, formatQuantity } from './units';

/** Aisle order, so the list reads top-to-bottom the way the store is laid out. */
const CATEGORY_ORDER: readonly Ingredient['category'][] = [
  'produce', 'bakery', 'meat', 'seafood', 'dairy', 'frozen',
  'grain', 'legume', 'canned', 'condiment', 'oil', 'spice', 'baking', 'beverage', 'other',
];

export function buildGroceryList(
  plan: WeekPlan,
  ctx: PlanningContext,
  previous?: GroceryList,
): GroceryList {
  const needs = aggregateNeeds(plan.slots, plan.wildcards, ctx);
  const purchases = resolveAllPurchases(needs, ctx);
  const previousByIngredient = new Map(previous?.lines.map((l) => [l.ingredientId, l]) ?? []);
  const now = new Date().toISOString();

  const lines: GroceryLine[] = [];

  for (const need of needs.values()) {
    const ing = ctx.ingredients.get(need.ingredientId);
    const purchase = purchases.get(need.ingredientId);
    if (!ing || !purchase) continue;

    // Fully covered by last week's leftovers — nothing to buy, so nothing to list.
    if (purchase.packs === 0) continue;

    const prior = previousByIngredient.get(need.ingredientId);

    lines.push({
      ingredientId: need.ingredientId,
      neededGrams: need.grams,
      purchaseGrams: purchase.purchaseGrams,
      packs: purchase.packs,
      origins: need.origins,
      // Regenerating the list must not silently untick things already in the cart.
      checked: prior?.checked ?? false,
      updatedAtISO: prior?.updatedAtISO ?? now,
    });
  }

  lines.sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(ctx.ingredients.get(a.ingredientId)!.category);
    const ib = CATEGORY_ORDER.indexOf(ctx.ingredients.get(b.ingredientId)!.category);
    if (ia !== ib) return ia - ib;
    return ctx.ingredients.get(a.ingredientId)!.name.localeCompare(ctx.ingredients.get(b.ingredientId)!.name);
  });

  return { planId: plan.id, lines };
}

export interface DisplayLine {
  readonly ingredientId: Id;
  readonly name: string;
  readonly category: Ingredient['category'];
  /** What to buy, e.g. "2 heads" or "450 g". */
  readonly buyText: string;
  /** What the plan consumes, when meaningfully less than what you must buy. */
  readonly needText?: string;
  /** Names of the meals that want this — shown when a line is expanded. */
  readonly usedBy: readonly string[];
  readonly fromStaples: boolean;
  readonly fromPantry: boolean;
  readonly fromWildcard: boolean;
  readonly checked: boolean;
  /** Retail value of the surplus, whether or not it will actually go off. */
  readonly leftoverCost: number;
  /**
   * Surplus value weighted by how likely it is to spoil.
   *
   * These two differ enormously and conflating them is alarming and useless: a
   * 460 g jar of peanut butter you will not finish this week is $9 of surplus and
   * roughly $0 of waste, while 60 g of leftover parsley is $1.80 of surplus and
   * very nearly $1.80 of waste. Only this second number is worth acting on.
   */
  readonly wasteCost: number;
}

/** Renders a list for the UI in the requested unit system. */
export function renderGroceryList(
  list: GroceryList,
  ctx: PlanningContext,
  system: UnitSystem,
): DisplayLine[] {
  return list.lines.map((line) => {
    const ing = ctx.ingredients.get(line.ingredientId)!;
    const buy = formatQuantity(line.purchaseGrams, ing, system);
    const need = formatQuantity(line.neededGrams, ing, system);

    const usedBy: string[] = [];
    for (const origin of line.origins) {
      if (origin.kind === 'recipe') {
        const recipe = ctx.recipes.get(origin.recipeId);
        if (recipe && !usedBy.includes(recipe.name)) usedBy.push(recipe.name);
      }
    }

    const leftover = Math.max(0, line.purchaseGrams - line.neededGrams);
    const sale = ctx.sales.get(line.ingredientId);
    const costPerKg = sale?.costPerKg ?? ing.purchase.costPerKg;
    const surplus = analyzeSurplus(leftover, ing, costPerKg, ctx.wasteSettings);

    return {
      ingredientId: line.ingredientId,
      name: ing.name,
      category: ing.category,
      // Indivisible items are always quoted in packs, even a single one. "1 head"
      // is what you pick up; "15 cloves" is what you cook with, and telling a
      // shopper the second one is telling them the wrong thing.
      buyText: ing.purchase.divisible
        ? buy.text
        : ing.purchase.unit === 'each'
          ? String(line.packs)
          : `${line.packs} × ${ing.purchase.unit}`,
      needText: leftover > 1 ? need.text : undefined,
      usedBy,
      fromStaples: line.origins.some((o) => o.kind === 'staple'),
      fromPantry: line.origins.some((o) => o.kind === 'pantry'),
      fromWildcard: line.origins.some((o) => o.kind === 'wildcard'),
      checked: line.checked,
      leftoverCost: surplus.surplusValue,
      wasteCost: surplus.wasteCost,
    };
  });
}

/**
 * Recomputes the list when meals are skipped mid-week.
 *
 * This is the payoff for tracking `origins` per line: dropping Thursday's dinner
 * removes exactly its share of every ingredient, instead of leaving you to work
 * out by hand which half of the coriander you no longer need.
 */
export function withoutSlots(
  plan: WeekPlan,
  skippedSlotIds: readonly Id[],
  ctx: PlanningContext,
  previous?: GroceryList,
): GroceryList {
  const skipped = new Set(skippedSlotIds);
  const remaining: PlanSlot[] = plan.slots.filter((s) => !skipped.has(s.id));
  return buildGroceryList({ ...plan, slots: remaining }, ctx, previous);
}
