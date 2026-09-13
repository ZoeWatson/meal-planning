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
import type { TreatItem } from '../treats';
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
   * The week's treat bag, carried onto the plan untouched.
   *
   * Nothing here scores it and nothing here reads it: a bar of chocolate and a
   * face mask have no bearing on which meals overlap. It travels through
   * generation only so that planning a week produces one complete plan, rather
   * than a plan plus a second write that a crash could lose.
   */
  readonly treats?: readonly TreatItem[];
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
  opts: Pick<GenerateOptions, 'filter'>,
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
        // Numbered around what the pinned slots already answer to rather than from
        // the pinned count: pinning the third full meal and regenerating used to
        // mint a second slot called `full-2`, and every write to one hit both.
        id: freeSlotId(slots, mealType),
        mealType,
        recipeId: null,
        servings: spec.servingsPerMeal[mealType],
        pinned: false,
      });
    }
  }

  return slots;
}

/**
 * Puts a recipe into the week by hand.
 *
 * Picked by name from the library rather than by the optimizer, so it goes into
 * an empty slot of its own meal type if the week has one — that is exactly the
 * hole the "could not be filled" warning is about — and otherwise gets a slot of
 * its own. It never displaces a meal the optimizer chose: what is already there
 * is on screen, and trading one for the other is the user's call to make, not
 * this function's to make quietly.
 *
 * It lands pinned. The alternative is that the next Shuffle all throws away the
 * one meal in the week that was asked for by name.
 *
 * Adding a recipe the week already holds changes nothing. A plan carries a recipe
 * at most once everywhere else in the app — the pick sheet will not offer one the
 * week already has — and this is that same rule rather than a new one.
 */
export function placeRecipe(
  slots: readonly PlanSlot[],
  recipe: Pick<Recipe, 'id' | 'mealType'>,
  servings: number,
): readonly PlanSlot[] {
  if (slots.some((s) => s.recipeId === recipe.id)) return slots;

  const empty = slots.findIndex((s) => s.recipeId === null && s.mealType === recipe.mealType);
  const placed: PlanSlot = {
    // Filling an empty slot keeps that slot's id, so anything already keyed to it
    // — a ticked grocery line, a pin — goes on meaning what it meant.
    id: empty === -1 ? freeSlotId(slots, recipe.mealType) : slots[empty].id,
    mealType: recipe.mealType,
    recipeId: recipe.id,
    servings: Math.max(1, Math.round(servings)),
    pinned: true,
  };

  return empty === -1
    ? [...slots, placed]
    : slots.map((slot, i) => (i === empty ? placed : slot));
}

/**
 * The first `mealType-n` no slot in this plan is using.
 *
 * Slot ids are unique within a plan and nowhere else, and they are numbered from
 * zero per meal type. Anything minting a new one has to step around what is
 * already there, or two slots answer to the same id and every per-slot write —
 * pin, portions, shuffle — lands on both.
 */
function freeSlotId(slots: readonly PlanSlot[], mealType: MealType): Id {
  const taken = new Set(slots.map((s) => s.id));
  let i = 0;
  while (taken.has(`${mealType}-${i}`)) i++;
  return `${mealType}-${i}`;
}

/**
 * Takes a meal out of the week.
 *
 * The week gets SHORTER rather than gaining an empty slot, and that is the whole
 * difference between this and clearing a slot's recipe. An empty slot is a hole
 * the week still wants filled: it is what the "could not be filled" warning
 * counts, and what the card's own Shuffle offers to fill. A meal you have taken
 * out is not wanted, and a week with three dinners left in it should say three.
 *
 * The removal is an edit to this week, not a change to how big a week is — the
 * next Regenerate, or Shuffle all over that kind of meal, rebuilds the section to
 * whatever shape Settings asks for. Which is the right way round: "not this
 * Thursday" and "we eat four dinners a week" are different statements, and only
 * the second one belongs in Settings.
 */
export function dropSlot(slots: readonly PlanSlot[], slotId: Id): readonly PlanSlot[] {
  return slots.filter((s) => s.id !== slotId);
}

/**
 * Puts a removed meal back where it was — recipe, portions and pin and all.
 *
 * What Undo calls. `index` is where the slot sat before it went, which is a
 * position rather than an anchor: the week can have moved underneath it in the
 * meantime, so it is clamped rather than trusted.
 *
 * A slot whose id the week has since handed out again is dropped instead. That is
 * not hypothetical — a section shuffle numbers its new slots around whichever ids
 * are free, so the one just vacated is the first it reaches for — and two slots
 * answering to one id means every per-slot write from then on lands on both.
 */
export function reinstateSlot(
  slots: readonly PlanSlot[],
  slot: PlanSlot,
  index: number,
): readonly PlanSlot[] {
  if (slots.some((s) => s.id === slot.id)) return slots;
  const at = Math.max(0, Math.min(index, slots.length));
  return [...slots.slice(0, at), slot, ...slots.slice(at)];
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
      treats: opts.treats ?? [],
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

/**
 * What rerolling one kind of meal needs to know.
 *
 * The whole-week options minus the three that mean nothing here: the meals being
 * kept arrive inside `slots` rather than as `pinnedSlots`, and neither the treat
 * bag nor a new plan id is any of this function's business.
 */
export type RerollOptions = Pick<
  GenerateOptions, 'spec' | 'wildcards' | 'filter' | 'weights' | 'restarts' | 'seed'
>;

/**
 * Rerolls one kind of meal and leaves the rest of the week standing.
 *
 * Not the same thing as generating a week and keeping the parts you liked,
 * because the parts kept still have to COUNT. Overlap between meals is the entire
 * point of the optimizer, so a new set of light meals is chosen knowing which
 * packs the full meals have already opened — which is also why generation fills
 * full → light → snack in that order. The untouched slots are handed to the
 * scorer whole and merely withheld from the search.
 *
 * Pinned meals of the rerolled type survive, as a pin does everywhere else, and
 * the section is brought to the size Settings asks for — the rule Regenerate
 * follows, narrowed to one heading, so there is still exactly one answer to "how
 * many light meals do I have".
 *
 * Returns the whole week, not the section: a caller stitching two lists back
 * together would be a second place that knows how slots are ordered.
 */
export function regenerateMeals(
  ctx: PlanningContext,
  slots: readonly PlanSlot[],
  mealType: MealType,
  opts: RerollOptions,
): PlanSlot[] {
  const skeleton = sectionSkeleton(slots, opts.spec, mealType);
  const { matched } = filterCandidates(ctx, opts);

  const outgoing = new Set<Id>(
    slots
      .filter((s) => s.mealType === mealType && !s.pinned && s.recipeId !== null)
      .map((s) => s.recipeId as Id),
  );

  const wildcards = opts.wildcards ?? [];
  const weights = opts.weights ?? DEFAULT_WEIGHTS;

  const searched = search(
    ctx,
    pruneOutgoing(collapseToFamilies(matched), mealType, outgoing, skeleton),
    skeleton,
    new Set([mealType]),
    wildcards,
    weights,
    opts.seed ?? Math.floor(Math.random() * 2 ** 31),
    opts.restarts ?? 6,
  ).slots;

  // Only the rerolled section may be substituted. The meals left standing are
  // being kept, and swapping the mushroom inside one is not keeping it.
  return [
    ...chooseBestVariants(
      searched,
      wildcards,
      ctx,
      weights,
      new Set(matched.map((r) => r.id)),
      buildVariantIndex(ctx.recipes.values()),
      (slot) => slot.mealType === mealType,
    ),
  ];
}

/**
 * The candidate pool with the meals on their way out taken off it.
 *
 * Rerolling a section while the rest of the week stands still has ONE best
 * answer, and the optimizer finds it every time: press Regenerate on the light
 * meals twice and the same three come back, which reads as a broken button
 * rather than as a confident one. Restarts do not help — they vary where the
 * search starts, not where a frozen week lets it finish.
 *
 * So the rejected meals are excluded from their own replacement. Pressing the
 * button IS the rejection, which makes this the cheapest honest answer and the
 * same bargain the grab bag strikes by drawing at random rather than optimizing:
 * the optimizer's rut is a feature everywhere except the button for escaping it.
 *
 * Unless there is nothing to replace them with. A library holding four light
 * recipes cannot honour a rejection and still fill three slots, and an empty slot
 * is by far the worse of the two answers, so there they go back in.
 */
function pruneOutgoing(
  candidates: readonly Recipe[],
  mealType: MealType,
  outgoing: ReadonlySet<Id>,
  skeleton: readonly PlanSlot[],
): readonly Recipe[] {
  if (outgoing.size === 0) return candidates;

  // What the rest of the week is already having is spoken for too — greedy build
  // will not serve the same recipe twice, so those cannot count toward filling.
  const taken = new Set(skeleton.map((s) => s.recipeId).filter((id): id is Id => id !== null));
  const toFill = skeleton.filter((s) => s.mealType === mealType && s.recipeId === null).length;
  const fresh = candidates.filter(
    (r) => r.mealType === mealType && !outgoing.has(r.id) && !taken.has(r.id),
  ).length;

  return fresh >= toFill ? candidates.filter((r) => !outgoing.has(r.id)) : candidates;
}

/**
 * The week with one kind of meal emptied out and resized, ready to be filled.
 *
 * Everything of another type is carried across exactly as it stands — recipe,
 * portions, pin and all — because the point of rerolling a section is that the
 * rest of the week does not move. An unpinned slot of the rerolled type keeps
 * neither its recipe nor the portions it was set to: it is about to become a
 * different meal, and the portions belonged to the old one.
 */
function sectionSkeleton(
  slots: readonly PlanSlot[],
  spec: SlotSpec,
  mealType: MealType,
): PlanSlot[] {
  const out = slots.filter((s) => s.mealType !== mealType);
  const kept = slots.filter((s) => s.mealType === mealType && s.pinned && s.recipeId !== null);
  out.push(...kept);

  for (let i = kept.length; i < spec[mealType]; i++) {
    out.push({
      // Numbered around what is already taken, for the reason `freeSlotId` gives:
      // two slots answering to one id means every per-slot write lands on both.
      id: freeSlotId(out, mealType),
      mealType,
      recipeId: null,
      servings: spec.servingsPerMeal[mealType],
      pinned: false,
    });
  }

  return out;
}

/**
 * What redrawing a single meal needs to know.
 *
 * The section options plus the recipes this slot has already been offered and
 * had turned down. They cannot be inferred from the week — the whole point is
 * that they are no longer in it — so the caller holding the button holds them.
 */
export type SlotRerollOptions = RerollOptions & {
  readonly exclude?: ReadonlySet<Id>;
};

/**
 * Throws out one meal and draws another for its slot, leaving the rest of the
 * week exactly where it is.
 *
 * The narrowest version of the same bargain the section reroll makes: not
 * fancying Tuesday's curry is not a reason to lose the other three dinners, and
 * a section regenerate makes the curry cost them. Candidates are still priced
 * against the whole week, so the replacement is chosen knowing which packs the
 * other meals have already opened.
 *
 * Deliberately a softmax draw over the best few rather than a `search` — no
 * local search, no restarts. With one slot open there is only one move to make,
 * so steepest descent would find the single cheapest recipe every time and the
 * button would hand back the same meal on every press. Randomness among good
 * answers is the feature here, not a compromise.
 *
 * Portions go back to whatever the spec says, for the reason `sectionSkeleton`
 * gives: this is about to be a different meal, and the portions belonged to the
 * old one.
 *
 * Returns `null` rather than the week unchanged when there is nothing to draw —
 * a pinned slot, or a pool emptied by filters, by the rest of the week and by
 * what has already been passed over. A caller can then say so, which is the
 * difference between a button that declines and a button that looks broken.
 */
export function rerollSlot(
  ctx: PlanningContext,
  slots: readonly PlanSlot[],
  slotId: Id,
  opts: SlotRerollOptions,
): PlanSlot[] | null {
  const index = slots.findIndex((s) => s.id === slotId);
  if (index === -1) return null;

  const slot = slots[index];
  // A pin means keep, here as everywhere else. The screen disables the button
  // over a pinned meal, so this is the rule living next to the code that knows
  // what a pin is rather than only in the markup.
  if (slot.pinned) return null;

  // Everything the week is already having, which at this point still includes
  // the meal being thrown out — that is exactly the one not to draw again.
  const taken = new Set(slots.map((s) => s.recipeId).filter((id): id is Id => id !== null));

  const { matched } = filterCandidates(ctx, opts);
  const pool = matched.filter(
    (r) => r.mealType === slot.mealType && !taken.has(r.id) && !opts.exclude?.has(r.id),
  );
  if (pool.length === 0) return null;

  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const wildcards = opts.wildcards ?? [];

  const trial = [...slots];
  const scored = pool.map((recipe) => {
    trial[index] = { ...slot, recipeId: recipe.id };
    return { recipe, cost: scorePlan(trial, wildcards, ctx, weights).total };
  });
  scored.sort((a, b) => a.cost - b.cost);

  // One entry per variant family, and it is the member this particular week
  // suits best. The swap sheet shows a handful of alternatives; three
  // near-identical donburi would spend most of them on one dish. Scoring first
  // and thinning afterwards is what makes the survivor the right member.
  const byFamily = new Set<Id>();
  const distinct = scored.filter(({ recipe }) => {
    const family = familyIdOf(recipe);
    if (byFamily.has(family)) return false;
    byFamily.add(family);
    return true;
  });

  const chosen = softmaxPick(distinct, makeRng(opts.seed ?? Math.floor(Math.random() * 2 ** 31)));

  const out = [...slots];
  out[index] = {
    ...slot,
    recipeId: chosen.id,
    servings: opts.spec.servingsPerMeal[slot.mealType],
  };
  return out;
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
