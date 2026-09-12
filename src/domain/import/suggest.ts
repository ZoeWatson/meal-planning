/**
 * Near-miss ingredient matching.
 *
 * The most common way a captured recipe fails is not an ingredient you do not
 * have — it is an ingredient you have, spelled differently. A page says "salmon
 * fillets" and the library says "Salmon fillet"; it says "garlic cloves" and the
 * library says "Garlic".
 *
 * That failure is dangerous specifically because the obvious fix is the wrong
 * one. Creating a second "Salmon fillets" record makes the error go away and
 * quietly splits one food into two that the planner will never treat as the same
 * thing: it will not see that Tuesday's salmon and Thursday's salmon are one
 * purchase, so it will not overlap them, and the waste model — the entire point
 * of this app — stops working on that ingredient forever.
 *
 * The right fix is an alias on the record that already exists. So the job here is
 * to find the candidate, and the UI's job is to make taking it easier than
 * creating a duplicate.
 *
 * Scoring is deliberately crude and readable rather than clever. This only has to
 * beat "no suggestion at all", and a wrong suggestion costs nothing because the
 * user is looking straight at both names when they choose.
 */

import type { Ingredient } from '../types';

export interface Suggestion {
  readonly ingredient: Ingredient;
  /** 0..1. Only used for ordering; the threshold is applied before returning. */
  readonly score: number;
  /** Which spelling matched, so the UI can show what it compared against. */
  readonly matched: string;
}

/**
 * Strips a trailing plural.
 *
 * Naive on purpose. It only has to handle the cases that actually separate a
 * recipe's wording from a dictionary entry — "fillets"/"fillet",
 * "tomatoes"/"tomato" — and the cost of getting an irregular wrong is a
 * suggestion that does not appear, not a wrong one that does.
 */
function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2);
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Words that say how an ingredient was prepared or presented rather than what it
 * is. They carry no identity, so counting them makes "fresh parsley" look
 * different from "parsley" and drags every score down.
 */
const IGNORED = new Set([
  'fresh', 'freshly', 'dried', 'ground', 'whole', 'large', 'small', 'medium',
  'ripe', 'raw', 'cooked', 'organic', 'free', 'range', 'boneless', 'skinless',
  'of', 'a', 'an', 'the', 'and', 'or',

  // Portion and packaging nouns. "Garlic cloves" and "Garlic" are the same food
  // in different amounts, and so are "salmon fillets" and "salmon fillet" — the
  // noun describes how it was cut or sold, not what it is. Dropping them from
  // both sides is what lets those pairs match without loosening the scoring for
  // pairs like "coconut milk" and "milk", where the extra word names a
  // different food entirely.
  'clove', 'fillet', 'piece', 'slice', 'sprig', 'head', 'bunch', 'stalk',
  'stick', 'rib', 'can', 'tin', 'jar', 'packet', 'pack', 'bag', 'bottle',
  'carton', 'punnet', 'each',
]);

function tokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    // Singularised BEFORE the filter, or the two sides disagree: "fillets"
    // survives an `IGNORED` list holding "fillet" while the library's "fillet"
    // is dropped, and the pair stops matching itself.
    .map(singular)
    .filter((word) => word !== '' && !IGNORED.has(word));
  return new Set(words);
}

function score(query: Set<string>, candidate: Set<string>): number {
  if (query.size === 0 || candidate.size === 0) return 0;

  let shared = 0;
  for (const word of query) if (candidate.has(word)) shared += 1;
  if (shared === 0) return 0;

  const union = new Set([...query, ...candidate]).size;
  const jaccard = shared / union;

  // The two directions are not symmetric, and treating them as if they were is
  // what makes a matcher dangerous.
  //
  // Words the CANDIDATE has and the query lacks are a narrowing the user can see
  // and confirm: offering "Salmon fillet" for "salmon" is a fair question.
  //
  // Words the QUERY has and the candidate lacks are the opposite. "Coconut milk"
  // is not a kind of milk, "peanut butter" is not a kind of butter, and
  // "buttermilk" is neither. Aliasing one onto the other merges two foods with
  // different prices, pack sizes and allergens, and the planner would then treat
  // buying one as buying the other — a far worse outcome than no suggestion.
  //
  // So the containment bonus applies only when the query adds nothing.
  const queryAddsNothing = [...query].every((word) => candidate.has(word));
  if (!queryAddsNothing) return jaccard;

  const containment = shared / Math.min(query.size, candidate.size);
  return (jaccard + containment) / 2;
}

/**
 * Ingredients that might be what an unresolved name meant, best first.
 *
 * The threshold is set so that a single shared word out of several on both sides
 * is not enough — "olive oil" should not suggest "olive", and "peanut butter"
 * should not suggest "butter". Those are different foods with different pack
 * sizes, and merging them by alias would be as damaging as splitting one by
 * duplicate.
 */
export function suggestIngredients(
  name: string,
  ingredients: Iterable<Ingredient>,
  options: { limit?: number; threshold?: number } = {},
): Suggestion[] {
  const limit = options.limit ?? 3;
  const threshold = options.threshold ?? 0.55;

  const query = tokens(name);
  if (query.size === 0) return [];

  const out: Suggestion[] = [];
  for (const ingredient of ingredients) {
    let best = 0;
    let matched = ingredient.name;
    for (const spelling of [ingredient.name, ingredient.id, ...ingredient.aliases]) {
      const value = score(query, tokens(spelling));
      if (value > best) {
        best = value;
        matched = spelling;
      }
    }
    if (best >= threshold) out.push({ ingredient, score: best, matched });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Adds a spelling to an ingredient's aliases, leaving it alone if already there. */
export function withAlias(ingredient: Ingredient, alias: string): Ingredient {
  const normalized = alias.trim().toLowerCase();
  if (normalized === '') return ingredient;
  const existing = ingredient.aliases.map((a) => a.toLowerCase());
  if (existing.includes(normalized) || ingredient.name.toLowerCase() === normalized) return ingredient;
  return { ...ingredient, aliases: [...ingredient.aliases, normalized] };
}
