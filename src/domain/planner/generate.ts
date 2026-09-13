/**
 * Week generation.
 *
 * Choosing 15 recipes from a library of 500 to minimize waste is a set-selection
 * problem with C(500,15) ≈ 10^28 candidates, so exact optimization is off the
 * table. It is also not needed: waste differences between a good plan and the
 * theoretical optimum are pennies, while the difference between a good plan and
 * a naive random one is most of a bunch of parsley every week.
 *
 * The approach is greedy construction plus local search, repeated from several
 * random starts:
 *
 *   1. FILTER    hard constraints knock 500 down to a workable candidate pool.
 *   2. BUILD     fill slots one at a time, each time taking the recipe with the
 *                lowest marginal cost given everything already chosen.
 *   3. IMPROVE   steepest-descent swaps until no single substitution helps.
 *   4. RESTART   do it several times from different seeds, keep the best.
 *
 * Slots are filled full → light → snack deliberately. Full meals dominate
 * ingredient volume, so committing to them first lets the light meals and snacks
 * be chosen specifically to mop up whatever the full meals left over — which is
 * exactly the role those slots play in a real kitchen.
 *
 * Everything here runs client-side in a few hundred milliseconds, so plan
 * generation works with no signal at all.
 */

import type {
  Id, Ingredient, MealType, PlanSlot, Recipe, SlotSpec, WeekPlan, WildcardItem,
} from '../types';
import type { BagLane } from '../grabbag';
import { type RecipeFilter, explainFilter } from '../filters';
import { seasonStatus } from '../seasonality';
import { makeRng } from '../rng';
import { type PlanningContext, type ScoreWeights, DEFAULT_WEIGHTS, scorePlan } from './scoring';
import {
  buildVariantIndex, chooseBestVariants, collapseToFamilies, familyIdOf,
} from '../variants';

export interface GenerateOptions {
  readonly spec: SlotSpec;
  /** Slots to keep exactly as-is. Regeneration respects these. */
  readonly pinnedSlots?: readonly PlanSlot[];
  /** Wildcards the user promoted — the plan must use these ingredients. */
  readonly wildcards?: readonly WildcardItem[];
  /**
   * Hard constraints on what may be planned. Same type the library browser uses,
   * so "show me X" and "plan a week of X" can never drift apart.
   */
  readonly filter?: RecipeFilter;
  readonly weights?: ScoreWeights;
  readonly restarts?: number;
  readonly seed?: number;
}

/**
 * Applies the user's filter plus the always-on settings constraints.
 *
 * Returns rejection counts alongside the candidates so that "no plan possible"
 * can explain itself — "34 recipes dropped for season, 12 for cooking time" tells
 * the user which control to loosen, where a bare empty list does not.
 */
export function filterCandidates(
  ctx: PlanningContext,
  opts: GenerateOptions,
): ReturnType<typeof explainFilter> {
  const base = opts.filter ?? {};

  const merged: RecipeFilter = {
    ...base,
    diets: [...new Set([...(base.diets ?? []), ...ctx.settings.diets])],
    excludeIngredients: [
      ...new Set([...(base.excludeIngredients ?? []), ...ctx.settings.excludedIngredients]),
    ],
  };

  return explainFilter(ctx.recipes.values(), merged, {
    ingredients: ctx.ingredients,
    region: ctx.region,
    month: ctx.month,
  });
}

/** The empty slots to fill, ordered full → light → snack. */
function buildSlotSkeleton(spec: SlotSpec, pinned: readonly PlanSlot[]): PlanSlot[] {
  const slots: PlanSlot[] = [...pinned];
  const counts: Array<[MealType, number]> = [
    ['full', spec.full],
    ['light', spec.light],
    ['snack', spec.snack],
  ];

  for (const [mealType, total] of counts) {
    const alreadyPinned = pinned.filter((s) => s.mealType === mealType).length;
    for (let i = alreadyPinned; i < total; i++) {
      slots.push({
        id: `${mealType}-${i}`,
        mealType,
        recipeId: null,
        servings: spec.servingsPerMeal[mealType],
        pinned: false,
      });
    }
  }

  return slots;
}

const MEAL_ORDER: readonly MealType[] = ['full', 'light', 'snack'];

/**
 * Greedy construction. At each step every eligible recipe is priced *in context*
 * of the partial plan, which is what lets the optimizer notice that a recipe is
 * cheap only because it finishes off a pack something else already opened.
 *
 * Selection is softmax over the top few rather than a strict argmin, so different
 * restarts explore genuinely different plans and "regenerate" gives a new answer.
 *
 * `open` is the meal types it is allowed to fill. Everything else in the skeleton
 * is priced and left alone, which is what rerolling one section of the week is.
 */
function greedyBuild(
  ctx: PlanningContext,
  candidates: readonly Recipe[],
  skeleton: readonly PlanSlot[],
  open: ReadonlySet<MealType>,
  wildcards: readonly WildcardItem[],
  weights: ScoreWeights,
  rng: () => number,
): PlanSlot[] {
  const slots = [...skeleton];
  // Every recipe the week already holds, not only the pinned ones. A skeleton
  // handed in for a section reroll arrives with the other meal types filled, and
  // those are as much "already used" as a pin is — without this, rerolling the
  // light meals could serve the same soup the full meals are already having.
  const used = new Set<Id>(slots.map((s) => s.recipeId).filter((id): id is Id => id !== null));

  for (const mealType of MEAL_ORDER) {
    if (!open.has(mealType)) continue;
    const pool = candidates.filter((r) => r.mealType === mealType);

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.mealType !== mealType || slot.recipeId !== null || slot.pinned) continue;

      const scored: Array<{ recipe: Recipe; cost: number }> = [];
      for (const recipe of pool) {
        if (used.has(recipe.id)) continue;
        slots[i] = { ...slot, recipeId: recipe.id };
        scored.push({ recipe, cost: scorePlan(slots, wildcards, ctx, weights).total });
      }
      slots[i] = slot; // restore before committing

      if (scored.length === 0) continue;
      scored.sort((a, b) => a.cost - b.cost);

      const chosen = softmaxPick(scored, rng);
      slots[i] = { ...slot, recipeId: chosen.id };
      used.add(chosen.id);
    }
  }

  return slots;
}

/** Picks from the best few candidates with exponential preference for the cheapest. */
function softmaxPick(scored: ReadonlyArray<{ recipe: Recipe; cost: number }>, rng: () => number): Recipe {
  const topK = scored.slice(0, Math.min(5, scored.length));
  const best = topK[0].cost;
  // Temperature is relative to the spread so the shape does not depend on units.
  const spread = Math.max(1e-6, topK[topK.length - 1].cost - best);
  const weights = topK.map((s) => Math.exp(-((s.cost - best) / spread) * 2));
  const total = weights.reduce((a, b) => a + b, 0);

  let r = rng() * total;
  for (let i = 0; i < topK.length; i++) {
    r -= weights[i];
    if (r <= 0) return topK[i].recipe;
  }
  return topK[0].recipe;
}

/**
 * Steepest-descent local search. Repeatedly tries every (slot, replacement) pair
 * and commits the single best improvement, stopping when none exists.
 *
 * This is what fixes greedy's characteristic mistake: an early choice that looked
 * cheap in isolation but stranded an ingredient nothing else uses.
 *
 * `open` means what it means in `greedyBuild`: the meal types on offer. A closed
 * slot still counts toward every score computed here — it is part of the week —
 * it is simply never the one that moves.
 */
function localSearch(
  ctx: PlanningContext,
  candidates: readonly Recipe[],
  slots: readonly PlanSlot[],
  open: ReadonlySet<MealType>,
  wildcards: readonly WildcardItem[],
  weights: ScoreWeights,
  maxIterations = 30,
): PlanSlot[] {
  let current = [...slots];
  let currentCost = scorePlan(current, wildcards, ctx, weights).total;

  for (let iter = 0; iter < maxIterations; iter++) {
    let bestCost = currentCost;
    let bestMove: { index: number; recipeId: Id } | null = null;

    const used = new Set<Id>(current.map((s) => s.recipeId).filter((id): id is Id => id !== null));

    for (let i = 0; i < current.length; i++) {
      const slot = current[i];
      if (slot.pinned || slot.recipeId === null || !open.has(slot.mealType)) continue;

      for (const recipe of candidates) {
        if (recipe.mealType !== slot.mealType || used.has(recipe.id)) continue;

        const trial = [...current];
        trial[i] = { ...slot, recipeId: recipe.id };
        const cost = scorePlan(trial, wildcards, ctx, weights).total;
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          bestMove = { index: i, recipeId: recipe.id };
        }
      }
    }

    if (!bestMove) break; // local optimum
    current[bestMove.index] = { ...current[bestMove.index], recipeId: bestMove.recipeId };
    currentCost = bestCost;
  }

  return current;
}

const ALL_MEAL_TYPES: ReadonlySet<MealType> = new Set(MEAL_ORDER);

/**
 * Build, improve, repeat; keep the best week of the lot.
 *
 * Whole-week generation and rerolling one kind of meal differ only in what they
 * hand in — the starting `skeleton` — and in what they let the search move
 * (`open`). Restarts are the reason pressing Regenerate twice gives two answers,
 * so a section reroll wants them exactly as much as a full plan does.
 */
function search(
  ctx: PlanningContext,
  candidates: readonly Recipe[],
  skeleton: readonly PlanSlot[],
  open: ReadonlySet<MealType>,
  wildcards: readonly WildcardItem[],
  weights: ScoreWeights,
  baseSeed: number,
  restarts: number,
): { slots: PlanSlot[]; improvements: number } {
  let bestSlots: PlanSlot[] | null = null;
  let bestCost = Infinity;
  let improvements = 0;

  for (let r = 0; r < restarts; r++) {
    const rng = makeRng(baseSeed + r * 7919);
    const built = greedyBuild(ctx, candidates, skeleton, open, wildcards, weights, rng);
    const refined = localSearch(ctx, candidates, built, open, wildcards, weights);
    const cost = scorePlan(refined, wildcards, ctx, weights).total;

    if (cost < bestCost) {
      bestCost = cost;
      bestSlots = refined;
      improvements++;
    }
  }

  return { slots: bestSlots ?? [...skeleton], improvements };
}

export interface GenerationResult {
  readonly plan: WeekPlan;
  readonly score: ReturnType<typeof scorePlan>;
  /** How many restarts actually produced a distinct improvement — useful for tuning. */
  readonly improvements: number;
  /** Candidate pool size after filtering, and why the rest were dropped. */
  readonly candidateCount: number;
  readonly rejections: ReadonlyMap<string, number>;
  /** Slots left empty because the filter left too few candidates to fill them. */
  readonly unfilledSlots: number;
}

/** Generates a week plan. Pure and deterministic given the same seed and context. */
export function generateWeekPlan(ctx: PlanningContext, opts: GenerateOptions): GenerationResult {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const restarts = opts.restarts ?? 6;
  const baseSeed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const pinned = opts.pinnedSlots ?? [];
  const wildcards = opts.wildcards ?? [];

  const { matched: candidates, rejections } = filterCandidates(ctx, opts);

  // The search chooses DISHES, so it is shown one member of each variant family.
  // Which member is cheapest depends on what the rest of the week has already
  // opened a pack of, and that is not knowable while the week is still forming.
  const { slots: chosen, improvements } = search(
    ctx,
    collapseToFamilies(candidates),
    buildSlotSkeleton(opts.spec, pinned),
    ALL_MEAL_TYPES,
    wildcards,
    weights,
    baseSeed,
    restarts,
  );

  const slots = [
    ...chooseBestVariants(
      chosen,
      wildcards,
      ctx,
      weights,
      new Set(candidates.map((r) => r.id)),
      buildVariantIndex(ctx.recipes.values()),
    ),
  ];

  return {
    plan: {
      id: `plan-${baseSeed}`,
      weekStartISO: new Date().toISOString().slice(0, 10),
      slots,
      wildcards,
      generatedAtISO: new Date().toISOString(),
      seed: baseSeed,
    },
    score: scorePlan(slots, wildcards, ctx, weights),
    improvements,
    candidateCount: candidates.length,
    rejections,
    unfilledSlots: slots.filter((s) => s.recipeId === null).length,
  };
}

export interface WildcardDrawOptions {
  /** Restrict the pool to one half of the produce shelf. Omit to draw from all of it. */
  readonly kind?: ProduceKind;
  /** Ingredients already in the bag. Never drawn again, so a top-up cannot duplicate. */
  readonly exclude?: ReadonlySet<Id>;
}

/** How many to draw, and from what. A `BagLane` is one of these. */
export type WildcardDraw = Pick<BagLane, 'count' | 'holds'>;

/**
 * Picks a grab bag: a random selection from one shelf of the library, biased
 * toward what is in season and what is on sale.
 *
 * Deliberately random rather than optimized. Its job is to break the rut that any
 * cost-minimizing optimizer inevitably falls into, so making it obey the same
 * objective would defeat the point.
 *
 * The season and sale weighting is applied to every shelf, not only produce. On
 * the dry shelves it flattens out: `seasonStatus` answers "peak" for everything
 * that is not produce, so every bread weighs the same as every other bread and
 * only the sale prices move anything. That is the right amount of nothing, and
 * far better than a second code path to keep in step with this one.
 */
export function pickWildcards(
  ctx: PlanningContext,
  draw: WildcardDraw,
  seed: number,
  exclude?: ReadonlySet<Id>,
): WildcardItem[] {
  const rng = makeRng(seed);

  const pool = [...ctx.ingredients.values()].filter(
    (ing) =>
      draw.holds(ing) &&
      !ctx.settings.excludedIngredients.includes(ing.id) &&
      // Diets are checked here and not only on recipes, which they were until
      // there were bags other than produce. Every vegetable passes every diet, so
      // the produce bag never noticed the gap; a cheese bag notices it on the
      // first draw, by offering a vegan a wedge of manchego. Allergens need no
      // line of their own — they arrive already folded into
      // `excludedIngredients`, which is the whole reason they are expanded there.
      !ing.excludesDiets?.some((diet) => ctx.settings.diets.includes(diet)) &&
      !exclude?.has(ing.id),
  );

  const weighted = pool.map((ing) => {
    const status = seasonStatus(ing, ctx.month, ctx.region);
    // Out-of-season produce stays in the pool at low weight rather than being
    // excluded — the grab bag is meant to surprise, and a January mango is a
    // legitimate thing to want.
    const seasonMultiplier =
      status === 'peak' ? 4 : status === 'available' ? 2 : status === 'unknown' ? 1 : 0.25;
    const sale = ctx.sales.get(ing.id);
    const onSale = sale !== undefined && sale.costPerKg < ing.purchase.costPerKg;
    return { ing, weight: seasonMultiplier * (onSale ? 2 : 1) };
  });

  const picked: WildcardItem[] = [];
  const remaining = [...weighted];

  while (picked.length < draw.count && remaining.length > 0) {
    const total = remaining.reduce((sum, w) => sum + w.weight, 0);
    let r = rng() * total;
    let index = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      r -= remaining[i].weight;
      if (r <= 0) { index = i; break; }
    }
    const { ing } = remaining.splice(index, 1)[0];
    picked.push({ ingredientId: ing.id, grams: ing.purchase.gramsPerPack, promoted: false });
  }

  return picked;
}

// ---------------------------------------------------------------------------
// Fitting a bag to its target size
// ---------------------------------------------------------------------------

/**
 * Brings every bag to its target size, keeping what is already in them.
 *
 * Used for both "redraw" (call with only the items worth keeping) and for the
 * size steppers (call with everything, and it tops up or trims). Trimming drops
 * un-promoted items first and from the end, so shrinking a bag by one never
 * discards something the user deliberately promoted, and never reshuffles the
 * items they are still looking at.
 *
 * ANYTHING THAT MATCHES NO LANE IS DROPPED. That is how a bag empties when it is
 * switched off, and how an ingredient that has left the library stops being
 * rendered as a blank row. It is the same bargain `fitTreats` makes with a treat
 * that has left the catalogue.
 *
 * The draw is capped at what the library can actually offer: asking for eight
 * cheeses when there are three returns three. That is a library problem, and
 * quietly padding it from another shelf would hide it.
 */
export function fitWildcards(
  ctx: PlanningContext,
  lanes: readonly BagLane[],
  seed: number,
  keep: readonly WildcardItem[] = [],
): WildcardItem[] {
  const ingredientOf = (w: WildcardItem): Ingredient | undefined =>
    ctx.ingredients.get(w.ingredientId);

  // Everything held on to across the whole draw, so a lane cannot hand back
  // something another lane is already keeping.
  const held = new Set(
    keep.filter((w) => {
      const ing = ingredientOf(w);
      return ing !== undefined && lanes.some((lane) => lane.holds(ing));
    }).map((w) => w.ingredientId),
  );

  const out: WildcardItem[] = [];

  lanes.forEach((lane, i) => {
    const mine = keep.filter((w) => {
      const ing = ingredientOf(w);
      return ing !== undefined && lane.holds(ing);
    });

    const kept = mine.length <= lane.count
      ? mine
      : [...mine].sort((a, b) => Number(b.promoted) - Number(a.promoted)).slice(0, lane.count);

    // Distinct seeds per lane, or every bag would walk the same RNG stream.
    const fresh = pickWildcards(
      ctx,
      { count: lane.count - kept.length, holds: lane.holds },
      seed + i * 104729,
      held,
    );
    // Two lanes should never offer the same thing anyway — the shelves are
    // disjoint — but holding on to what has been drawn means that stays a fact
    // about the shelves rather than something this loop depends on.
    for (const w of fresh) held.add(w.ingredientId);

    // Original order is restored after the promoted-first sort used for trimming,
    // so the list on screen does not jump around when the stepper is pressed.
    out.push(...mine.filter((w) => kept.includes(w)), ...fresh);
  });

  return out;
}
