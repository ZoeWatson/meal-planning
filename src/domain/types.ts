/**
 * Core data model.
 *
 * Two ideas carry most of the weight here:
 *
 * 1. `Ingredient` (a thing that exists in the world) is separate from
 *    `RecipeIngredient` (one recipe's use of that thing). Overlap detection and
 *    grocery consolidation both operate on ingredient identity, so identity has
 *    to live in exactly one place with exactly one id.
 *
 * 2. `Ingredient` carries a PURCHASE model, not just a measurement model. You
 *    cook with cloves and you buy heads. Waste is created in the gap between
 *    those two, which is precisely the thing this app exists to close, so the
 *    gap has to be representable.
 */

import type { DisplayPreference, UnitSystem } from './units';
import type { CarryOver } from './waste';

export type Id = string;

// ---------------------------------------------------------------------------
// Ingredients
// ---------------------------------------------------------------------------

export type IngredientCategory =
  | 'produce' | 'meat' | 'seafood' | 'dairy' | 'bakery'
  | 'grain' | 'legume' | 'canned' | 'frozen'
  | 'spice' | 'condiment' | 'oil' | 'baking' | 'beverage' | 'other';

/**
 * How an ingredient is actually sold. `gramsPerPack` is the smallest unit you can
 * walk out of the store with; `divisible` marks the things you can buy an arbitrary
 * amount of (loose produce, deli counter, bulk bins) versus the things that come in
 * a sealed fixed size (a can, a carton, a bag of rice).
 *
 * Indivisible packs are where waste comes from: needing 30g of a 400g can means
 * 370g has to go somewhere.
 */
export interface PurchaseModel {
  /** Human-facing shopping unit, e.g. "head", "bunch", "can", "carton", "bag". */
  readonly unit: string;
  readonly gramsPerPack: number;
  readonly divisible: boolean;
  /** Approximate retail cost per kilogram, in the user's currency. Drives waste cost. */
  readonly costPerKg: number;
}

/** Macros per 100 g. Optional per ingredient; see `nutrition.ts` on partial coverage. */
export interface NutritionFacts {
  readonly kcal: number;
  readonly proteinG: number;
  readonly carbG: number;
  readonly fatG: number;
  readonly fibreG?: number;
}

export interface Ingredient {
  readonly id: Id;
  readonly name: string;
  /** Alternate spellings the importer will accept, e.g. ["scallion", "spring onion"]. */
  readonly aliases: readonly string[];
  readonly category: IngredientCategory;

  // --- normalization data (see units.ts) ---
  /** Density, g/ml. Required if any recipe measures this by volume. */
  readonly gramsPerMl?: number;
  /** Grams per one of each count unit, e.g. { clove: 3, head: 45 }. */
  readonly countUnits?: Readonly<Record<string, number>>;

  // --- display ---
  readonly displayAs?: DisplayPreference;
  /** Which count unit to display when `displayAs === 'count'`. Defaults to the first. */
  readonly countUnit?: string;

  // --- purchase & waste (see waste.ts for how these combine) ---
  readonly purchase: PurchaseModel;
  /** Days from purchase until it is realistically unusable. 365+ for shelf-stable. */
  readonly shelfLifeDays: number;
  /**
   * Where surplus goes at the end of the week: `pantry`, `freezer` or `fresh`.
   * Omit to default from `category`.
   */
  readonly carryOver?: CarryOver;
  /**
   * Grams a household gets through with no recipe calling for it — yogurt by the
   * spoonful, bread as toast, fruit off the counter. Surplus up to this much is
   * eaten rather than binned, so it is spend but not waste.
   *
   * 0 (the default) for anything nobody eats spontaneously. Nobody snacks on parsley.
   */
  readonly backgroundUseGramsPerWeek?: number;
  /**
   * 0..1 override for the probability that at-risk surplus is thrown away.
   * Omit to derive from `carryOver` and `shelfLifeDays`; set only for things that
   * genuinely defy the curve.
   */
  readonly wasteRisk?: number;

  // --- nutrition ---
  /** Macros per 100 g. Drives computed filters like "high protein". */
  readonly nutritionPer100g?: NutritionFacts;

  // --- seasonality ---
  /**
   * Fallback season months (1-12) used only when the active region has no entry
   * for this ingredient. Real seasonality is regional and lives in
   * `seasonality.ts`; see `PlannerSettings.regionId`.
   */
  readonly seasonMonths?: readonly number[];

  /** Dietary flags this ingredient violates, e.g. ["vegetarian", "gluten-free"]. */
  readonly excludesDiets?: readonly string[];
  /**
   * Allergen group ids this ingredient contains, e.g. ["milk"]. See `allergens.ts`.
   *
   * Omitting it does NOT mean allergen-free — the checker falls back to matching
   * the ingredient's name, so an untagged "cashew butter" is still caught. Declare
   * it wherever the name would not give it away (mayonnaise, Worcestershire).
   */
  readonly allergens?: readonly string[];
  /**
   * True when `allergens` has been checked by hand and is complete, which turns
   * off name inference for this ingredient. Set on the curated library only —
   * anything imported keeps the inference safety net.
   */
  readonly allergensVerified?: boolean;
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export type MealType = 'full' | 'light' | 'snack';

/**
 * Not everything scales linearly with servings. Doubling a stew doubles the beef
 * but does not double the bay leaves or the oil in the pan. Getting this wrong
 * inflates the grocery list for spices on every large-portion plan.
 */
export type ScalingRule = 'linear' | 'sublinear' | 'fixed';

export interface RecipeIngredient {
  readonly ingredientId: Id;
  /** Quantity as written in the source recipe, preserved for display. */
  readonly quantity: number;
  /** Unit as written, e.g. "clove", "cup", "g". */
  readonly unit: string;
  /**
   * Canonical grams, resolved ONCE at import time and stored.
   * The planner never performs unit conversion at runtime — if a recipe is in the
   * library, its quantities are already known-good.
   */
  readonly grams: number;
  /** Preparation note that does not affect identity or quantity, e.g. "finely minced". */
  readonly prep?: string;
  /** Optional ingredients are excluded from the grocery list unless the user opts in. */
  readonly optional: boolean;
  readonly scaling: ScalingRule;
}

export interface Recipe {
  readonly id: Id;
  readonly name: string;
  readonly mealType: MealType;
  /** Servings the written quantities produce. All scaling is relative to this. */
  readonly baseServings: number;
  readonly ingredients: readonly RecipeIngredient[];
  readonly steps: readonly string[];
  readonly prepMinutes: number;
  readonly cookMinutes: number;
  /** Free-form: cuisine, technique, occasion. Used for variety scoring and filtering. */
  readonly tags: readonly string[];
  /**
   * Dominant protein ingredient id, if any. Drives variety scoring — without it
   * the optimizer will happily serve chicken seven nights running because chicken
   * overlaps beautifully with itself.
   */
  readonly primaryProtein?: Id;
  readonly diets: readonly string[];
  readonly source?: RecipeSource;
  /** True for library recipes, false for ones the user imported themselves. */
  readonly builtIn: boolean;
}

export interface RecipeSource {
  readonly title?: string;
  readonly author?: string;
  readonly url?: string;
}

/** Applies a scaling rule to one ingredient. Exponent 0.7 is the usual seasoning heuristic. */
export function scaledGrams(ri: RecipeIngredient, servings: number, baseServings: number): number {
  const ratio = servings / baseServings;
  switch (ri.scaling) {
    case 'linear': return ri.grams * ratio;
    case 'sublinear': return ri.grams * Math.pow(ratio, 0.7);
    case 'fixed': return ri.grams;
  }
}

// ---------------------------------------------------------------------------
// User-owned lists
// ---------------------------------------------------------------------------

/** Bought every week regardless of what is being cooked. Never influences meal selection. */
export interface StapleItem {
  readonly ingredientId: Id;
  readonly grams: number;
  readonly active: boolean;
}

/**
 * Kept in stock rather than bought weekly.
 *
 * `stocked` items are treated as FREE by the planner: zero purchase, zero waste.
 * That is what makes a well-populated pantry pull the plan toward recipes you can
 * already mostly cook, which is the behaviour you want and costs nothing to get.
 *
 * Status is set by hand. Auto-depleting from recipe usage was considered and
 * rejected: nobody measures their olive oil, so the model drifts from reality
 * within weeks and then quietly lies on every grocery list.
 */
export interface PantryItem {
  readonly ingredientId: Id;
  readonly status: 'stocked' | 'low' | 'out';
  readonly lastPurchasedISO?: string;
  /** Plans since last purchase that called for this — powers the "probably low?" nudge. */
  readonly usesSincePurchase: number;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** One meal to be cooked. The plan is a set of these; generation fills them. */
export interface PlanSlot {
  readonly id: Id;
  readonly mealType: MealType;
  readonly recipeId: Id | null;
  readonly servings: number;
  /** Pinned slots survive regeneration untouched. */
  readonly pinned: boolean;
  /** Optional day assignment; the planner does not require one. */
  readonly day?: number;
}

/**
 * A produce grab-bag item: chosen for seasonality and sale price, not because a
 * recipe called for it. `promoted` items are fed back into generation as a hard
 * constraint — "build the week around these" — while un-promoted ones just ride
 * along on the grocery list.
 */
export interface WildcardItem {
  readonly ingredientId: Id;
  readonly grams: number;
  readonly promoted: boolean;
}

export interface WeekPlan {
  readonly id: Id;
  readonly weekStartISO: string;
  readonly slots: readonly PlanSlot[];
  readonly wildcards: readonly WildcardItem[];
  readonly generatedAtISO: string;
  /** RNG seed used, so a plan can be reproduced or nudged deterministically. */
  readonly seed: number;
}

/** The shape of the week: how many of each meal type to generate. */
export interface SlotSpec {
  readonly full: number;
  readonly light: number;
  readonly snack: number;
  readonly servingsPerMeal: Readonly<Record<MealType, number>>;
}

// ---------------------------------------------------------------------------
// Grocery list
// ---------------------------------------------------------------------------

export type GroceryOrigin =
  | { readonly kind: 'recipe'; readonly recipeId: Id; readonly slotId: Id; readonly grams: number }
  | { readonly kind: 'staple' }
  | { readonly kind: 'pantry' }
  | { readonly kind: 'wildcard' };

export interface GroceryLine {
  readonly ingredientId: Id;
  /** Grams the plan actually consumes. */
  readonly neededGrams: number;
  /** Grams you must buy after rounding up to whole packs. >= neededGrams. */
  readonly purchaseGrams: number;
  readonly packs: number;
  /**
   * Why this is on the list. Tapping a line to see which meals need it is the
   * feature that makes skipping a meal mid-week a safe thing to do.
   */
  readonly origins: readonly GroceryOrigin[];
  readonly checked: boolean;
  /** Set on check/uncheck. This is the field sync reconciles last-write-wins. */
  readonly updatedAtISO: string;
}

export interface GroceryList {
  readonly planId: Id;
  readonly lines: readonly GroceryLine[];
}

// ---------------------------------------------------------------------------
// Settings & external data
// ---------------------------------------------------------------------------

/** Sale prices, however they were obtained. Manual entry today, flyer ingestion later. */
export interface SalePrice {
  readonly ingredientId: Id;
  readonly costPerKg: number;
  readonly store?: string;
  readonly validUntilISO?: string;
}

export interface PlannerSettings {
  readonly unitSystem: UnitSystem;
  /**
   * Selects the season table in `seasonality.ts`. User-changeable in Settings;
   * defaults to `bc-canada`.
   */
  readonly regionId: string;
  readonly diets: readonly string[];
  /**
   * Active allergen group ids. Expanded to ingredient exclusions at plan time,
   * and surfaced as warnings anywhere a matching recipe could still appear.
   */
  readonly allergens: readonly string[];
  /** Ingredient ids to never plan — dislikes rather than allergies. */
  readonly excludedIngredients: readonly Id[];
  /** Soft cap on total active cooking minutes for the week. */
  readonly weeklyTimeBudgetMinutes: number;
  /** Recipes used within this many weeks are penalized, to keep the rotation moving. */
  readonly repeatWindowWeeks: number;
  readonly wildcardCount: number;
}
