/**
 * Plan scoring.
 *
 * The single most important idea in this file: the objective is NOT "maximize
 * shared ingredients". It is "minimize the money you throw away".
 *
 * Those come apart constantly. Two recipes both using one onion share an
 * ingredient but save nothing, because you were going to buy exactly one onion
 * either way. Meanwhile a single recipe using 15g of a 60g bunch of dill wastes
 * three quarters of a purchase that nothing else touches. Naive overlap counting
 * scores the first as a win and is blind to the second.
 *
 * So waste is computed the way the till computes it:
 *
 *     purchased = ceil(needed / packSize) * packSize     (indivisible items)
 *     waste     = (purchased - needed) * costPerGram * wasteRisk
 *
 * Shared ingredients then fall out as the *mechanism* the optimizer discovers on
 * its own, rather than a proxy metric it chases off a cliff.
 */

import {
  type GroceryOrigin, type Id, type Ingredient, type PantryItem, type PlanSlot,
  type PlannerSettings, type Recipe, type SalePrice, type StapleItem,
  type WildcardItem, scaledGrams,
} from '../types';
import { isOnList } from '../pantry';
import { type Region, seasonScore, seasonStatus } from '../seasonality';
import { type CompiledRule, rulePenalty } from '../weekRules';
import { type WasteSettings, DEFAULT_WASTE_SETTINGS, analyzeSurplus } from '../waste';

/** Everything the scorer needs to look things up, assembled once per generation run. */
export interface PlanningContext {
  readonly ingredients: ReadonlyMap<Id, Ingredient>;
  readonly recipes: ReadonlyMap<Id, Recipe>;
  readonly staples: readonly StapleItem[];
  readonly pantry: ReadonlyMap<Id, PantryItem>;
  readonly sales: ReadonlyMap<Id, SalePrice>;
  readonly settings: PlannerSettings;
  /** Recipe id → weeks since it was last planned. Absent means "not recently". */
  readonly recentlyUsed: ReadonlyMap<Id, number>;
  /** Month 1-12 that the plan is for, used for seasonality. */
  readonly month: number;
  /** Resolved from `settings.regionId`; determines which season table applies. */
  readonly region: Region;
  /**
   * Grams left over from previous weeks that are still usable — the 380 g of rice
   * in the bag you opened, the half can of chickpeas.
   *
   * This is what makes shelf-stable surplus honestly free rather than merely
   * cheap: last week's leftovers reduce this week's purchase, so buying a 1 kg bag
   * for a 620 g recipe is genuinely not waste, it is prepayment.
   */
  readonly carriedOver?: ReadonlyMap<Id, number>;
  readonly wasteSettings?: WasteSettings;
  /**
   * The week rules, with their matching recipes already resolved — see
   * `weekRules.ts`. Compiled once here rather than re-tested per score, because
   * this object is assembled once per generation run and `scorePlan` is not.
   *
   * Absent means no rules, which costs nothing: the term is zero and the plan is
   * scored exactly as it was before rules existed.
   */
  readonly rules?: readonly CompiledRule[];
}

/** Aggregated demand for one ingredient across a whole plan. */
export interface Need {
  readonly ingredientId: Id;
  grams: number;
  readonly origins: GroceryOrigin[];
}

/**
 * Relative importance of each term. Exposed because these genuinely need tuning
 * against real plans — the defaults are a starting point, not a result.
 * Waste is denominated in currency; the others are scaled to be commensurable
 * with "about a dollar per unit of badness".
 */
export interface ScoreWeights {
  readonly waste: number;
  readonly variety: number;
  readonly season: number;
  readonly sale: number;
  readonly effort: number;
  readonly repeat: number;
  /**
   * Total grocery spend. Zero by default — this app is about not throwing food
   * away, and optimizing spend directly just produces a week of rice and lentils.
   * Raise it if a cheap week is explicitly the goal.
   */
  readonly spend: number;
  /**
   * Cost per meal a week rule is still short of. Far above every other weight on
   * purpose: a rule is something the household asked for by name, and a plan that
   * quietly trades it away for forty cents of parsley is not answering the
   * question. Finite rather than infinite so that an unsatisfiable rule — three
   * pasta nights out of two pasta recipes — still yields a full week with one
   * rule unmet, which the week screen can then say out loud.
   */
  readonly rules: number;
}

/**
 * Calibrated against the tuning harness, not guessed.
 *
 * The first pass used variety 2.5 and repeat 3.0. Measuring the actual ranges
 * showed why that was wrong: total plan waste spans roughly $1.50–$5.00, while a
 * single variety penalty unit at weight 2.5 costs $2.50 and a fourth repeat of a
 * protein costs $10. Variety and recency were not competing with waste, they were
 * drowning it — the app's headline feature was a rounding error in its own
 * objective function.
 *
 * These weights put every term on a scale where a unit of badness costs roughly
 * a dollar, so the trade-offs are legible: a third chicken dinner costs $1.50,
 * a fourth costs $6.00, and both can still be outweighed by genuinely bad waste.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  waste: 1.0,
  variety: 1.5,
  season: 1.0,
  sale: 1.0,
  effort: 0.02,
  repeat: 1.5,
  spend: 0,
  rules: 25,
};

/** Waste alone. Used by the tuning harness to verify the search itself works. */
export const WASTE_ONLY_WEIGHTS: ScoreWeights = {
  waste: 1.0, variety: 0, season: 0, sale: 0, effort: 0, repeat: 0, spend: 0, rules: 0,
};

/**
 * Aggregates every gram the plan requires, from all four sources.
 * Pantry-`stocked` ingredients are dropped here rather than zeroed later, so that
 * downstream code cannot accidentally charge for something you already own.
 */
export function aggregateNeeds(
  slots: readonly PlanSlot[],
  wildcards: readonly WildcardItem[],
  ctx: PlanningContext,
): Map<Id, Need> {
  const needs = new Map<Id, Need>();

  const record = (ingredientId: Id, grams: number, origin: GroceryOrigin): void => {
    if (ctx.settings.excludedIngredients.includes(ingredientId)) return;

    const existing = needs.get(ingredientId);
    if (existing) {
      existing.grams += grams;
      existing.origins.push(origin);
    } else {
      needs.set(ingredientId, { ingredientId, grams, origins: [origin] });
    }
  };

  /** As `record`, but anything the pantry has in stock is free and never bought. */
  const add = (ingredientId: Id, grams: number, origin: GroceryOrigin): void => {
    if (ctx.pantry.get(ingredientId)?.status === 'stocked') return;
    record(ingredientId, grams, origin);
  };

  for (const slot of slots) {
    if (slot.recipeId === null) continue;
    const recipe = ctx.recipes.get(slot.recipeId);
    if (!recipe) continue;
    for (const ri of recipe.ingredients) {
      if (ri.optional) continue;
      add(ri.ingredientId, scaledGrams(ri, slot.servings, recipe.baseServings), {
        kind: 'recipe', recipeId: recipe.id, slotId: slot.id, grams: ri.grams,
      });
    }
  }

  for (const staple of ctx.staples) {
    if (staple.active) add(staple.ingredientId, staple.grams, { kind: 'staple' });
  }

  for (const [id, item] of ctx.pantry) {
    // Stock alone does not decide this: see `domain/pantry.ts` for how necessity
    // and a by-hand override combine with it.
    if (!isOnList(item)) continue;
    const ing = ctx.ingredients.get(id);
    // `record`, not `add`: a restock you asked for is a pack you are buying even
    // when the cupboard is not empty. Recipes using it stay free either way —
    // they eat what is already there, not the pack on the list.
    if (ing) record(id, ing.purchase.gramsPerPack, { kind: 'pantry' });
  }

  for (const wc of wildcards) {
    add(wc.ingredientId, wc.grams, { kind: 'wildcard' });
  }

  return needs;
}

export interface PurchaseResult {
  readonly packs: number;
  readonly purchaseGrams: number;
  readonly leftoverGrams: number;
  /** Surplus eaten anyway rather than binned. Spend, not waste. */
  readonly absorbedGrams: number;
  readonly wasteCost: number;
  readonly spend: number;
  /** Grams supplied from last week's leftovers instead of being bought. */
  readonly fromCarryOver: number;
}

/**
 * Turns "grams I need" into "what the store will actually make me buy, what that
 * costs, and what of it gets thrown away".
 *
 * Carry-over is applied first: existing stock reduces the shortfall before pack
 * rounding, which is the whole reason a big bag of rice is not a waste problem.
 */
export function resolvePurchase(
  need: Need,
  ingredient: Ingredient,
  sale?: SalePrice,
  carriedOverGrams = 0,
  wasteSettings: WasteSettings = DEFAULT_WASTE_SETTINGS,
): PurchaseResult {
  const costPerKg = sale?.costPerKg ?? ingredient.purchase.costPerKg;

  const fromCarryOver = Math.min(need.grams, carriedOverGrams);
  const shortfall = need.grams - fromCarryOver;

  if (shortfall <= 0) {
    return {
      packs: 0, purchaseGrams: 0, leftoverGrams: 0, absorbedGrams: 0,
      wasteCost: 0, spend: 0, fromCarryOver,
    };
  }

  if (ingredient.purchase.divisible) {
    return {
      packs: 1,
      purchaseGrams: shortfall,
      leftoverGrams: 0,
      absorbedGrams: 0,
      wasteCost: 0,
      spend: (shortfall / 1000) * costPerKg,
      fromCarryOver,
    };
  }

  const packSize = ingredient.purchase.gramsPerPack;
  const packs = Math.max(1, Math.ceil(shortfall / packSize));
  const purchaseGrams = packs * packSize;
  const surplus = analyzeSurplus(purchaseGrams - shortfall, ingredient, costPerKg, wasteSettings);

  return {
    packs,
    purchaseGrams,
    leftoverGrams: surplus.leftoverGrams,
    absorbedGrams: surplus.absorbedGrams,
    wasteCost: surplus.wasteCost,
    spend: (purchaseGrams / 1000) * costPerKg,
    fromCarryOver,
  };
}

/** Resolves every line of a plan's shopping, applying carry-over and sale prices. */
export function resolveAllPurchases(
  needs: ReadonlyMap<Id, Need>,
  ctx: PlanningContext,
): Map<Id, PurchaseResult> {
  const out = new Map<Id, PurchaseResult>();
  for (const need of needs.values()) {
    const ing = ctx.ingredients.get(need.ingredientId);
    if (!ing) continue;
    out.set(need.ingredientId, resolvePurchase(
      need,
      ing,
      ctx.sales.get(need.ingredientId),
      ctx.carriedOver?.get(need.ingredientId) ?? 0,
      ctx.wasteSettings,
    ));
  }
  return out;
}

/** Total currency value of everything this plan will cause to be thrown out. */
export function wasteCost(needs: ReadonlyMap<Id, Need>, ctx: PlanningContext): number {
  let total = 0;
  for (const result of resolveAllPurchases(needs, ctx).values()) total += result.wasteCost;
  return total;
}

/** Total grocery spend. Reported always; only optimized if `weights.spend > 0`. */
export function totalSpend(needs: ReadonlyMap<Id, Need>, ctx: PlanningContext): number {
  let total = 0;
  for (const result of resolveAllPurchases(needs, ctx).values()) total += result.spend;
  return total;
}

/**
 * Penalizes monotony. Quadratic above a comfort threshold, so the third chicken
 * dinner hurts much more than the second — linear penalties are too easy for the
 * optimizer to pay off with a small waste saving.
 */
export function varietyPenalty(slots: readonly PlanSlot[], ctx: PlanningContext): number {
  const proteins = new Map<Id, number>();
  const cuisines = new Map<string, number>();

  for (const slot of slots) {
    if (slot.recipeId === null) continue;
    const recipe = ctx.recipes.get(slot.recipeId);
    if (!recipe) continue;
    if (recipe.primaryProtein) {
      proteins.set(recipe.primaryProtein, (proteins.get(recipe.primaryProtein) ?? 0) + 1);
    }
    for (const tag of recipe.tags) {
      cuisines.set(tag, (cuisines.get(tag) ?? 0) + 1);
    }
  }

  const over = (counts: Map<string, number>, comfort: number): number => {
    let penalty = 0;
    for (const n of counts.values()) penalty += Math.pow(Math.max(0, n - comfort), 2);
    return penalty;
  };

  return over(proteins, 2) + 0.5 * over(cuisines, 3);
}

/**
 * Mean seasonality of the plan's produce in the active region, as a 0..1 bonus.
 * Peak scores 1, still-available-from-storage scores 0.6, out of season scores 0.
 * Produce with no season data is excluded from the average rather than counted as
 * zero, so gaps in the data do not quietly penalize a plan.
 */
export function seasonBonus(needs: ReadonlyMap<Id, Need>, ctx: PlanningContext): number {
  let scored = 0;
  let total = 0;
  for (const need of needs.values()) {
    const ing = ctx.ingredients.get(need.ingredientId);
    if (!ing || ing.category !== 'produce') continue;
    const value = seasonScore(seasonStatus(ing, ctx.month, ctx.region));
    if (value === null) continue;
    scored++;
    total += value;
  }
  return scored === 0 ? 0 : total / scored;
}

/** Currency saved by items that happen to be on sale this week. */
export function saleBonus(needs: ReadonlyMap<Id, Need>, ctx: PlanningContext): number {
  let saved = 0;
  for (const need of needs.values()) {
    const sale = ctx.sales.get(need.ingredientId);
    const ing = ctx.ingredients.get(need.ingredientId);
    if (!sale || !ing) continue;
    const delta = ing.purchase.costPerKg - sale.costPerKg;
    if (delta > 0) saved += (need.grams / 1000) * delta;
  }
  return saved;
}

/** Minutes of cooking above the weekly budget. Below budget costs nothing. */
export function effortPenalty(slots: readonly PlanSlot[], ctx: PlanningContext): number {
  let minutes = 0;
  for (const slot of slots) {
    if (slot.recipeId === null) continue;
    const recipe = ctx.recipes.get(slot.recipeId);
    if (recipe) minutes += recipe.prepMinutes + recipe.cookMinutes;
  }
  return Math.max(0, minutes - ctx.settings.weeklyTimeBudgetMinutes);
}

/** Penalizes recipes seen recently, decaying to zero at the edge of the repeat window. */
export function repeatPenalty(slots: readonly PlanSlot[], ctx: PlanningContext): number {
  const window = ctx.settings.repeatWindowWeeks;
  if (window <= 0) return 0;

  let penalty = 0;
  for (const slot of slots) {
    if (slot.recipeId === null) continue;
    const weeksAgo = ctx.recentlyUsed.get(slot.recipeId);
    if (weeksAgo !== undefined && weeksAgo < window) {
      penalty += (window - weeksAgo) / window;
    }
  }
  return penalty;
}

export interface ScoreBreakdown {
  readonly total: number;
  readonly waste: number;
  readonly variety: number;
  readonly season: number;
  readonly sale: number;
  readonly effort: number;
  readonly repeat: number;
  readonly spend: number;
  /** Meals the week is still short across every rule. Zero when they are all met. */
  readonly rules: number;
}

/** Lower is better. Bonuses are subtracted so the whole thing stays a minimization. */
export function scorePlan(
  slots: readonly PlanSlot[],
  wildcards: readonly WildcardItem[],
  ctx: PlanningContext,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoreBreakdown {
  const needs = aggregateNeeds(slots, wildcards, ctx);

  // One pass, reused for both money terms — this is the hot path during search.
  const purchases = resolveAllPurchases(needs, ctx);
  let waste = 0;
  let spend = 0;
  for (const result of purchases.values()) {
    waste += result.wasteCost;
    spend += result.spend;
  }

  const variety = varietyPenalty(slots, ctx);
  const season = seasonBonus(needs, ctx);
  const sale = saleBonus(needs, ctx);
  const effort = effortPenalty(slots, ctx);
  const repeat = repeatPenalty(slots, ctx);
  const rules = ctx.rules ? rulePenalty(slots, ctx.rules) : 0;

  const total =
    weights.waste * waste +
    weights.variety * variety -
    weights.season * season -
    weights.sale * sale +
    weights.effort * effort +
    weights.repeat * repeat +
    weights.spend * spend +
    weights.rules * rules;

  return { total, waste, variety, season, sale, effort, repeat, spend, rules };
}
