/**
 * Regional seasonality.
 *
 * Seasonality is a property of (ingredient, place), not of the ingredient — a
 * tomato is a summer crop in Vancouver and a year-round one in Mexico. So the
 * season data lives in per-region tables here, and `Ingredient.seasonMonths` is
 * only a fallback for regions that have no entry.
 *
 * Two-tier model, because storage crops matter a lot in BC:
 *
 *   peak      — actively harvested locally. Cheapest, best, most abundant.
 *   available — still sold from local storage. BC potatoes, onions, carrots and
 *               apples are local well into spring, months after harvest ends.
 *
 * Collapsing these into one list would either mark February apples out of season
 * (wrong — they are local, stored, and cheap) or mark them peak (wrong — August
 * apples are a different proposition entirely). Scoring weights them differently.
 */

import type { Id, Ingredient } from './types';

export interface SeasonEntry {
  /** Months (1-12) of active local harvest. */
  readonly peak: readonly number[];
  /** Months when still available from local storage. Defaults to `peak`. */
  readonly available?: readonly number[];
}

export interface Region {
  readonly id: string;
  readonly name: string;
  /** Shown in the region picker so the choice is legible. */
  readonly description: string;
  readonly seasons: Readonly<Record<Id, SeasonEntry>>;
}

const ALL_YEAR: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * British Columbia — Lower Mainland, Fraser Valley and Okanagan.
 *
 * Compiled from typical BC harvest windows. Treat as a good default rather than
 * gospel: microclimates vary a lot between the coast and the Interior, and any
 * given year shifts by two or three weeks.
 */
const BC_CANADA: Region = {
  id: 'bc-canada',
  name: 'British Columbia, Canada',
  description: 'Lower Mainland, Fraser Valley and Okanagan growing seasons.',
  seasons: {
    // --- spring ---
    asparagus: { peak: [4, 5, 6] },
    rhubarb: { peak: [4, 5, 6] },
    'spinach': { peak: [4, 5, 6, 9, 10] },
    'green-peas': { peak: [6, 7] },
    radish: { peak: [5, 6, 7, 9, 10] },

    // --- summer ---
    strawberry: { peak: [6, 7] },
    raspberry: { peak: [6, 7, 8] },
    blueberry: { peak: [7, 8, 9] },
    cherry: { peak: [6, 7, 8] },
    peach: { peak: [7, 8, 9] },
    'sweet-corn': { peak: [7, 8, 9] },
    tomato: { peak: [7, 8, 9, 10] },
    'bell-pepper': { peak: [7, 8, 9, 10] },
    zucchini: { peak: [7, 8, 9] },
    cucumber: { peak: [6, 7, 8, 9] },
    'green-beans': { peak: [7, 8, 9] },
    lettuce: { peak: [5, 6, 7, 8, 9, 10] },
    basil: { peak: [6, 7, 8, 9] },

    // --- autumn ---
    apple: { peak: [8, 9, 10, 11], available: [1, 2, 3, 4, 8, 9, 10, 11, 12] },
    pear: { peak: [8, 9, 10], available: [1, 2, 8, 9, 10, 11, 12] },
    broccoli: { peak: [6, 7, 8, 9, 10] },
    cauliflower: { peak: [7, 8, 9, 10] },
    cabbage: { peak: [7, 8, 9, 10, 11], available: [1, 2, 7, 8, 9, 10, 11, 12] },
    'brussels-sprouts': { peak: [9, 10, 11, 12] },
    'butternut-squash': { peak: [9, 10, 11], available: [1, 2, 9, 10, 11, 12] },
    beet: { peak: [7, 8, 9, 10, 11], available: [1, 2, 3, 7, 8, 9, 10, 11, 12] },

    // --- storage crops: harvested once, local for most of the year ---
    potato: { peak: [8, 9, 10], available: ALL_YEAR },
    'yellow-onion': { peak: [8, 9, 10], available: ALL_YEAR },
    carrot: { peak: [7, 8, 9, 10, 11], available: ALL_YEAR },
    garlic: { peak: [7, 8, 9], available: [1, 2, 3, 7, 8, 9, 10, 11, 12] },
    leek: { peak: [9, 10, 11, 12, 1, 2, 3] },
    parsnip: { peak: [10, 11, 12, 1, 2] },
    kale: { peak: [6, 7, 8, 9, 10, 11], available: [1, 2, 3, 6, 7, 8, 9, 10, 11, 12] },

    // --- greenhouse / cultivated year-round in BC ---
    mushroom: { peak: ALL_YEAR },
  },
};

/**
 * Ontario — roughly the same crop list as BC on a shorter, later season, with a
 * harder winter break on the field crops.
 */
const ON_CANADA: Region = {
  id: 'on-canada',
  name: 'Ontario, Canada',
  description: 'Southern Ontario growing seasons.',
  seasons: {
    asparagus: { peak: [5, 6] },
    rhubarb: { peak: [5, 6] },
    spinach: { peak: [5, 6, 9, 10] },
    'green-peas': { peak: [6, 7] },
    strawberry: { peak: [6, 7] },
    raspberry: { peak: [7, 8] },
    blueberry: { peak: [7, 8] },
    cherry: { peak: [7] },
    peach: { peak: [7, 8, 9] },
    'sweet-corn': { peak: [7, 8, 9] },
    tomato: { peak: [7, 8, 9, 10] },
    'bell-pepper': { peak: [7, 8, 9, 10] },
    zucchini: { peak: [7, 8, 9] },
    cucumber: { peak: [7, 8, 9] },
    'green-beans': { peak: [7, 8, 9] },
    lettuce: { peak: [6, 7, 8, 9, 10] },
    basil: { peak: [7, 8, 9] },
    apple: { peak: [9, 10, 11], available: [1, 2, 3, 9, 10, 11, 12] },
    pear: { peak: [9, 10], available: [1, 9, 10, 11, 12] },
    broccoli: { peak: [7, 8, 9, 10] },
    cauliflower: { peak: [8, 9, 10] },
    cabbage: { peak: [8, 9, 10, 11], available: [1, 2, 8, 9, 10, 11, 12] },
    'brussels-sprouts': { peak: [10, 11] },
    'butternut-squash': { peak: [9, 10, 11], available: [1, 2, 9, 10, 11, 12] },
    beet: { peak: [8, 9, 10, 11], available: [1, 2, 8, 9, 10, 11, 12] },
    potato: { peak: [8, 9, 10], available: ALL_YEAR },
    'yellow-onion': { peak: [8, 9, 10], available: ALL_YEAR },
    carrot: { peak: [8, 9, 10, 11], available: ALL_YEAR },
    garlic: { peak: [7, 8], available: [1, 2, 7, 8, 9, 10, 11, 12] },
    leek: { peak: [9, 10, 11] },
    parsnip: { peak: [10, 11, 12, 1] },
    kale: { peak: [7, 8, 9, 10, 11] },
    mushroom: { peak: ALL_YEAR },
  },
};

/**
 * Las Vegas — Mojave Desert, plus the valleys the city actually eats from.
 *
 * This table is deliberately built on a different basis from the Canadian ones,
 * and it is worth saying why rather than quietly diverging.
 *
 * Southern Nevada has almost no commercial agriculture. Modelling only what grows
 * in the Las Vegas Valley would produce a table that is accurate, tiny and
 * useless — it would mark practically everything out of season all year. What a
 * Las Vegas shopper actually experiences is the Southwest supply chain: Yuma,
 * Arizona is four hours away and grows most of the United States' winter lettuce
 * and brassicas; the Imperial and Coachella valleys cover spring; California's
 * Central Valley covers summer stone fruit. So these are supply seasons, not
 * backyard seasons.
 *
 * The result inverts the Canadian pattern in two ways that matter:
 *
 *  - **Winter is the good season for greens.** Lettuce, spinach, kale and
 *    broccoli peak from November to March, when BC has none. Planning salads in
 *    January is a reasonable thing to do here and a silly one in Vancouver.
 *  - **High summer is a gap, not a peak.** Desert-grown warm crops stop setting
 *    fruit above roughly 35°C, so local tomatoes and squash come in two waves
 *    either side of July and August rather than one long summer.
 */
const LAS_VEGAS: Region = {
  id: 'las-vegas',
  name: 'Las Vegas, Nevada',
  description:
    'Southwest supply — desert growing plus the Arizona and California valleys ' +
    'Las Vegas shops draw from. Winter greens, spring and autumn harvests, and a summer gap.',
  seasons: {
    // --- cool season: the productive half of the desert year ---
    lettuce: { peak: [11, 12, 1, 2, 3], available: [10, 11, 12, 1, 2, 3, 4] },
    spinach: { peak: [11, 12, 1, 2, 3], available: [10, 11, 12, 1, 2, 3, 4] },
    kale: { peak: [11, 12, 1, 2, 3], available: [10, 11, 12, 1, 2, 3, 4] },
    broccoli: { peak: [11, 12, 1, 2, 3], available: ALL_YEAR },
    cauliflower: { peak: [11, 12, 1, 2, 3], available: [10, 11, 12, 1, 2, 3, 4] },
    cabbage: { peak: [11, 12, 1, 2, 3], available: [10, 11, 12, 1, 2, 3, 4, 5] },
    'brussels-sprouts': { peak: [12, 1, 2], available: [11, 12, 1, 2, 3] },
    radish: { peak: [10, 11, 12, 1, 2, 3, 4], available: [9, 10, 11, 12, 1, 2, 3, 4, 5] },
    beet: { peak: [11, 12, 1, 2, 3, 4], available: [10, 11, 12, 1, 2, 3, 4, 5] },
    leek: { peak: [11, 12, 1, 2, 3], available: [10, 11, 12, 1, 2, 3, 4] },
    parsnip: { peak: [12, 1, 2], available: [11, 12, 1, 2, 3] },
    'green-peas': { peak: [2, 3, 4], available: [2, 3, 4, 10, 11] },
    asparagus: { peak: [2, 3, 4, 5], available: [2, 3, 4, 5, 6] },
    rhubarb: { peak: [3, 4, 5] },

    // --- warm season: two waves, with the July/August heat between them ---
    tomato: { peak: [5, 6, 7, 9, 10], available: [4, 5, 6, 7, 8, 9, 10, 11] },
    'bell-pepper': { peak: [6, 7, 9, 10], available: [5, 6, 7, 8, 9, 10, 11] },
    zucchini: { peak: [5, 6, 9, 10], available: [4, 5, 6, 7, 8, 9, 10] },
    cucumber: { peak: [5, 6, 9, 10], available: [4, 5, 6, 7, 8, 9, 10] },
    'green-beans': { peak: [5, 6, 9, 10], available: [4, 5, 6, 7, 9, 10, 11] },
    'sweet-corn': { peak: [6, 7, 8], available: [5, 6, 7, 8, 9] },
    // Basil is the exception: it loves the heat, given water.
    basil: { peak: [4, 5, 6, 7, 8, 9, 10], available: [3, 4, 5, 6, 7, 8, 9, 10, 11] },

    // --- fruit ---
    strawberry: { peak: [3, 4, 5], available: [2, 3, 4, 5, 6] },
    raspberry: { peak: [5, 6, 9, 10], available: [4, 5, 6, 7, 8, 9, 10] },
    blueberry: { peak: [4, 5, 6, 7], available: [3, 4, 5, 6, 7, 8] },
    cherry: { peak: [5, 6], available: [5, 6, 7] },
    peach: { peak: [5, 6, 7, 8], available: [5, 6, 7, 8, 9] },
    apple: { peak: [8, 9, 10, 11], available: ALL_YEAR },
    pear: { peak: [8, 9, 10], available: [1, 2, 8, 9, 10, 11, 12] },

    // --- storage and cultivated: local harvest, then year-round supply ---
    potato: { peak: [5, 6], available: ALL_YEAR },
    'yellow-onion': { peak: [5, 6], available: ALL_YEAR },
    garlic: { peak: [5, 6], available: ALL_YEAR },
    carrot: { peak: [11, 12, 1, 2, 3, 4], available: ALL_YEAR },
    'butternut-squash': { peak: [9, 10, 11], available: [8, 9, 10, 11, 12, 1, 2] },
    mushroom: { peak: ALL_YEAR },
  },
};

/**
 * Opt-out. For people who shop a globally-supplied grocery store and do not want
 * seasonality steering their plans at all.
 */
const YEAR_ROUND: Region = {
  id: 'year-round',
  name: 'No seasonal preference',
  description: 'Treat everything as in season. Disables seasonality scoring.',
  seasons: {},
};

export const REGIONS: readonly Region[] = [BC_CANADA, ON_CANADA, LAS_VEGAS, YEAR_ROUND];

export const DEFAULT_REGION_ID = 'bc-canada';

export function getRegion(regionId: string): Region {
  return REGIONS.find((r) => r.id === regionId) ?? BC_CANADA;
}

export type SeasonStatus = 'peak' | 'available' | 'out-of-season' | 'unknown';

/**
 * Season status for one ingredient in one month.
 *
 * `unknown` (no regional data and no fallback on the ingredient) is deliberately
 * distinct from `out-of-season`. Missing data must not be scored as a penalty, or
 * every under-documented ingredient silently becomes unplannable.
 */
export function seasonStatus(ingredient: Ingredient, month: number, region: Region): SeasonStatus {
  if (region.id === 'year-round') return 'peak';

  const entry = region.seasons[ingredient.id];
  if (entry) {
    if (entry.peak.includes(month)) return 'peak';
    if ((entry.available ?? entry.peak).includes(month)) return 'available';
    return 'out-of-season';
  }

  if (ingredient.seasonMonths?.length) {
    return ingredient.seasonMonths.includes(month) ? 'peak' : 'out-of-season';
  }

  // Non-produce and undocumented produce are simply not seasonal concerns.
  return ingredient.category === 'produce' ? 'unknown' : 'peak';
}

/** Convenience predicate for hard filtering: is this plannable at all this month? */
export function isInSeason(ingredient: Ingredient, month: number, region: Region): boolean {
  const status = seasonStatus(ingredient, month, region);
  return status !== 'out-of-season';
}

/** Scoring value of a season status: peak is worth full credit, storage is worth most of it. */
export function seasonScore(status: SeasonStatus): number | null {
  switch (status) {
    case 'peak': return 1;
    case 'available': return 0.6;
    case 'out-of-season': return 0;
    case 'unknown': return null; // excluded from the average rather than scored as zero
  }
}
