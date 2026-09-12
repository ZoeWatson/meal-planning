/**
 * Ingredient stub generation.
 *
 * The documented workflow says "build the ingredient dictionary first — roughly
 * 250-350 entries". That is the genuine cost of a 500-recipe library, and typing
 * it from a blank file is what makes people give up around entry forty.
 *
 * So: point the importer at a recipe file, collect everything that failed to
 * resolve, and emit a filled-in skeleton for each one — category guessed from the
 * name, and per-category defaults for the fields that must exist. What is left is
 * checking numbers rather than inventing structure.
 *
 * The guesses are deliberately conservative and every stub is marked `"TODO"`,
 * because a plausible-looking wrong pack size is worse than an obviously blank
 * one: the first ships silently into the waste model, the second gets fixed.
 */

import type { IngredientCategory } from '../types';
import type { ImportResult, RawIngredient } from './importer';

/**
 * Keyword → category. First match wins, so the order matters: "coconut milk" must
 * hit `canned` before "milk" pulls it into `dairy`.
 */
const CATEGORY_HINTS: ReadonlyArray<readonly [RegExp, IngredientCategory]> = [
  [/\b(canned|tinned|tin of|can of)\b/i, 'canned'],
  [/\bcoconut (milk|cream)\b/i, 'canned'],
  [/\b(stocks?|broths?|passata|purées?|purees?|pastes?|sauces?|vinegars?|mustard|ketchup|mayo|mayonnaise|tahini|miso|honey|syrups?|jam)\b/i, 'condiment'],
  [/\b(oils?|ghee)\b/i, 'oil'],
  [/\b(chicken|beef|pork|lamb|turkey|duck|bacon|sausages?|mince|steaks?|ham|veal|venison)\b/i, 'meat'],
  [/\b(salmon|tuna|cod|haddock|prawns?|shrimps?|crab|lobster|mussels?|clams?|squid|anchov(y|ies)|sardines?|fish)\b/i, 'seafood'],
  [/\b(milk|cheeses?|yogh?urt|cream|butter|eggs?|feta|parmesan|mozzarella|cheddar|ricotta|mascarpone)\b/i, 'dairy'],
  [/\b(bread|loaf|loaves|tortillas?|pita|naan|buns?|rolls?|bagels?|croissants?|pastry)\b/i, 'bakery'],
  [/\bfrozen\b/i, 'frozen'],
  [/\b(flour|sugar|baking powder|baking soda|yeast|cocoa|cornstarch|cornflour|vanilla)\b/i, 'baking'],
  [/\b(rice|pasta|noodles?|spaghetti|penne|couscous|quinoa|oats?|barley|bulgur|polenta|semolina|tortellini|gnocchi)\b/i, 'grain'],
  [/\b(beans?|lentils?|chickpeas?|tofu|tempeh|edamame|split peas?)\b/i, 'legume'],
  [/\b(salt|peppercorns?|cumin|paprika|cinnamon|turmeric|chilli|chili|curry powder|oregano|thyme|rosemary|bay lea(f|ves)|nutmeg|cardamom|saffron|spices?|seasoning)\b/i, 'spice'],
  [/\b(juices?|wine|beer|coffee|tea|cordial|soda)\b/i, 'beverage'],

  // "pepper" is genuinely two ingredients. The vegetable forms have to be matched
  // explicitly and FIRST, because the bare-word rule below would otherwise file
  // every bell pepper as a spice — and a spice-defaulted vegetable gets the wrong
  // shelf life, the wrong pack size, and no seasonality.
  [/\b(bell|sweet|romano|padr[oó]n)\s+peppers?\b/i, 'produce'],
  [/\b(red|green|yellow|orange)\s+peppers?\b/i, 'produce'],
  [/\bpeppers?\b/i, 'spice'],
];

export function guessCategory(name: string): IngredientCategory {
  for (const [pattern, category] of CATEGORY_HINTS) {
    if (pattern.test(name)) return category;
  }
  // Produce is the right default: it is the largest category by count, and it is
  // also the one where a wrong guess is most visible (seasonality and waste both
  // key off it), so mistakes surface early rather than hiding.
  return 'produce';
}

interface CategoryDefaults {
  readonly unit: string;
  readonly gramsPerPack: number;
  readonly divisible: boolean;
  readonly costPerKg: number;
  readonly shelfLifeDays: number;
  /**
   * Count units almost every ingredient in this category needs.
   *
   * Without these the stub → merge → check loop cannot converge: recipes say
   * "1 cauliflower" and "1 can chickpeas", and a stub with no `each` or `can`
   * fails conversion on the very next pass. Placeholder weights, all flagged.
   */
  readonly countUnits?: Readonly<Record<string, number>>;
}

/**
 * Starting points per category. Every one of these is a guess and is marked as
 * such — `gramsPerPack` and `divisible` in particular drive the entire waste
 * model, so they are the two fields to check first on every stub.
 */
const DEFAULTS: Readonly<Record<IngredientCategory, CategoryDefaults>> = {
  // `handful` and `pinch` are here because recipes write herbs that way far more
  // often than they weigh them, and a stub without them fails conversion on the
  // very next pass — sending the user off to define a unit on an ingredient they
  // have only just created. Both are vague by nature and flagged as such by the
  // line parser, so the weights are honest placeholders rather than claims.
  produce:   { unit: 'kg',     gramsPerPack: 100,  divisible: true,  costPerKg: 5,   shelfLifeDays: 7,
               countUnits: { each: 150, bunch: 100, head: 400, sprig: 3, clove: 3, stalk: 40,
                             handful: 25, pinch: 1 } },
  meat:      { unit: 'pack',   gramsPerPack: 500,  divisible: false, costPerKg: 14,  shelfLifeDays: 3,
               countUnits: { each: 150, fillet: 150, piece: 150 } },
  seafood:   { unit: 'pack',   gramsPerPack: 300,  divisible: false, costPerKg: 28,  shelfLifeDays: 2,
               countUnits: { each: 150, fillet: 150 } },
  dairy:     { unit: 'pack',   gramsPerPack: 250,  divisible: false, costPerKg: 12,  shelfLifeDays: 14,
               countUnits: { each: 50, slice: 20 } },
  bakery:    { unit: 'pack',   gramsPerPack: 500,  divisible: false, costPerKg: 6,   shelfLifeDays: 6,
               countUnits: { each: 60, slice: 45, loaf: 675 } },
  grain:     { unit: 'bag',    gramsPerPack: 500,  divisible: false, costPerKg: 4,   shelfLifeDays: 730,
               countUnits: { bag: 500 } },
  legume:    { unit: 'bag',    gramsPerPack: 500,  divisible: false, costPerKg: 5,   shelfLifeDays: 730,
               countUnits: { can: 400, tin: 400, bag: 500 } },
  canned:    { unit: 'can',    gramsPerPack: 400,  divisible: false, costPerKg: 4,   shelfLifeDays: 730,
               countUnits: { can: 400, tin: 400, jar: 400 } },
  frozen:    { unit: 'bag',    gramsPerPack: 500,  divisible: false, costPerKg: 6,   shelfLifeDays: 180,
               countUnits: { bag: 500 } },
  spice:     { unit: 'jar',    gramsPerPack: 45,   divisible: false, costPerKg: 55,  shelfLifeDays: 730,
               countUnits: { pinch: 0.4, dash: 0.6, jar: 45 } },
  condiment: { unit: 'jar',    gramsPerPack: 300,  divisible: false, costPerKg: 10,  shelfLifeDays: 365,
               countUnits: { jar: 300, splash: 5, dash: 3 } },
  oil:       { unit: 'bottle', gramsPerPack: 500,  divisible: false, costPerKg: 12,  shelfLifeDays: 540,
               countUnits: { bottle: 500, splash: 5, glug: 15 } },
  baking:    { unit: 'bag',    gramsPerPack: 500,  divisible: false, costPerKg: 4,   shelfLifeDays: 365,
               countUnits: { bag: 500, pinch: 0.5 } },
  beverage:  { unit: 'carton', gramsPerPack: 1000, divisible: false, costPerKg: 3,   shelfLifeDays: 30,
               countUnits: { carton: 1000, splash: 15 } },
  other:     { unit: 'pack',   gramsPerPack: 250,  divisible: false, costPerKg: 8,   shelfLifeDays: 30,
               countUnits: { each: 100, pack: 250 } },
};

/** Categories usually measured by volume, which therefore need a density. */
const NEEDS_DENSITY = new Set<IngredientCategory>(['oil', 'condiment', 'beverage']);

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export interface Stub extends RawIngredient {
  /** Fields a human must check before this is trustworthy. */
  readonly TODO: readonly string[];
  /** How many recipe lines wanted this — highest first is the order to work in. */
  readonly _usedBy: number;
}

export function stubFor(name: string, usedBy = 1): Stub {
  const category = guessCategory(name);
  const d = DEFAULTS[category];

  const todo = ['purchase.gramsPerPack', 'purchase.divisible', 'purchase.costPerKg', 'shelfLifeDays'];
  if (d.countUnits) todo.push('countUnits (placeholder weights)');
  if (NEEDS_DENSITY.has(category)) todo.push('gramsPerMl');
  todo.push('nutritionPer100g');

  return {
    id: slugify(name),
    name: titleCase(name),
    aliases: [name.toLowerCase()],
    category,
    ...(d.countUnits ? { countUnits: { ...d.countUnits } } : {}),
    ...(category === 'produce' ? { displayAs: 'count' as const, countUnit: 'each' } : {}),
    ...(NEEDS_DENSITY.has(category) ? { gramsPerMl: 1.0 } : {}),
    purchase: {
      unit: d.unit,
      gramsPerPack: d.gramsPerPack,
      divisible: d.divisible,
      costPerKg: d.costPerKg,
    },
    shelfLifeDays: d.shelfLifeDays,
    TODO: todo,
    _usedBy: usedBy,
  };
}

/**
 * Builds stubs for everything an import could not resolve, ordered by how many
 * recipes wanted each one.
 *
 * The ordering is the point: across 500 recipes a small number of missing
 * ingredients cause most of the rejections, so working top-down clears the
 * backlog far faster than going alphabetically.
 */
export function stubsFromResult(result: ImportResult): Stub[] {
  const counts = new Map<string, number>();
  for (const issue of result.issues) {
    if (issue.unresolvedItem) {
      const key = issue.unresolvedItem.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const byId = new Map<string, Stub>();
  for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const stub = stubFor(name, count);
    const existing = byId.get(stub.id);
    if (existing) {
      // Two spellings of the same thing — fold the second in as an alias rather
      // than emitting a duplicate id the importer would then warn about.
      byId.set(stub.id, {
        ...existing,
        aliases: [...new Set([...(existing.aliases ?? []), ...(stub.aliases ?? [])])],
        _usedBy: existing._usedBy + count,
      });
    } else {
      byId.set(stub.id, stub);
    }
  }

  return [...byId.values()].sort((a, b) => b._usedBy - a._usedBy);
}

function titleCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
