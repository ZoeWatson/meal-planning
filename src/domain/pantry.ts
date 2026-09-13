/**
 * The pantry: two dials, and the rule that turns them into a shopping list.
 *
 * Stock is how much is left. Necessity is how much that matters. Keeping them
 * apart is the whole point — "out of salt" and "out of capers" are the same
 * stock and nothing like the same problem, and a pantry that only knows the
 * first number has to either nag about both or stay quiet about both.
 *
 * Together they answer one question: does this go on the list this week? That
 * answer can always be overridden by hand, because a rule about a cupboard is a
 * good default and never an authority.
 */

import type { Id, Ingredient, PantryItem, PantryNecessity, PantryStock } from './types';
import { carryOverOf } from './waste';

export const PANTRY_STOCKS: readonly PantryStock[] = ['stocked', 'low', 'out'];

export const STOCK_LABELS: Record<PantryStock, string> = {
  stocked: 'In stock',
  low: 'Low',
  out: 'Out',
};

export const NECESSITIES: readonly PantryNecessity[] = [
  'must-have', 'nice-to-have', 'alright-without',
];

export const NECESSITY_LABELS: Record<PantryNecessity, string> = {
  'must-have': 'Must-have',
  'nice-to-have': 'Nice to have',
  'alright-without': 'Alright without',
};

/** What each necessity actually does, in the words the setting needs to justify. */
export const NECESSITY_HINTS: Record<PantryNecessity, string> = {
  'must-have': 'Goes on the list as soon as it runs low.',
  'nice-to-have': 'Goes on the list once it runs out.',
  'alright-without': 'Never added on its own — put it on the list when you want it.',
};

/**
 * What a new pantry item gets.
 *
 * The quiet end of the scale deliberately: a pantry fills up with things you
 * added once and forgot, and a default that puts every one of them on a list
 * trains you to ignore the list.
 */
export const DEFAULT_NECESSITY: PantryNecessity = 'alright-without';

/**
 * An item's necessity, including rows written before the field existed.
 *
 * Those are `must-have`, not the default a new item gets, and the difference
 * matters: every non-stocked pantry item used to land on the grocery list
 * automatically, so that is what those rows have always meant in practice.
 * Reading them as `alright-without` would be tidier and would quietly drop
 * things off shopping lists people have been relying on for months.
 */
export function necessityOf(item: PantryItem): PantryNecessity {
  return item.necessity ?? 'must-have';
}

/**
 * Whether the rule alone would put this on the list, before any override.
 *
 * Must-haves go on at `low` rather than `out` because the point of calling
 * something a must-have is not running out of it.
 */
export function autoRestock(item: PantryItem): boolean {
  switch (necessityOf(item)) {
    case 'must-have': return item.status !== 'stocked';
    case 'nice-to-have': return item.status === 'out';
    case 'alright-without': return false;
  }
}

/** Whether this is on the week's shopping list: the rule, or your override of it. */
export function isOnList(item: PantryItem): boolean {
  return item.restock ?? autoRestock(item);
}

/** True when the item is on the list only because you put it there, or kept off it. */
export function isOverridden(item: PantryItem): boolean {
  return item.restock !== undefined && item.restock !== autoRestock(item);
}

/**
 * Whether "I already have this" is worth remembering past this week.
 *
 * Said on the shopping list, that sentence means two entirely different things
 * depending on what it is about. Half a bag of rice is a fact that will still be
 * true in a month, and a pantry row for it saves being asked every week. Half a
 * bunch of parsley is a fact about Tuesday, and a pantry row for it would be a
 * standing lie — worse than useless, because a stocked pantry item is FREE to the
 * planner, so every week after this one would quietly assume parsley costs
 * nothing.
 *
 * The test is the one the waste model already makes for what survives a week, and
 * the same one a finished shop uses to decide what to bank as carry-over. Two
 * places asking "does this keep?" should not answer it differently.
 *
 * This only decides whether to OFFER. Anything can be put in the pantry by hand
 * in Settings, where the roster lives — a household that really does keep frozen
 * stock in is not wrong, it is just not the default worth suggesting.
 */
export function worthKeeping(ingredient: Ingredient): boolean {
  return carryOverOf(ingredient) === 'pantry';
}

/**
 * Necessity, stock, and what the two of them decided — in one phrase.
 *
 * Everything a pantry row would say if it had three lines to say it in, for the
 * row that has one. A list you cannot interrogate is one you stop trusting:
 * "why is there flour on here, I have flour" deserves an answer, and the answer
 * has to travel with the row rather than live two screens away.
 */
export function describeItem(item: PantryItem): string {
  const head = `${NECESSITY_LABELS[necessityOf(item)]}, ${STOCK_LABELS[item.status].toLowerCase()}`;

  if (isOverridden(item)) {
    return item.restock === true
      ? `${head} — on the list because you added it`
      : `${head} — off the list because you took it off`;
  }
  return isOnList(item) ? `${head} — on the list` : `${head} — not on the list`;
}

function clearOverride<T extends PantryItem>(item: T): T {
  const { restock: _restock, ...rest } = item;
  return rest as T;
}

/**
 * Moves an item's stock, and decides what that does to an override.
 *
 * One rule, because anything more elaborate is unpredictable in the hand: an
 * override survives until the thing is back in stock.
 *
 * The tempting version — clear it whenever anything changes, so a stale "not
 * this week" cannot linger — gets the common case exactly backwards. You add
 * soy sauce to the list, then look in the cupboard and find the bottle emptier
 * than you thought, so you mark it out. Cancelling the request at that moment
 * cancels it precisely when it got more urgent.
 *
 * Coming back in stock ends it in both directions, because that is the purchase
 * the override was about, whichever way it pointed.
 */
export function afterStockChange<T extends PantryItem>(item: T, status: PantryStock): T {
  const moved = { ...item, status };
  return status === 'stocked' ? clearOverride(moved) : moved;
}

/**
 * Review order: whatever needs a decision, first.
 *
 * On the list, then out, then low, then stocked; necessity breaks the tie, name
 * breaks that. The top of this list is the part of a pantry worth reading before
 * a shop, and the bottom is the part you scroll past.
 */
export function reviewOrder(
  items: readonly PantryItem[],
  ingredients: ReadonlyMap<Id, Ingredient>,
): Array<{ item: PantryItem; ingredient: Ingredient }> {
  const stockRank: Record<PantryStock, number> = { out: 0, low: 1, stocked: 2 };
  const necessityRank: Record<PantryNecessity, number> = {
    'must-have': 0, 'nice-to-have': 1, 'alright-without': 2,
  };

  return items
    .flatMap((item) => {
      const ingredient = ingredients.get(item.ingredientId);
      return ingredient ? [{ item, ingredient }] : [];
    })
    .sort((a, b) => {
      const onList = Number(isOnList(b.item)) - Number(isOnList(a.item));
      if (onList !== 0) return onList;
      const stock = stockRank[a.item.status] - stockRank[b.item.status];
      if (stock !== 0) return stock;
      const need = necessityRank[necessityOf(a.item)] - necessityRank[necessityOf(b.item)];
      if (need !== 0) return need;
      return a.ingredient.name.localeCompare(b.ingredient.name);
    });
}

/** Alphabetical, for the settings list — where the job is finding one named thing. */
export function nameOrder(
  items: readonly PantryItem[],
  ingredients: ReadonlyMap<Id, Ingredient>,
): Array<{ item: PantryItem; ingredient: Ingredient }> {
  return items
    .flatMap((item) => {
      const ingredient = ingredients.get(item.ingredientId);
      return ingredient ? [{ item, ingredient }] : [];
    })
    .sort((a, b) => a.ingredient.name.localeCompare(b.ingredient.name));
}
