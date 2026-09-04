/**
 * Allergens.
 *
 * This is the one feature in the app where being wrong has consequences beyond a
 * wasted vegetable, so it is built differently from everything else here:
 *
 *  1. **Groups, not individual ingredients.** Ticking "tree nuts" has to cover
 *     almonds, cashews, walnuts and the rest at once. Asking someone to exclude
 *     each nut by hand is exactly how one gets missed.
 *
 *  2. **Name inference as a backstop.** An imported ingredient called "cashew
 *     butter" with no allergen data must still be caught. Inference can only ever
 *     ADD a match, never clear one — a guess may raise the alarm, never silence it.
 *
 *  3. **Unknowns are reported, not assumed safe.** A recipe referencing an
 *     ingredient the app cannot resolve gets "cannot verify", not a clean bill of
 *     health. Silence that looks like safety is the dangerous failure here.
 *
 *  4. **Loud, not silent.** Everything else in this app filters quietly. Allergens
 *     are surfaced wherever a matching recipe could still appear, because a plan
 *     made before the allergy was set, or a pinned slot, slips past any
 *     generation-time filter.
 *
 * WHAT THIS CANNOT DO, and what the UI says plainly: it matches against the
 * ingredient list in this app. It knows nothing about processing, shared
 * equipment, "may contain" warnings, or a recipe that says "curry paste" without
 * saying what is in it. It is a planning aid, not a substitute for reading labels.
 */

import type { Id, Ingredient, Recipe } from './types';

export interface AllergenGroup {
  readonly id: string;
  readonly label: string;
  /** Shown under the toggle, so the scope of a group is never left to guesswork. */
  readonly covers: string;
  /**
   * Name fragments used to catch ingredients carrying no explicit allergen data.
   * Matched against name and aliases.
   */
  readonly keywords: readonly string[];
  /**
   * Name fragments that VETO a keyword match for this group.
   *
   * Generic keywords are unavoidable — "milk" and "butter" have to be in the dairy
   * list — and they misfire badly: butternut squash, coconut milk, oat milk and
   * peanut butter all matched dairy before this existed. Six false positives in a
   * ten-item probe, which is more than a cosmetic problem: warnings that are
   * usually wrong get dismissed reflexively, and then the real one is dismissed too.
   *
   * Vetoes are per-group, so "almond milk" still correctly matches tree nuts while
   * no longer claiming to be dairy.
   */
  readonly exceptions?: readonly string[];
}

/**
 * Health Canada's priority allergens — the right default list for BC, and a
 * superset of most others. Gluten sits with wheat because the practical question
 * a cook is asking is the same one.
 */
export const ALLERGEN_GROUPS: readonly AllergenGroup[] = [
  {
    id: 'peanuts',
    label: 'Peanuts',
    covers: 'Peanuts, peanut butter, peanut oil',
    keywords: ['peanut', 'groundnut', 'arachis'],
  },
  {
    id: 'tree-nuts',
    label: 'Tree nuts',
    covers: 'Almond, cashew, walnut, pecan, pistachio, hazelnut, macadamia, pine nut',
    keywords: [
      'almond', 'cashew', 'walnut', 'pecan', 'pistachio', 'hazelnut', 'filbert',
      'macadamia', 'brazil nut', 'pine nut', 'praline', 'marzipan', 'nutella',
      'chestnut', 'nut butter', 'mixed nuts',
    ],
    // Coconut and nutmeg are not tree nuts, and water chestnuts are not chestnuts.
    exceptions: ['coconut', 'nutmeg', 'water chestnut', 'peanut butter'],
  },
  {
    id: 'milk',
    label: 'Milk',
    covers: 'Milk, cheese, butter, cream, yogurt, whey, casein',
    keywords: [
      'milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', 'whey', 'casein',
      'ghee', 'curd', 'custard', 'feta', 'parmesan', 'mozzarella', 'cheddar',
      'ricotta', 'mascarpone', 'halloumi', 'paneer',
    ],
    exceptions: [
      'coconut milk', 'coconut cream', 'almond milk', 'oat milk', 'soy milk',
      'rice milk', 'cashew milk', 'hemp milk', 'non-dairy', 'dairy-free',
      'peanut butter', 'nut butter', 'butternut', 'cocoa butter', 'shea butter',
      'apple butter', 'body butter', 'milk thistle',
      // Plant butters are named "<something> butter" and are not dairy. The nut
      // ones still match tree-nuts correctly; only the dairy claim is vetoed.
      'almond butter', 'cashew butter', 'sunflower butter', 'seed butter',
      'soy butter', 'coconut butter', 'pumpkin seed butter',
    ],
  },
  {
    id: 'eggs',
    label: 'Eggs',
    covers: 'Eggs, mayonnaise, meringue, albumin',
    keywords: ['egg', 'mayonnaise', 'mayo', 'meringue', 'albumin', 'aioli'],
  },
  {
    id: 'fish',
    label: 'Fish',
    covers: 'All finned fish, fish sauce, anchovy, Worcestershire sauce',
    keywords: [
      'fish', 'salmon', 'tuna', 'cod', 'haddock', 'halibut', 'trout', 'bass',
      'anchov', 'sardine', 'mackerel', 'herring', 'tilapia', 'snapper', 'sole',
      'worcestershire', 'bonito', 'surimi',
    ],
  },
  {
    id: 'shellfish',
    label: 'Shellfish',
    covers: 'Crustaceans and molluscs — prawn, crab, lobster, mussel, clam, squid',
    keywords: [
      'shrimp', 'prawn', 'crab', 'lobster', 'crayfish', 'langoustine', 'scampi',
      'mussel', 'clam', 'oyster', 'scallop', 'squid', 'calamari', 'octopus',
      'shellfish', 'seafood',
    ],
  },
  {
    id: 'sesame',
    label: 'Sesame',
    covers: 'Sesame seeds, tahini, hummus, halva',
    keywords: ['sesame', 'tahini', 'tahina', 'halva', 'benne', 'gomashio', 'zaatar'],
  },
  {
    id: 'soy',
    label: 'Soy',
    covers: 'Soy sauce, tofu, tempeh, edamame, miso',
    keywords: ['soy', 'soya', 'tofu', 'tempeh', 'edamame', 'miso', 'tamari', 'natto'],
  },
  {
    id: 'wheat',
    label: 'Wheat & gluten',
    covers: 'Wheat, barley, rye, most bread and pasta, couscous, soy sauce',
    keywords: [
      'wheat', 'flour', 'bread', 'pasta', 'spaghetti', 'penne', 'noodle',
      'couscous', 'barley', 'rye', 'semolina', 'spelt', 'farro', 'bulgur',
      'seitan', 'panko', 'breadcrumb', 'tortilla', 'pastry', 'cracker',
      'soy sauce', 'orzo', 'gnocchi',
    ],
  },
  {
    id: 'mustard',
    label: 'Mustard',
    covers: 'Mustard seed, prepared mustard, many dressings',
    keywords: ['mustard', 'dijon'],
  },
  {
    id: 'sulphites',
    label: 'Sulphites',
    covers: 'Wine, vinegar, dried fruit, some processed foods',
    keywords: ['sulphite', 'sulfite', 'wine', 'dried apricot', 'molasses'],
  },
];

const GROUPS_BY_ID = new Map(ALLERGEN_GROUPS.map((g) => [g.id, g]));

export function allergenGroup(id: string): AllergenGroup | undefined {
  return GROUPS_BY_ID.get(id);
}

export function allergenLabel(id: string): string {
  return GROUPS_BY_ID.get(id)?.label ?? id;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type MatchConfidence = 'declared' | 'inferred';

export interface AllergenMatch {
  readonly allergenId: string;
  readonly ingredientId: Id;
  readonly ingredientName: string;
  /**
   * `declared` — the ingredient explicitly lists this allergen.
   * `inferred` — matched on its name. Right far more often than not, but a guess,
   * and labelled as one so a person can judge it themselves.
   */
  readonly confidence: MatchConfidence;
}

/**
 * Keyword match against a name.
 *
 * Boundary-aware at the start so "nut" cannot fire on "coconut" or "nutmeg", but
 * deliberately loose at the end so plurals and compounds ("almonds", "peanut
 * butter") are caught. The asymmetry is intentional: over-matching costs a false
 * warning, under-matching costs a reaction.
 */
function nameMatches(haystack: string, keyword: string): boolean {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(keyword, from);
    if (index === -1) return false;
    const before = index === 0 ? ' ' : haystack[index - 1];
    if (!/[a-z]/.test(before)) return true;
    from = index + 1;
  }
}

/**
 * Every allergen an ingredient carries, declared or inferred from its name.
 *
 * `allergensVerified` turns inference off for that ingredient: its declared list
 * is taken as complete. Reserved for the curated library, where guessing on top
 * of checked data only adds noise. Anything imported keeps the safety net.
 */
export function ingredientAllergens(ingredient: Ingredient): Map<string, MatchConfidence> {
  const found = new Map<string, MatchConfidence>();

  for (const id of ingredient.allergens ?? []) {
    found.set(id, 'declared');
  }

  if (ingredient.allergensVerified) return found;

  const haystacks = [ingredient.name, ...ingredient.aliases].map((s) => s.toLowerCase());

  for (const group of ALLERGEN_GROUPS) {
    // A declared match already stands; inference must never downgrade it.
    if (found.has(group.id)) continue;
    if (group.exceptions?.some((veto) => haystacks.some((h) => h.includes(veto)))) continue;

    for (const keyword of group.keywords) {
      if (haystacks.some((h) => nameMatches(h, keyword))) {
        found.set(group.id, 'inferred');
        break;
      }
    }
  }

  return found;
}

export interface RecipeAllergenReport {
  readonly matches: readonly AllergenMatch[];
  /**
   * Ingredient ids the recipe references that are not in the library.
   *
   * Their contents are unknown, so no allergen claim can be made about the recipe
   * at all. Reported rather than ignored: "nothing found" and "could not check"
   * must never look the same.
   */
  readonly unverifiable: readonly Id[];
  readonly hasMatch: boolean;
}

const CLEAR: RecipeAllergenReport = { matches: [], unverifiable: [], hasMatch: false };

/**
 * Checks one recipe against a set of active allergens.
 *
 * Optional ingredients are INCLUDED. They can still end up in the dish, and a
 * warning about something you meant to leave out is a small annoyance measured
 * against the alternative.
 */
export function checkRecipe(
  recipe: Recipe,
  ingredients: ReadonlyMap<Id, Ingredient>,
  activeAllergens: readonly string[],
): RecipeAllergenReport {
  if (activeAllergens.length === 0) return CLEAR;

  const active = new Set(activeAllergens);
  const matches: AllergenMatch[] = [];
  const unverifiable: Id[] = [];

  for (const line of recipe.ingredients) {
    const ingredient = ingredients.get(line.ingredientId);
    if (!ingredient) {
      unverifiable.push(line.ingredientId);
      continue;
    }

    for (const [allergenId, confidence] of ingredientAllergens(ingredient)) {
      if (!active.has(allergenId)) continue;
      matches.push({
        allergenId,
        ingredientId: ingredient.id,
        ingredientName: ingredient.name,
        confidence,
      });
    }
  }

  return { matches, unverifiable, hasMatch: matches.length > 0 };
}

/** One-line summary for a badge or warning banner. */
export function describeMatches(matches: readonly AllergenMatch[]): string {
  const byAllergen = new Map<string, string[]>();

  for (const match of matches) {
    const names = byAllergen.get(match.allergenId) ?? [];
    if (!names.includes(match.ingredientName)) names.push(match.ingredientName);
    byAllergen.set(match.allergenId, names);
  }

  return [...byAllergen.entries()]
    .map(([id, names]) => `${allergenLabel(id)} (${names.join(', ')})`)
    .join('; ');
}

/**
 * Ingredient ids to exclude outright, expanded from the active allergen groups.
 *
 * Feeds the existing `excludedIngredients` machinery rather than introducing a
 * second exclusion path, so allergens reach generation, the grocery list and the
 * wildcard draw through code that is already exercised — and cannot drift out of
 * step with it.
 */
export function excludedByAllergens(
  ingredients: Iterable<Ingredient>,
  activeAllergens: readonly string[],
): Id[] {
  if (activeAllergens.length === 0) return [];

  const active = new Set(activeAllergens);
  const excluded: Id[] = [];

  for (const ingredient of ingredients) {
    for (const allergenId of ingredientAllergens(ingredient).keys()) {
      if (active.has(allergenId)) {
        excluded.push(ingredient.id);
        break;
      }
    }
  }

  return excluded;
}
