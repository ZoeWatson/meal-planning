/**
 * Recipe variants — the same dish with one thing swapped.
 *
 * A great many recipes differ from each other by a single ingredient. Written out
 * as separate recipes they triple the size of the library without widening it,
 * and they actively damage the plans: three near-identical donburi compete for the
 * same slot, and `varietyPenalty` — which works on proteins and tags — cannot see
 * that they are the same dinner.
 *
 * So a family is ONE choice. The planner is shown a single member, and only once
 * the week is otherwise settled does it ask which member that week can buy most
 * cheaply. That ordering matters: which mushroom is cheapest depends entirely on
 * what the other six meals already opened a pack of, so it is not knowable while
 * the meals are still being chosen.
 *
 * The rule that makes this safe is that a variant must be the same DISH — same
 * meal type, same method, one swapped ingredient. A variant that is really a
 * different recipe belongs in the library as one.
 */

import type { Id, Ingredient, PlanSlot, Recipe, RecipeIngredient, WildcardItem } from './types';
import { type PlanningContext, type ScoreWeights, scorePlan } from './planner/scoring';
import { formatQuantity } from './units';

/** The family a recipe belongs to, named by its parent's id. */
export function familyIdOf(recipe: Pick<Recipe, 'id' | 'variantOf'>): Id {
  return recipe.variantOf ?? recipe.id;
}

export interface VariantIndex {
  /** Family id → every member, parent first, then variants in library order. */
  readonly members: ReadonlyMap<Id, readonly Id[]>;
}

export function buildVariantIndex(recipes: Iterable<Recipe>): VariantIndex {
  const members = new Map<Id, Id[]>();

  // Two passes so that a variant appearing before its parent still lands behind
  // it. Import order is not something callers should have to think about.
  const all = [...recipes];
  for (const r of all) {
    if (r.variantOf === undefined) members.set(r.id, [r.id]);
  }
  for (const r of all) {
    if (r.variantOf === undefined) continue;
    const family = members.get(r.variantOf);
    // A dangling parent means the family is just this recipe. The importer
    // rejects that case; this keeps the index total for any other caller.
    if (family) family.push(r.id);
    else members.set(r.id, [r.id]);
  }

  return { members };
}

/** Every member of this recipe's family, parent first. Always includes the recipe. */
export function familyMembers(index: VariantIndex, recipe: Recipe): readonly Id[] {
  return index.members.get(familyIdOf(recipe)) ?? [recipe.id];
}

/**
 * One recipe per family, from an already-filtered list.
 *
 * The parent is preferred because it is the version the steps are written for,
 * but a family whose parent was filtered out is still reachable through whichever
 * variant survived — excluding a whole family because the default uses an
 * ingredient you are allergic to would hide dishes you can eat.
 */
export function collapseToFamilies(recipes: readonly Recipe[]): Recipe[] {
  const seen = new Set<Id>();
  const out: Recipe[] = [];

  for (const r of recipes) {
    if (r.variantOf !== undefined) continue;
    seen.add(r.id);
    out.push(r);
  }
  for (const r of recipes) {
    if (r.variantOf === undefined) continue;
    const family = familyIdOf(r);
    if (seen.has(family)) continue;
    seen.add(family);
    out.push(r);
  }

  return out;
}

/**
 * Swaps each slot for the member of its family that scores best.
 *
 * Run after the week is chosen, not during: the whole value of a variant is that
 * it can use a pack something else already opened, and which pack that is only
 * exists once the other meals are fixed.
 *
 * Greedy and one slot at a time. Slots and families are both small, so this is a
 * few dozen extra `scorePlan` calls against the thousands the search itself
 * makes, and a full joint optimisation would buy a rounding error.
 *
 * Two rules it will not break:
 *   - pinned slots are left alone, because a pin names a meal and swapping its
 *     mushroom is not keeping it;
 *   - only members that survived filtering are considered, or a plan could be
 *     handed back containing the allergen the filter just removed.
 */
export function chooseBestVariants(
  slots: readonly PlanSlot[],
  wildcards: readonly WildcardItem[],
  ctx: PlanningContext,
  weights: ScoreWeights,
  allowed: ReadonlySet<Id>,
  index: VariantIndex,
  /**
   * Which slots may be substituted. Rerolling one section must not quietly swap
   * the mushroom in a meal the user left alone.
   */
  eligible: (slot: PlanSlot) => boolean = () => true,
): readonly PlanSlot[] {
  let current = [...slots];
  let best = scorePlan(current, wildcards, ctx, weights).total;

  for (let i = 0; i < current.length; i++) {
    const slot = current[i];
    if (slot.recipeId === null || slot.pinned || !eligible(slot)) continue;

    const recipe = ctx.recipes.get(slot.recipeId);
    if (!recipe) continue;

    const siblings = familyMembers(index, recipe).filter(
      (id) => id !== slot.recipeId && allowed.has(id) && !usedElsewhere(current, i, id),
    );
    if (siblings.length === 0) continue;

    for (const candidateId of siblings) {
      const trial = [...current];
      trial[i] = { ...slot, recipeId: candidateId };
      const score = scorePlan(trial, wildcards, ctx, weights).total;
      // Strictly better only, so an equal-scoring variant never displaces the
      // parent. Otherwise the same week would shuffle its variants on every
      // regenerate for no gain the user can see.
      if (score < best) {
        best = score;
        current = trial;
      }
    }
  }

  return current;
}

/** A week carries a recipe at most once, and two members of a family are still two meals. */
function usedElsewhere(slots: readonly PlanSlot[], skipIndex: number, id: Id): boolean {
  return slots.some((s, i) => i !== skipIndex && s.recipeId === id);
}

export interface SwappedRecipe {
  readonly name: string;
  readonly ingredients: readonly RecipeIngredient[];
  readonly variantOf: Id;
  readonly variantLabel: string;
}

/**
 * The pure half of a shopping-list ingredient swap: feta for a cheaper cheese, a
 * vegetable for whatever is on sale.
 *
 * Written as a new variant rather than an edit to `recipe` itself, for the same
 * reason every other variant exists — the swap should not change what the
 * recipe book hands back to a week that already relied on the original. Mass is
 * carried over unchanged rather than reconverted from the written quantity, so a
 * swap can never quietly inflate or shrink what the plan buys — only what it
 * buys it as. `variantOf` points at the family, not at `recipe.id`, so swapping
 * inside an existing variant still produces a sibling rather than a nested one.
 *
 * Returns `undefined` if the recipe does not contain `fromIngredientId`, or the
 * replacement is the same ingredient — nothing to swap either way.
 */
export function swapRecipeIngredient(
  recipe: Recipe,
  fromIngredientId: Id,
  toIngredient: Ingredient,
): SwappedRecipe | undefined {
  const oldLine = recipe.ingredients.find((ri) => ri.ingredientId === fromIngredientId);
  if (!oldLine || oldLine.ingredientId === toIngredient.id) return undefined;

  const quantity = formatQuantity(oldLine.grams, toIngredient, 'metric');
  const ingredients = recipe.ingredients.map((ri): RecipeIngredient => (
    ri.ingredientId === fromIngredientId
      ? {
        ingredientId: toIngredient.id,
        quantity: quantity.value,
        unit: quantity.unit,
        grams: oldLine.grams,
        optional: ri.optional,
        scaling: ri.scaling,
      }
      : ri
  ));

  const variantLabel = `with ${toIngredient.name}`;
  return {
    name: `${recipe.name} (${variantLabel})`,
    ingredients,
    variantOf: familyIdOf(recipe),
    variantLabel,
  };
}
