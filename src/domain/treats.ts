/**
 * The treat bag: small, cheap, deliberate pleasures, drawn fresh each week.
 *
 * The grab bags answer "what should I eat that I would not have thought of".
 * This answers a different question — "what would make the week nicer" — and the
 * two have almost nothing in common mechanically.
 *
 * TREATS ARE NOT INGREDIENTS, and that distinction is the whole design:
 *
 *   - Half of them are not food. A face mask has no grams, no shelf life, no
 *     nutrition and no aisle. Forcing one into `Ingredient` would mean inventing
 *     a purchase model and a spoilage risk for a thing that cannot spoil, and
 *     would put it in front of the planner, which would eventually try to cook
 *     with it.
 *   - The ones that ARE food are still not recipe ingredients. Nothing is built
 *     around a bar of dark chocolate. It is bought, and eaten, and that is all.
 *
 * So treats live here as their own small catalogue, priced in whole cents like
 * every other real amount of money in the app, and they reach the shopping list
 * as their own aisle rather than through the planner.
 *
 * Two rules the catalogue holds itself to, both enforced by tests:
 *
 *   1. NOTHING OVER TEN DOLLARS. A treat you have to think about is not a treat,
 *      it is a purchase. The ceiling is the feature.
 *   2. NOT ALL FOOD. A bag that comes back as four snacks has quietly become a
 *      snack bag. The draw guarantees the mix rather than hoping for it — see
 *      `pickTreats`.
 *
 * Prices are estimates of British Columbia shelf prices, written from general
 * knowledge and never surveyed. They are here to set expectations — "about six
 * dollars" — not to budget with.
 */

import { makeRng } from './rng';

/**
 * Herbal tea gets its own kind rather than sitting inside `edible`.
 *
 * It is food, strictly. But it is the thing this bag was asked for; it is bought
 * and kept differently from a snack, since a box lasts months; and giving it its
 * own kind is what guarantees a cup of something new every week rather than
 * leaving it to compete with the chocolate for the same slot.
 */
export type TreatKind = 'tea' | 'edible' | 'non-food';

export const TREAT_KINDS: readonly TreatKind[] = ['tea', 'edible', 'non-food'];

export const TREAT_KIND_LABELS: Readonly<Record<TreatKind, string>> = {
  tea: 'Herbal tea',
  edible: 'To eat',
  'non-food': 'Not food',
};

/** The ceiling, in cents. See rule 1 above. */
export const MAX_TREAT_CENTS = 1000;

export interface Treat {
  readonly id: string;
  readonly name: string;
  readonly kind: TreatKind;
  /** Typical shelf price in whole cents. An estimate, and never over the ceiling. */
  readonly priceCents: number;
  /** One line on what it is, or why it is worth having. Shown under the name. */
  readonly note: string;
  /**
   * Allergen group ids this contains — see `allergens.ts` for the groups.
   *
   * Declared conservatively: "may contain" counts. A treat is a small pleasure,
   * and there is no version of this where suggesting a food someone reacts to is
   * worth the extra suggestion.
   */
  readonly allergens?: readonly string[];
  /** Diet ids this rules out, e.g. `["vegan"]`. Matched against the active diets. */
  readonly excludesDiets?: readonly string[];
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Tisanes, all caffeine-free.
 *
 * Green, black and white teas are deliberately absent: they are all the same
 * plant, they carry caffeine, and a herbal tea in the evening is a different
 * proposition from a cup of something that keeps you awake.
 */
const TEAS: readonly Treat[] = [
  {
    id: 'tea-chamomile',
    name: 'Chamomile',
    kind: 'tea',
    priceCents: 549,
    note: 'The classic last cup of the day — apple-scented, and hard to get wrong.',
  },
  {
    id: 'tea-peppermint',
    name: 'Peppermint',
    kind: 'tea',
    priceCents: 449,
    note: 'Sharp and cooling. The one that settles a heavy meal.',
  },
  {
    id: 'tea-spearmint',
    name: 'Spearmint',
    kind: 'tea',
    priceCents: 499,
    note: 'Softer and sweeter than peppermint, and far better over ice.',
  },
  {
    id: 'tea-rooibos',
    name: 'Rooibos',
    kind: 'tea',
    priceCents: 649,
    note: 'Red bush from South Africa: naturally sweet, and it takes milk.',
  },
  {
    id: 'tea-ginger',
    name: 'Ginger',
    kind: 'tea',
    priceCents: 549,
    note: 'Hot and peppery. For a cold morning or an unhappy stomach.',
  },
  {
    id: 'tea-lemon-balm',
    name: 'Lemon balm',
    kind: 'tea',
    priceCents: 699,
    note: 'Lemony and faintly minty. A quiet afternoon in a cup.',
  },
  {
    id: 'tea-lemon-verbena',
    name: 'Lemon verbena',
    kind: 'tea',
    priceCents: 749,
    note: 'The most lemon-scented thing that is not a lemon.',
  },
  {
    id: 'tea-hibiscus',
    name: 'Hibiscus',
    kind: 'tea',
    priceCents: 599,
    note: 'Deep red and properly tart. Astonishing cold.',
  },
  {
    id: 'tea-rosehip',
    name: 'Rosehip',
    kind: 'tea',
    priceCents: 649,
    note: 'Tangy and floral, and traditionally a winter drink.',
  },
  {
    id: 'tea-nettle',
    name: 'Nettle',
    kind: 'tea',
    priceCents: 599,
    note: 'Grassy and mineral — a green vegetable you can drink.',
  },
  {
    id: 'tea-lemongrass',
    name: 'Lemongrass',
    kind: 'tea',
    priceCents: 549,
    note: 'Citrus without the sourness. Good with a slice of fresh ginger.',
  },
  {
    id: 'tea-fennel',
    name: 'Fennel',
    kind: 'tea',
    priceCents: 549,
    note: 'Gently aniseed. The after-dinner tea across half of Europe.',
  },
  {
    id: 'tea-tulsi',
    name: 'Tulsi (holy basil)',
    kind: 'tea',
    priceCents: 799,
    note: 'Clove-like and a little peppery. The classic Indian tisane.',
  },
  {
    id: 'tea-elderflower',
    name: 'Elderflower',
    kind: 'tea',
    priceCents: 749,
    note: 'Honeyed and floral. Summer, bottled.',
  },
  {
    id: 'tea-turmeric-ginger',
    name: 'Turmeric & ginger',
    kind: 'tea',
    priceCents: 699,
    note: 'Earthy and warming, and it stains everything it touches.',
  },
  {
    id: 'tea-dandelion',
    name: 'Dandelion root',
    kind: 'tea',
    priceCents: 749,
    note: 'Roasted and bitter — the closest a herbal tea gets to coffee.',
  },
];

/** Things to eat. Small, whole-ish, and bought on purpose rather than grabbed. */
const EDIBLES: readonly Treat[] = [
  {
    id: 'dark-chocolate',
    name: 'Dark chocolate, 70%',
    kind: 'edible',
    priceCents: 599,
    note: 'One square after dinner. Buy the good bar; it lasts longer.',
    // Most bars carry both, as an ingredient or as a "may contain".
    allergens: ['milk', 'soy'],
  },
  {
    id: 'medjool-dates',
    name: 'Medjool dates',
    kind: 'edible',
    priceCents: 849,
    note: 'Toffee that grew on a tree.',
  },
  {
    id: 'pistachios',
    name: 'Pistachios in the shell',
    kind: 'edible',
    priceCents: 899,
    note: 'Slow to eat, which is most of the point.',
    allergens: ['tree-nuts'],
  },
  {
    id: 'sesame-snaps',
    name: 'Sesame snaps',
    kind: 'edible',
    priceCents: 399,
    note: 'Brittle, nutty, and about four ingredients long.',
    allergens: ['sesame'],
  },
  {
    id: 'dried-apricots',
    name: 'Dried apricots',
    kind: 'edible',
    priceCents: 749,
    note: 'Chewy and tart, and better than they have any right to be.',
    // The bright orange ones are sulphited, and that is most of what is on a shelf.
    allergens: ['sulphites'],
  },
  {
    id: 'cacao-nibs',
    name: 'Cacao nibs',
    kind: 'edible',
    priceCents: 799,
    note: 'Chocolate from before anyone added the sugar. Good on yogurt.',
  },
  {
    id: 'marinated-olives',
    name: 'Marinated olives',
    kind: 'edible',
    priceCents: 699,
    note: 'From the deli counter, not the tin.',
  },
  {
    id: 'good-cheese',
    name: 'A small piece of good cheese',
    kind: 'edible',
    priceCents: 899,
    note: 'Something you would not normally buy, bought deliberately small.',
    allergens: ['milk'],
  },
  {
    id: 'kombucha',
    name: 'Kombucha',
    kind: 'edible',
    priceCents: 499,
    note: 'Fizzy, sour, and faintly alive.',
  },
  {
    id: 'coconut-water',
    name: 'Coconut water',
    kind: 'edible',
    priceCents: 399,
    note: 'Best very cold, from the back of the fridge.',
  },
  {
    id: 'seaweed-snacks',
    name: 'Roasted seaweed snacks',
    kind: 'edible',
    priceCents: 349,
    note: 'Salty, crisp, and gone in about a minute.',
  },
  {
    id: 'popping-corn',
    name: 'Popping corn',
    kind: 'edible',
    priceCents: 499,
    note: 'A bag of kernels and a heavy pan beats anything pre-popped.',
  },
  {
    id: 'good-honey',
    name: 'A small jar of good honey',
    kind: 'edible',
    priceCents: 899,
    note: 'Unpasteurised, single origin, and on absolutely everything.',
    excludesDiets: ['vegan'],
  },
  {
    id: 'ginger-chews',
    name: 'Ginger chews',
    kind: 'edible',
    priceCents: 449,
    note: 'Sweet, chewy, and startlingly hot.',
  },
];

/**
 * The half of the bag that is not food.
 *
 * This is what makes it a treat bag rather than a snack list. A week whose nice
 * thing was a long bath, flowers on the kitchen table or an hour with a crossword
 * is a better week, and none of it is edible.
 */
const NON_FOOD: readonly Treat[] = [
  {
    id: 'epsom-salts',
    name: 'Epsom salts',
    kind: 'non-food',
    priceCents: 599,
    note: 'A bath long enough that it goes cold.',
  },
  {
    id: 'bar-soap',
    name: 'A proper bar of soap',
    kind: 'non-food',
    priceCents: 699,
    note: 'The kind with a smell you look forward to.',
  },
  {
    id: 'face-mask',
    name: 'A sheet face mask',
    kind: 'non-food',
    priceCents: 399,
    note: 'Twenty minutes of doing nothing, with a built-in deadline.',
  },
  {
    id: 'flowers',
    name: 'A bunch of flowers',
    kind: 'non-food',
    priceCents: 899,
    note: 'Supermarket flowers, on the kitchen table, for no occasion at all.',
  },
  {
    id: 'houseplant',
    name: 'A small houseplant',
    kind: 'non-food',
    priceCents: 849,
    note: 'Something green in the house that is not dinner.',
  },
  {
    id: 'beeswax-candle',
    name: 'A beeswax candle',
    kind: 'non-food',
    priceCents: 749,
    note: 'For the last hour of the evening.',
    excludesDiets: ['vegan'],
  },
  {
    id: 'puzzle-book',
    name: 'A crossword or puzzle book',
    kind: 'non-food',
    priceCents: 799,
    note: 'Screens off, pencil out.',
  },
  {
    id: 'good-pen',
    name: 'A good pen',
    kind: 'non-food',
    priceCents: 599,
    note: 'Absurdly cheap for how often you will use it.',
  },
  {
    id: 'magazine',
    name: 'A magazine',
    kind: 'non-food',
    priceCents: 899,
    note: 'Something to read that ends.',
  },
  {
    id: 'seed-packet',
    name: 'A packet of seeds',
    kind: 'non-food',
    priceCents: 399,
    note: 'Herbs on the windowsill, eventually.',
  },
  {
    id: 'shower-steamer',
    name: 'A shower steamer',
    kind: 'non-food',
    priceCents: 499,
    note: 'Eucalyptus, five minutes, no bathtub required.',
  },
  {
    id: 'hand-cream',
    name: 'Hand cream',
    kind: 'non-food',
    priceCents: 899,
    note: 'Especially in the months that need it.',
  },
  {
    id: 'lip-balm',
    name: 'Lip balm',
    kind: 'non-food',
    priceCents: 449,
    note: 'The one you will lose within a fortnight anyway.',
  },
  {
    id: 'sleep-mask',
    name: 'A sleep mask',
    kind: 'non-food',
    priceCents: 899,
    note: 'Cheaper than blackout blinds, and works better.',
  },
  {
    id: 'tennis-ball',
    name: 'A tennis ball',
    kind: 'non-food',
    priceCents: 399,
    note: 'For rolling out the knot between your shoulder blades.',
  },
  {
    id: 'playing-cards',
    name: 'A deck of cards',
    kind: 'non-food',
    priceCents: 599,
    note: 'Two people, a table, no batteries.',
  },
  {
    id: 'postcard-and-stamp',
    name: 'A postcard and a stamp',
    kind: 'non-food',
    priceCents: 349,
    note: 'Send it to someone who will not be expecting it.',
  },
  {
    id: 'skipping-rope',
    name: 'A skipping rope',
    kind: 'non-food',
    priceCents: 999,
    note: 'Ten minutes is plenty. Ask your calves.',
  },
];

export const TREATS: readonly Treat[] = [...TEAS, ...EDIBLES, ...NON_FOOD];

const BY_ID: ReadonlyMap<string, Treat> = new Map(TREATS.map((t) => [t.id, t]));

export function getTreat(id: string): Treat | undefined {
  return BY_ID.get(id);
}

/** "$6" or "$5.49" — whole dollars lose the decimals, because most of them are noise. */
export function formatTreatPrice(treat: Treat, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: treat.priceCents % 100 === 0 ? 0 : 2,
  }).format(treat.priceCents / 100);
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

/** One drawn treat, as stored on the plan. Pinned ones survive a redraw. */
export interface TreatItem {
  readonly treatId: string;
  readonly pinned: boolean;
}

/** The slice of settings the draw reads. `PlannerSettings` satisfies it. */
export interface TreatEligibility {
  readonly allergens: readonly string[];
  readonly diets: readonly string[];
}

/** The slice of settings that decides how big the bag is. */
export interface TreatBagSettings {
  readonly treatBagEnabled: boolean;
  readonly treatCount: number;
}

/**
 * How many treats to draw, which is the size only while the bag is switched on.
 *
 * The switch and the size are two settings rather than "zero means off", for the
 * reason the grab bags have both: switching the bag off keeps the size it had, so
 * turning it back on restores the bag the household chose rather than a default
 * one. Every caller goes through here, so there is one answer to "how many" and
 * the draw never has to know a switch exists.
 */
export function treatTarget(settings: TreatBagSettings): number {
  return settings.treatBagEnabled ? Math.max(0, settings.treatCount) : 0;
}

/**
 * Treats this household can actually have.
 *
 * Allergens and diets are applied here rather than at display time, so an
 * excluded treat is never drawn at all — a bag that offers you pistachios with a
 * warning attached has already failed.
 */
export function eligibleTreats(
  settings: TreatEligibility,
  catalogue: readonly Treat[] = TREATS,
): Treat[] {
  return catalogue.filter((treat) => {
    if (treat.allergens?.some((a) => settings.allergens.includes(a))) return false;
    if (treat.excludesDiets?.some((d) => settings.diets.includes(d))) return false;
    return true;
  });
}

export interface TreatDrawOptions {
  /** Already in the bag: never drawn again, and counted when balancing the kinds. */
  readonly have?: readonly TreatItem[];
  /** Extra ids to keep out — items just trimmed off the bag, which should not return. */
  readonly exclude?: ReadonlySet<string>;
  readonly catalogue?: readonly Treat[];
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The kind order for this draw, rotated so a one-treat bag is not always tea. */
function rotatedKinds(rng: () => number): TreatKind[] {
  const offset = Math.floor(rng() * TREAT_KINDS.length);
  return TREAT_KINDS.map((_, i) => TREAT_KINDS[(i + offset) % TREAT_KINDS.length]);
}

/**
 * Draws `count` treats, spread across the kinds.
 *
 * Each pick goes to whichever kind has the fewest items in the bag so far. From
 * empty that is a plain round-robin; on a top-up it does the right thing — pin
 * two teas, ask for four, and the two new ones are not more tea.
 *
 * That balance is the point of the feature. A uniform draw over a catalogue that
 * is two thirds food comes back all food often enough to be annoying, and "not
 * all food" was the requirement.
 *
 * A kind that runs dry is skipped rather than padded from elsewhere, so a
 * household that has excluded every edible treat gets tea and bath salts instead
 * of a silently short bag.
 */
export function pickTreats(
  settings: TreatEligibility,
  count: number,
  seed: number,
  options: TreatDrawOptions = {},
): TreatItem[] {
  if (count <= 0) return [];

  const rng = makeRng(seed);
  const have = options.have ?? [];
  const taken = new Set([...have.map((t) => t.treatId), ...(options.exclude ?? [])]);

  const pools = new Map<TreatKind, Treat[]>(TREAT_KINDS.map((k) => [k, []]));
  for (const treat of shuffled(eligibleTreats(settings, options.catalogue), rng)) {
    if (!taken.has(treat.id)) pools.get(treat.kind)!.push(treat);
  }

  // Seeded from what is already in the bag, so a top-up balances the whole bag
  // rather than only the part of it being added.
  const counts = new Map<TreatKind, number>(TREAT_KINDS.map((k) => [k, 0]));
  for (const item of have) {
    const kind = getTreat(item.treatId)?.kind;
    if (kind) counts.set(kind, counts.get(kind)! + 1);
  }

  const order = rotatedKinds(rng);
  const picked: TreatItem[] = [];

  while (picked.length < count) {
    let next: TreatKind | null = null;
    for (const kind of order) {
      if (pools.get(kind)!.length === 0) continue;
      if (next === null || counts.get(kind)! < counts.get(next)!) next = kind;
    }
    if (next === null) break; // Catalogue exhausted. A short bag is the honest answer.

    picked.push({ treatId: pools.get(next)!.pop()!.id, pinned: false });
    counts.set(next, counts.get(next)! + 1);
  }

  return picked;
}

/**
 * Brings the bag to `count`, keeping what is already in it.
 *
 * Same contract as the produce bag's `fitWildcards`, for the same reasons:
 * trimming drops un-pinned items first, so shrinking by one never throws away
 * something deliberately kept, and survivors stay in their original order so the
 * list does not reshuffle itself under the stepper.
 */
export function fitTreats(
  settings: TreatEligibility,
  count: number,
  seed: number,
  keep: readonly TreatItem[] = [],
): TreatItem[] {
  const target = Math.max(0, count);

  // An id no longer in the catalogue — a treat retired between releases, or a
  // plan synced from a newer version — is dropped rather than drawn as a blank row.
  const known = keep.filter((t) => getTreat(t.treatId) !== undefined);

  const survivors = new Set(
    [...known]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned))
      .slice(0, target)
      .map((t) => t.treatId),
  );
  const kept = known.filter((t) => survivors.has(t.treatId));

  return [
    ...kept,
    ...pickTreats(settings, target - kept.length, seed, {
      have: kept,
      exclude: new Set(known.map((t) => t.treatId)),
    }),
  ];
}
