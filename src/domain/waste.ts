/**
 * The waste model.
 *
 * This is the objective function the whole planner optimizes, so it is worth
 * being precise about what it claims.
 *
 * The first version was `wasteRisk = exp(-shelfLifeDays / 10)` — surplus is
 * wasted in proportion to how fast it rots. Running it on real data showed that
 * is wrong in two specific, systematic ways:
 *
 *   1. It charged $1.36 for Greek yogurt. You need 60 g, the smallest tub is
 *      750 g, so 690 g is "surplus". But nobody throws out yogurt — they eat it.
 *      The model had no way to represent food that gets consumed regardless of
 *      whether a recipe called for it.
 *
 *   2. It charged $1.47 for chicken thighs. You need 800 g, packs are 500 g, so
 *      200 g is "surplus". But 200 g of chicken goes in the freezer. The model
 *      had no way to represent surplus that survives by being put somewhere.
 *
 * Both errors push the same direction: they make the optimizer avoid perfectly
 * sensible recipes because of surplus that was never going to be thrown away.
 * Worse, they *drown out* the real signal — a $0.27 half-bunch of kale is the
 * waste you can actually design away, and it was being buried under $2.83 of
 * yogurt and chicken that were never at risk.
 *
 * So surplus is now routed through three questions before it counts as waste:
 *
 *   1. Would it have been eaten anyway?      → `backgroundUseGramsPerWeek`
 *   2. Can it be kept?                       → `carryOver`
 *   3. Does it survive to the next shop?     → shelf life vs. shopping cycle
 *
 * IMPORTANT: this measures WASTE, not SPEND. Yogurt you eat is not waste, but it
 * is money — it simply belongs in the spend metric rather than this one. The two
 * are reported separately and must not be conflated.
 */

import type { Ingredient, IngredientCategory } from './types';

/**
 * Where surplus goes when the week ends.
 *
 *   pantry  — shelf-stable. Rice, cans, spices, oil. Survives indefinitely.
 *   freezer — freezable without meaningful loss. Meat, bread, stock.
 *   fresh   — must be eaten or lost. Produce, dairy, anything with a date on it.
 */
export type CarryOver = 'pantry' | 'freezer' | 'fresh';

/** Sensible default per category, so a 500-ingredient import need not set it by hand. */
const CATEGORY_CARRY_OVER: Readonly<Record<IngredientCategory, CarryOver>> = {
  canned: 'pantry',
  grain: 'pantry',
  legume: 'pantry',
  spice: 'pantry',
  condiment: 'pantry',
  oil: 'pantry',
  baking: 'pantry',
  frozen: 'freezer',
  meat: 'freezer',
  seafood: 'freezer',
  bakery: 'freezer',
  produce: 'fresh',
  dairy: 'fresh',
  beverage: 'fresh',
  other: 'fresh',
};

export function carryOverOf(ingredient: Ingredient): CarryOver {
  return ingredient.carryOver ?? CATEGORY_CARRY_OVER[ingredient.category];
}

export interface WasteSettings {
  /** Days between shopping trips. The horizon surplus has to survive. */
  readonly cycleDays: number;
  /** Shelf-stable surplus still occasionally dies of old age or forgetting. */
  readonly pantryRisk: number;
  /**
   * Freezing works, but not perfectly — bags get freezer-burned, and some of what
   * goes in never comes out. Not zero, or the model would treat an unlimited
   * freezer as free storage.
   */
  readonly freezerRisk: number;
  /** Floor for fresh items that comfortably outlive the shopping cycle. */
  readonly minFreshRisk: number;
  /** Ceiling for the most fragile items. Never 1.0 — some surplus always gets used. */
  readonly maxFreshRisk: number;
}

export const DEFAULT_WASTE_SETTINGS: WasteSettings = {
  cycleDays: 7,
  pantryRisk: 0.02,
  freezerRisk: 0.10,
  minFreshRisk: 0.10,
  maxFreshRisk: 0.95,
};

/**
 * Probability that a gram of surplus is thrown away.
 *
 * For fresh items the curve is `1 - shelfLife / (2 × cycleDays)`, clamped.
 * The two-cycle denominator is the load-bearing choice: something that survives
 * until the *shop after next* has two separate weeks in which to get eaten, and
 * is realistically safe. Something that dies inside one cycle has to be used by
 * this week's plan or not at all.
 *
 * With a 7-day cycle:
 *   parsley   3 days →  0.79    fragile, and the classic half-bunch-binned case
 *   kale      6 days →  0.57    dies just inside the cycle
 *   feta     21 days →  0.10    comfortably survives; floor
 *   carrot   30 days →  0.10    floor
 *
 * The old exponential agreed on the short end and badly overcharged the long end,
 * which is exactly where the false signal was coming from.
 */
export function spoilRisk(
  ingredient: Ingredient,
  settings: WasteSettings = DEFAULT_WASTE_SETTINGS,
): number {
  if (ingredient.wasteRisk !== undefined) return ingredient.wasteRisk;

  switch (carryOverOf(ingredient)) {
    case 'pantry': return settings.pantryRisk;
    case 'freezer': return settings.freezerRisk;
    case 'fresh': {
      const raw = 1 - ingredient.shelfLifeDays / (2 * settings.cycleDays);
      return Math.min(settings.maxFreshRisk, Math.max(settings.minFreshRisk, raw));
    }
  }
}

export interface SurplusBreakdown {
  readonly leftoverGrams: number;
  /** Surplus absorbed by ordinary eating: the yogurt you finish, the bread you toast. */
  readonly absorbedGrams: number;
  /** Surplus that genuinely has to survive on its own. */
  readonly atRiskGrams: number;
  readonly spoilRisk: number;
  /** Retail value of all surplus, spoiled or not. */
  readonly surplusValue: number;
  /** Expected value actually binned. THIS is what the planner minimizes. */
  readonly wasteCost: number;
}

/**
 * Splits surplus into the part that gets eaten and the part that is at risk.
 *
 * `backgroundUseGramsPerWeek` is how much of an ingredient a household gets
 * through with no recipe calling for it — yogurt by the spoonful, bread as toast,
 * fruit off the counter. It is a property of the food and the household, not of
 * the plan, which is why it lives on the ingredient rather than being derived.
 *
 * Set it to 0 for anything nobody eats spontaneously. Nobody snacks on parsley.
 */
export function analyzeSurplus(
  leftoverGrams: number,
  ingredient: Ingredient,
  costPerKg: number,
  settings: WasteSettings = DEFAULT_WASTE_SETTINGS,
): SurplusBreakdown {
  const leftover = Math.max(0, leftoverGrams);
  const background = ingredient.backgroundUseGramsPerWeek ?? 0;

  const absorbed = Math.min(leftover, background);
  const atRisk = leftover - absorbed;
  const risk = spoilRisk(ingredient, settings);

  return {
    leftoverGrams: leftover,
    absorbedGrams: absorbed,
    atRiskGrams: atRisk,
    spoilRisk: risk,
    surplusValue: (leftover / 1000) * costPerKg,
    wasteCost: (atRisk / 1000) * costPerKg * risk,
  };
}
