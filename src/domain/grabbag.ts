/**
 * The grab bags: what shelves they draw from, and how big each one is.
 *
 * A grab bag is a small random selection added to the week because it is worth
 * having in the house, not because a recipe asked for it. Produce was the first
 * one and the reason the idea exists — a cost-minimising planner falls into a rut
 * and cooks the same eight things forever, and the bag is the antidote. Bread,
 * pasta and cheese are the same trick pointed at three other shelves, where the
 * rut is just as deep and rather more boring: the same loaf, the same box of
 * penne and the same block of cheddar, every week, for years.
 *
 * THESE ARE REAL INGREDIENTS, unlike the treat bag next door, and that is why
 * this file is short. A loaf of bread has grams, a pack size, a shelf life, an
 * aisle, allergens and a diet it breaks, and the app already models all of it —
 * so a bread bag is a filter over the library rather than a second catalogue. It
 * costs nothing, and it gets the waste model, the allergen filter, the pantry and
 * the shopping list for free. (`treats.ts` explains why the treat bag could not
 * do the same: half of it is not food.)
 *
 * WHICH SHELF A THING IS ON IS DERIVED, NEVER STORED. Same call as the fruit/veg
 * split in `produce.ts`, for the same reason: the data model has a `grain`
 * category and a `dairy` category, which is right for seasonality, waste and
 * aisle order, and the grab bag is the only place "is this pasta" or "is this
 * cheese" is a question worth asking. Deriving it means a plan stores nothing
 * new — `WildcardItem` is untouched — so a plan written before any of this
 * existed still reads correctly, and one written after still reads on an older
 * build.
 */

import type { Ingredient } from './types';
import { hasWord, vocabulary } from './nameWords';
import { type ProduceKind, PRODUCE_KIND_LABELS, produceKind } from './produce';

export type GrabBagId = 'produce' | 'bread' | 'pasta' | 'cheese';

export const GRAB_BAG_IDS: readonly GrabBagId[] = ['produce', 'bread', 'pasta', 'cheese'];

// ---------------------------------------------------------------------------
// What is on each shelf
// ---------------------------------------------------------------------------

/**
 * Pasta, as the aisle understands it rather than as Italy does.
 *
 * Restricted to the `grain` category, which also holds rice, oats, polenta and
 * crackers — so this list is what separates the box of rigatoni from the bag of
 * pearl barley sitting next to it.
 *
 * Couscous is in, and it is the entry anyone would argue about. It is rolled
 * semolina, which makes it pasta by construction; it is sold in the pasta aisle;
 * and a bag whose job is "something other than spaghetti this week" is worse for
 * leaving it out. Noodles of every kind are in for the same reason — soba, udon,
 * ramen, rice vermicelli — because "pasta or noodles" is one decision made
 * standing in front of one shelf.
 */
const PASTA_WORDS: ReadonlySet<string> = vocabulary([
  'pasta', 'noodle', 'spaghetti', 'spaghettini', 'penne', 'macaroni', 'fusilli',
  'rigatoni', 'farfalle', 'orzo', 'linguine', 'linguini', 'tagliatelle',
  'fettuccine', 'fettuccini', 'pappardelle', 'orecchiette', 'conchiglie',
  'bucatini', 'cavatappi', 'ditalini', 'vermicelli', 'cannelloni', 'manicotti',
  'ziti', 'gemelli', 'radiatori', 'paccheri', 'trofie', 'casarecce', 'capellini',
  'campanelle', 'rotini', 'tortellini', 'tortelloni', 'ravioli', 'agnolotti',
  'gnocchi', 'lasagne', 'lasagna', 'ramen', 'soba', 'udon', 'somen', 'couscous',
  'fregola', 'pastina', 'stelline', 'rotelle', 'fideo',
]);

/**
 * Cheese. Restricted to the `dairy` category, so the list only has to tell cheese
 * apart from milk, butter, cream, yogurt and eggs.
 *
 * Named cheeses are listed alongside the word itself because half of them never
 * say "cheese" on the label — nothing calls burrata "burrata cheese". Paneer and
 * queso fresco are in: a fresh cheese is a cheese, whatever aisle it turns up in.
 */
const CHEESE_WORDS: ReadonlySet<string> = vocabulary([
  'cheese', 'cheddar', 'parmesan', 'parmigiano', 'reggiano', 'mozzarella',
  'feta', 'halloumi', 'ricotta', 'gruyere', 'comte', 'emmental', 'emmentaler',
  'gouda', 'edam', 'brie', 'camembert', 'manchego', 'mascarpone', 'provolone',
  'pecorino', 'romano', 'asiago', 'fontina', 'havarti', 'taleggio', 'stilton',
  'gorgonzola', 'roquefort', 'cambozola', 'burrata', 'boursin', 'jarlsberg',
  'raclette', 'wensleydale', 'leicester', 'gloucester', 'caerphilly', 'cotija',
  'queso', 'oaxaca', 'mizithra', 'kasseri', 'paneer', 'chevre', 'quark',
  'colby', 'monterey', 'munster', 'muenster', 'tomme', 'morbier', 'reblochon',
  'scamorza', 'caciocavallo',
]);

/** Is this ingredient on the pasta shelf? */
export function isPasta(ing: Ingredient): boolean {
  return ing.category === 'grain' && hasWord(ing, PASTA_WORDS);
}

/** Is this ingredient a cheese? */
export function isCheese(ing: Ingredient): boolean {
  return ing.category === 'dairy' && hasWord(ing, CHEESE_WORDS);
}

// ---------------------------------------------------------------------------
// The bags
// ---------------------------------------------------------------------------

/**
 * The settings each bag reads: whether it is drawn at all, and how big it is.
 *
 * Flat fields rather than one record keyed by bag id, and deliberately so.
 * Settings sync per top-level field (see `mergeSettings`), so a nested object
 * would be a single clock covering all four bags — turn the cheese bag on here
 * while the phone turns pasta off, and one of the two changes quietly loses.
 * Four bags, four fields, four clocks.
 *
 * `PlannerSettings` extends this, so anything already holding settings satisfies
 * it and nothing has to thread a second object around.
 */
export interface GrabBagSettings {
  readonly produceBagEnabled: boolean;
  /** Produce bag size when it is drawn as one bag. Ignored when `wildcardSplit` is on. */
  readonly wildcardCount: number;
  /**
   * Draw fruit and vegetables as two separate bags with their own sizes.
   *
   * One pool is weighted by season and sale price alone, so a week can come back
   * with no fruit at all. Splitting is how you say "some of each, every week".
   * Only produce has it — no other shelf has two halves worth guaranteeing
   * separately.
   */
  readonly wildcardSplit: boolean;
  readonly wildcardFruitCount: number;
  readonly wildcardVegCount: number;

  readonly breadBagEnabled: boolean;
  readonly breadBagCount: number;
  readonly pastaBagEnabled: boolean;
  readonly pastaBagCount: number;
  readonly cheeseBagEnabled: boolean;
  readonly cheeseBagCount: number;
}

/** Keys of `GrabBagSettings` holding a bag's on/off switch. */
export type BagEnabledKey =
  'produceBagEnabled' | 'breadBagEnabled' | 'pastaBagEnabled' | 'cheeseBagEnabled';

/** Keys of `GrabBagSettings` holding a bag's size. */
export type BagCountKey =
  'wildcardCount' | 'breadBagCount' | 'pastaBagCount' | 'cheeseBagCount';

export interface GrabBag {
  readonly id: GrabBagId;
  /** Section heading, on the plan screen and in settings. */
  readonly title: string;
  /** What its contents are called in "nothing left to draw". Plural, lowercase. */
  readonly noun: string;
  /** One line under the heading: what this bag is for. */
  readonly blurb: string;
  /** Is this ingredient on this bag's shelf? */
  readonly holds: (ing: Ingredient) => boolean;
  readonly enabledKey: BagEnabledKey;
  readonly countKey: BagCountKey;
}

export const GRAB_BAGS: readonly GrabBag[] = [
  {
    id: 'produce',
    title: 'Produce grab bag',
    noun: 'produce',
    blurb:
      'A random draw weighted to what is in season and on sale — the antidote to ' +
      'cooking the same eight things forever.',
    holds: (ing) => ing.category === 'produce',
    enabledKey: 'produceBagEnabled',
    countKey: 'wildcardCount',
  },
  {
    id: 'bread',
    title: 'Bread bag',
    noun: 'breads',
    blurb:
      'Something off the bakery shelf that is not the usual loaf. Bread freezes, ' +
      'so half a loaf you do not get through is not waste.',
    // The whole bakery category, with no word list behind it. Everything sold
    // there is a thing you tear up and eat alongside dinner, and a bag labelled
    // "bread" coming back with a packet of crumpets is a good surprise rather
    // than a wrong answer.
    holds: (ing) => ing.category === 'bakery',
    enabledKey: 'breadBagEnabled',
    countKey: 'breadBagCount',
  },
  {
    id: 'pasta',
    title: 'Pasta bag',
    noun: 'pasta',
    blurb:
      'A shape you did not buy last week. Dried pasta keeps for a year, which ' +
      'makes this the cheapest variety in the shop.',
    holds: isPasta,
    enabledKey: 'pastaBagEnabled',
    countKey: 'pastaBagCount',
  },
  {
    id: 'cheese',
    title: 'Cheese bag',
    noun: 'cheeses',
    blurb:
      'One cheese that is not the usual block of cheddar. Anything your allergies ' +
      'or diets rule out is never drawn.',
    holds: isCheese,
    enabledKey: 'cheeseBagEnabled',
    countKey: 'cheeseBagCount',
  },
];

const BAGS_BY_ID: ReadonlyMap<GrabBagId, GrabBag> = new Map(GRAB_BAGS.map((b) => [b.id, b]));

export function getGrabBag(id: GrabBagId): GrabBag {
  return BAGS_BY_ID.get(id)!;
}

/**
 * Which bag this ingredient belongs to, or null for the great majority that
 * belong to none.
 *
 * The shelves are disjoint by construction — four different categories, two of
 * them narrowed by a word list — and the draw relies on that: an ingredient in
 * two bags at once would be drawn twice and counted against both sizes. The test
 * suite asserts it across the whole library.
 */
export function bagOf(ing: Ingredient): GrabBagId | null {
  return GRAB_BAGS.find((bag) => bag.holds(ing))?.id ?? null;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/**
 * One draw: a pool to draw from, and how many to take from it.
 *
 * A bag is usually one lane. Produce is two when it is split, and that is the
 * only reason lanes exist as an idea separate from bags — fruit and vegetables
 * come off one shelf but have to be guaranteed separately, and everything
 * downstream would far rather be handed a flat list of draws than be told about
 * the exception.
 */
export interface BagLane {
  readonly bag: GrabBagId;
  /** Stable id: `produce`, `produce:fruit`, `bread`. Keys the UI and seeds the draw. */
  readonly key: string;
  /** Sub-heading. Shown only when its bag draws more than one lane. */
  readonly label: string;
  readonly count: number;
  readonly holds: (ing: Ingredient) => boolean;
}

function produceLane(kind: ProduceKind, count: number): BagLane {
  return {
    bag: 'produce',
    key: `produce:${kind}`,
    label: PRODUCE_KIND_LABELS[kind],
    count: Math.max(0, count),
    holds: (ing) => ing.category === 'produce' && produceKind(ing) === kind,
  };
}

/** The lanes one bag draws, given the settings. Empty when the bag is switched off. */
export function lanesOf(bag: GrabBag, settings: GrabBagSettings): BagLane[] {
  if (!settings[bag.enabledKey]) return [];

  if (bag.id === 'produce' && settings.wildcardSplit) {
    return [
      produceLane('fruit', settings.wildcardFruitCount),
      produceLane('vegetable', settings.wildcardVegCount),
    ];
  }

  return [{
    bag: bag.id,
    key: bag.id,
    label: bag.title,
    count: Math.max(0, settings[bag.countKey]),
    holds: bag.holds,
  }];
}

/** Every lane to be drawn this week, in bag order. */
export function grabBagLanes(settings: GrabBagSettings): BagLane[] {
  return GRAB_BAGS.flatMap((bag) => lanesOf(bag, settings));
}
