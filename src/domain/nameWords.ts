/**
 * Word-level matching over an ingredient's name and aliases.
 *
 * Every grab bag has to answer "what kind of thing is this" from a name alone —
 * the fruit/veg split in `produce.ts`, and the bread, pasta and cheese shelves in
 * `grabbag.ts`. They all need the same three rules, so the rules live here once.
 * Two copies of a singulariser drift, and the day they disagree is the day
 * "cherries" is fruit in one bag and not in the other.
 *
 * The three rules:
 *
 *   1. WHOLE WORDS, NEVER SUBSTRINGS. This is the one that matters. "pineapple"
 *      must not be caught by "apple", "buttermilk" is not butter, and "parmesan
 *      crisps" is not a crisp.
 *   2. SINGULARISED, because ingredient names are written both ways and nobody
 *      should have to list "noodle" and "noodles".
 *   3. ACCENTS FOLDED, so "Gruyère" is one word rather than "gruy" and "re" —
 *      which is what splitting on letters alone would make of it.
 *
 * Aliases are searched as well as the name, because imports rarely use the tidy
 * name: the library's "Mandarins" arrives as "clementines" about half the time.
 */

import type { Ingredient } from './types';

/** Crude singulariser. Only has to handle ingredient names, not English. */
export function singular(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (/(ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** A name broken into singular, accent-free, lowercase words. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    // Decompose, then drop the combining marks: è becomes e rather than a split.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map(singular);
}

/**
 * Everywhere a name could be written: the id as well as the name and aliases.
 *
 * The id is included because it is authored by hand and is often the most
 * explicit of the three — `goat-cheese` says "cheese" where a display name of
 * "Chèvre" does not.
 */
export function nameTexts(ing: Ingredient): string[] {
  return [ing.id, ing.name, ...ing.aliases];
}

/**
 * Builds a word list to match against, put through exactly the same mill as the
 * names will be.
 *
 * This is not ceremony. `singular` is crude by design and mangles a word or two
 * on the way past — "couscous" comes out as "couscou" — so a vocabulary written
 * in plain English and compared raw would silently never match it. Normalising
 * both sides means the list can be written the way a person would write it and
 * still match, whatever the singulariser does to it along the way.
 */
export function vocabulary(entries: readonly string[]): ReadonlySet<string> {
  return new Set(entries.flatMap(words));
}

/**
 * True when any word of any of the ingredient's names is in `vocabulary`, or
 * ends with one of `suffixes`.
 *
 * Suffixes are for open-ended families that cannot be listed — every berry is a
 * fruit, so `-berry` catches the one nobody thought of without anyone editing a
 * list. They are checked as true suffixes of a longer word, so "berry" itself
 * has to be in the vocabulary if it should match on its own.
 */
export function hasWord(
  ing: Ingredient,
  vocabulary: ReadonlySet<string>,
  suffixes: readonly string[] = [],
): boolean {
  return nameTexts(ing).some((text) =>
    words(text).some(
      (word) =>
        vocabulary.has(word) ||
        suffixes.some((s) => word.length > s.length && word.endsWith(s)),
    ),
  );
}
