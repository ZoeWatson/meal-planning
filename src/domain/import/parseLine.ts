/**
 * Ingredient-line parser.
 *
 * Almost every recipe source in the world gives you a line of prose —
 * "2 cloves garlic, minced" — rather than structured fields. Requiring those to
 * be split by hand is the actual bottleneck in building a large library: 500
 * recipes at ~10 lines each is 5,000 manual splits, which nobody finishes.
 *
 * So this turns a line into the strict wire format. The governing principle is
 * that it is CONSERVATIVE: when a line is ambiguous it fails loudly rather than
 * guessing, because a silently mis-parsed quantity corrupts the grocery list in a
 * way nobody will notice until they are standing in a shop with the wrong food.
 * A rejected line costs thirty seconds. A mis-parsed one costs a meal.
 *
 * It does NOT try to be clever about ingredient identity — resolving "garlic" to
 * an ingredient id is the importer's job, using its alias index.
 */

export interface ParsedLine {
  readonly quantity: number;
  readonly unit: string;
  /** Ingredient name as written, for the importer's alias lookup to resolve. */
  readonly item: string;
  readonly prep?: string;
  readonly optional?: boolean;
  /** Set when a judgement call was made that a human should confirm. */
  readonly notes?: readonly string[];
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedLine }
  | { readonly ok: false; readonly reason: string };

const UNICODE_FRACTIONS: Readonly<Record<string, number>> = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

/**
 * Words that mean "a small amount" rather than a measurable quantity. Treated as
 * count units of 1 so the line parses, but flagged — a pinch of saffron and a
 * pinch of salt are not the same thing and only a human knows which matters.
 */
const VAGUE_UNITS = new Set(['pinch', 'dash', 'splash', 'handful', 'knob', 'sprig', 'bunch']);

/** Trailing phrases that mark an ingredient as optional rather than required. */
const OPTIONAL_MARKERS = [
  'optional', 'to taste', 'to serve', 'for serving', 'for garnish',
  'to garnish', 'if desired', 'plus more', 'as needed',
];

/** Words between the quantity and the ingredient that carry no information. */
const NOISE_WORDS = new Set([
  'of', 'a', 'an', 'the', 'fresh', 'freshly', 'large', 'small', 'medium',
  'good', 'quality', 'ripe', 'about', 'approximately', 'roughly', 'heaped', 'level',
]);

/**
 * Unit words the parser recognises before an ingredient name.
 *
 * Deliberately broader than `units.ts` knows how to convert: a unit recognised
 * here but unconvertible later produces a clear "add a countUnit" error from the
 * importer, which is far more useful than this parser folding the word into the
 * ingredient name and reporting "unknown ingredient: clove garlic".
 */
const UNIT_WORDS = new Set([
  'g', 'gram', 'grams', 'gr', 'kg', 'kilogram', 'kilograms', 'kilo', 'kilos',
  'mg', 'milligram', 'milligrams',
  'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds',
  'ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters', 'cc',
  'l', 'litre', 'litres', 'liter', 'liters', 'dl',
  'tsp', 't', 'teaspoon', 'teaspoons',
  'tbsp', 'tbs', 'tablespoon', 'tablespoons',
  'cup', 'cups', 'c',
  'fl', 'floz', 'pint', 'pints', 'pt', 'quart', 'quarts', 'qt', 'gallon',
  'clove', 'cloves', 'head', 'heads', 'bunch', 'bunches', 'sprig', 'sprigs',
  'slice', 'slices', 'can', 'cans', 'tin', 'tins', 'jar', 'jars',
  'stalk', 'stalks', 'stick', 'sticks', 'rib', 'ribs', 'ear', 'ears',
  'piece', 'pieces', 'fillet', 'fillets', 'pinch', 'pinches', 'dash',
  'handful', 'handfuls', 'knob', 'bag', 'bags', 'packet', 'packets', 'pack',
  'each', 'whole',
]);

/** Singularises a unit word so it matches `units.ts` / `countUnits` keys. */
function singularise(unit: string): string {
  const map: Record<string, string> = {
    grams: 'g', gram: 'g', gr: 'g',
    kilograms: 'kg', kilogram: 'kg', kilos: 'kg', kilo: 'kg',
    milligrams: 'mg', milligram: 'mg',
    ounces: 'oz', ounce: 'oz', pounds: 'lb', pound: 'lb', lbs: 'lb',
    millilitres: 'ml', millilitre: 'ml', milliliters: 'ml', milliliter: 'ml', cc: 'ml',
    litres: 'l', litre: 'l', liters: 'l', liter: 'l',
    teaspoons: 'tsp', teaspoon: 'tsp', t: 'tsp',
    tablespoons: 'tbsp', tablespoon: 'tbsp', tbs: 'tbsp',
    cups: 'cup', c: 'cup',
    floz: 'fl oz', pints: 'pint', pt: 'pint', quarts: 'quart', qt: 'quart',
    cloves: 'clove', heads: 'head', bunches: 'bunch', sprigs: 'sprig',
    slices: 'slice', cans: 'can', tins: 'tin', tin: 'can', jars: 'jar',
    stalks: 'stalk', sticks: 'stick', ribs: 'rib', ears: 'ear',
    pieces: 'piece', fillets: 'fillet', pinches: 'pinch',
    handfuls: 'handful', bags: 'bag', packets: 'packet', packet: 'pack',
    whole: 'each',
  };
  return map[unit] ?? unit;
}

/** Parses a leading number: "2", "1/2", "1 1/2", "1½", "½", "2-3", "2 to 3". */
function readQuantity(tokens: string[]): { value: number; consumed: number; note?: string } | null {
  const numeric = (token: string): number | null => {
    if (token in UNICODE_FRACTIONS) return UNICODE_FRACTIONS[token];

    // Mixed unicode form: "1½"
    const mixed = /^(\d+)([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/.exec(token);
    if (mixed) return Number(mixed[1]) + UNICODE_FRACTIONS[mixed[2]];

    // Vulgar fraction: "1/2"
    const fraction = /^(\d+)\/(\d+)$/.exec(token);
    if (fraction) {
      const denominator = Number(fraction[2]);
      return denominator === 0 ? null : Number(fraction[1]) / denominator;
    }

    if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
    return null;
  };

  // Ranges are checked BEFORE the plain numeric read, because "2-3" is not a
  // number and would otherwise be rejected before ever reaching this branch.
  // Averaged rather than taking an end, and flagged, since silently picking the
  // low or high end would bias every ranged recipe in the library one way.
  const rangeInline = /^(\d+(?:\.\d+)?)[-–—](\d+(?:\.\d+)?)$/.exec(tokens[0]);
  if (rangeInline) {
    const low = Number(rangeInline[1]);
    const high = Number(rangeInline[2]);
    return { value: (low + high) / 2, consumed: 1, note: `range ${low}-${high}, averaged` };
  }

  const first = numeric(tokens[0]);
  if (first === null) return null;

  if (tokens[1] === 'to' && tokens[2] !== undefined) {
    const high = numeric(tokens[2]);
    if (high !== null) {
      return { value: (first + high) / 2, consumed: 3, note: `range ${first}-${high}, averaged` };
    }
  }

  // Mixed number across two tokens: "1 1/2"
  if (tokens[1] !== undefined && Number.isInteger(first)) {
    const second = numeric(tokens[1]);
    if (second !== null && second < 1 && tokens[1].includes('/')) {
      return { value: first + second, consumed: 2 };
    }
    if (second !== null && tokens[1] in UNICODE_FRACTIONS) {
      return { value: first + second, consumed: 2 };
    }
  }

  return { value: first, consumed: 1 };
}

/**
 * Parses one written ingredient line.
 *
 * Examples that work:
 *   "2 cloves garlic, minced"          → 2 clove garlic (prep: minced)
 *   "1½ cups flour"                    → 1.5 cup flour
 *   "800 g chicken thighs"             → 800 g chicken thighs
 *   "1 (400g) can chickpeas, drained"  → 1 can chickpeas (prep: drained)
 *   "2 tbsp olive oil, plus more"      → 2 tbsp olive oil (optional extra flagged)
 *   "juice of 1 lemon"                 → 1 each lemon (prep: juiced)
 *   "Salt to taste"                    → 1 pinch salt (optional)
 */
export function parseIngredientLine(input: string): ParseResult {
  const notes: string[] = [];
  let text = input.trim();

  if (text === '') return { ok: false, reason: 'Empty line.' };

  // Strip list bullets and leading punctuation.
  text = text.replace(/^[-*•·–—•]\s*/, '');

  // "juice of 1 lemon" / "zest of 2 limes" — rewrite into quantity-first form so
  // the rest of the parser sees a shape it understands.
  const derived = /^(juice|zest|rind)\s+of\s+(.*)$/i.exec(text);
  if (derived) {
    text = derived[2];
    notes.push(`${derived[1].toLowerCase()} only`);
  }

  // Parenthetical asides are notes, not quantities: "1 (400 g) can chickpeas".
  const parentheticals: string[] = [];
  text = text.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    parentheticals.push(inner.trim());
    return ' ';
  });

  let optional = false;
  const lowered = text.toLowerCase();
  for (const marker of OPTIONAL_MARKERS) {
    if (lowered.includes(marker)) {
      optional = true;
      notes.push(`marked optional ("${marker}")`);
    }
  }

  // Everything after the first comma is preparation, not identity.
  let prep: string | undefined;
  const commaIndex = text.indexOf(',');
  if (commaIndex !== -1) {
    prep = text.slice(commaIndex + 1).trim().replace(/\s+/g, ' ') || undefined;
    text = text.slice(0, commaIndex);
  }

  // Markers sitting inside the name itself ("Salt to taste") have to come out, or
  // they end up as part of the ingredient and never resolve. Markers after the
  // comma are already safely in `prep`.
  if (optional) {
    for (const marker of OPTIONAL_MARKERS) {
      text = text.replace(new RegExp(`\\s*\\b${marker}\\b.*$`, 'i'), '');
    }
  }

  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: false, reason: 'No ingredient found before the comma.' };

  const quantity = readQuantity(tokens);
  let index = 0;
  let value: number;
  let unit = 'each';

  if (quantity === null) {
    // No leading number. Only acceptable if the line is explicitly vague
    // ("Salt to taste"), where 1 pinch is a fair reading of the author's intent.
    if (!optional) {
      return {
        ok: false,
        reason:
          'No quantity found. Add one, or mark the line optional ("to taste", "optional") ' +
          'so it can be treated as a pinch.',
      };
    }
    value = 1;
    unit = 'pinch';
    notes.push('no quantity given; assumed a pinch');
  } else {
    value = quantity.value;
    index = quantity.consumed;
    if (quantity.note) notes.push(quantity.note);

    // Optional unit word directly after the quantity.
    const next = tokens[index]?.toLowerCase().replace(/\.$/, '');
    if (next !== undefined && UNIT_WORDS.has(next)) {
      // "fl oz" is the one two-word unit worth handling.
      if (next === 'fl' && tokens[index + 1]?.toLowerCase().startsWith('oz')) {
        unit = 'fl oz';
        index += 2;
      } else {
        unit = singularise(next);
        index += 1;
      }
      if (VAGUE_UNITS.has(unit)) {
        notes.push(`"${unit}" is an approximate unit — check the gram weight`);
      }
    }
  }

  // Drop filler between the unit and the ingredient ("of", "a", "fresh", "large").
  while (index < tokens.length && NOISE_WORDS.has(tokens[index].toLowerCase())) {
    index += 1;
  }

  const item = tokens.slice(index).join(' ').trim();
  if (item === '') {
    return { ok: false, reason: `Found a quantity ("${input.trim()}") but no ingredient name.` };
  }
  if (value <= 0) {
    return { ok: false, reason: `Quantity must be greater than zero (got ${value}).` };
  }

  const allPrep = [prep, ...parentheticals].filter(Boolean).join('; ') || undefined;

  return {
    ok: true,
    value: {
      quantity: Number(value.toFixed(4)),
      unit,
      item: item.replace(/\s+/g, ' '),
      prep: allPrep,
      optional: optional || undefined,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}
