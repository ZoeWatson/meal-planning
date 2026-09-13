/**
 * Fruit or vegetable, decided the way a shopper would rather than the way a
 * botanist would.
 *
 * The data model has one `produce` category, which is right for everything that
 * consumes it — seasonality, waste and aisle order all treat a tomato and an
 * apple identically. The grab bag is the one place the distinction matters, and
 * only because of how the two get eaten: fruit is drawn to be snacked on, veg is
 * drawn to be cooked. So the split lives here as a derived property instead of a
 * second category, and nothing else has to know about it.
 *
 * Botanical accuracy is deliberately not the goal. Tomatoes, cucumbers, peppers
 * and squash are fruit and are classified here as vegetables, because a grab bag
 * that answers "some fruit for the week" with three zucchini is useless. Rhubarb
 * goes the other way for the same reason.
 *
 * Vegetable is the default: the fruit list is finite and nameable, the vegetable
 * list is not, and an unrecognised import is far more likely to be a vegetable
 * or a herb than an exotic fruit.
 */

import type { Ingredient } from './types';
import { nameTexts, vocabulary, words } from './nameWords';

export type ProduceKind = 'fruit' | 'vegetable';

export const PRODUCE_KINDS: readonly ProduceKind[] = ['fruit', 'vegetable'];

export const PRODUCE_KIND_LABELS: Readonly<Record<ProduceKind, string>> = {
  fruit: 'Fruit',
  vegetable: 'Vegetables',
};

/**
 * Things eaten as fruit. Matched as whole words against the name and aliases, so
 * "green apple" and "apples" both land, and "pineapple" is not caught by "apple".
 */
const FRUIT_WORDS: ReadonlySet<string> = vocabulary([
  'apple', 'apricot', 'banana', 'cantaloupe', 'cherry', 'clementine', 'coconut',
  'currant', 'date', 'fig', 'grape', 'grapefruit', 'guava', 'honeydew', 'kiwi',
  'lemon', 'lime', 'lychee', 'mandarin', 'mango', 'melon', 'nectarine', 'orange',
  'papaya', 'passionfruit', 'peach', 'pear', 'persimmon', 'pineapple', 'plantain',
  'plum', 'pomegranate', 'prune', 'raisin', 'rhubarb', 'satsuma', 'tangerine',
  'watermelon',
]);

/**
 * Suffixes that make a word fruit on their own — every berry is one, and
 * "-fruit" and "-melon" compounds (jackfruit, dragonfruit, muskmelon) are too.
 * This is what keeps an imported ingredient nobody anticipated on the right side
 * of the split without anyone editing the list above.
 */
const FRUIT_SUFFIXES: readonly string[] = ['berry', 'fruit', 'melon'];

/**
 * Words that settle a compound name before the fruit list is consulted.
 *
 * A cherry tomato is a tomato: the fruit word in the name describes its size,
 * not how it is eaten, and a fruit bag containing three punnets of cherry
 * tomatoes is the same bug report as one containing zucchini. Kept deliberately
 * short — it only needs the vegetables whose names borrow a fruit's.
 */
const VEGETABLE_WORDS: ReadonlySet<string> = vocabulary(['tomato', 'pepper', 'squash']);

function isFruitWord(word: string): boolean {
  return FRUIT_WORDS.has(word) || FRUIT_SUFFIXES.some((s) => word.length > s.length && word.endsWith(s));
}

/**
 * Which half of the grab bag this ingredient belongs to.
 *
 * Answers for anything, not just produce — callers that care about produce have
 * already filtered by category, and returning a kind unconditionally keeps this
 * total and therefore testable.
 */
export function produceKind(ingredient: Ingredient): ProduceKind {
  for (const text of nameTexts(ingredient)) {
    const parts = words(text);
    if (parts.some((w) => VEGETABLE_WORDS.has(w))) return 'vegetable';
    if (parts.some(isFruitWord)) return 'fruit';
  }
  return 'vegetable';
}
