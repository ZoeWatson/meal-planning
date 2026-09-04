/**
 * Unit normalization.
 *
 * Design decision: EVERY quantity in the system is stored canonically as GRAMS.
 * Not grams-or-millilitres, not "whatever the recipe said" — grams, always.
 *
 * Why: the grocery list has to add "2 cloves garlic" to "1 tbsp minced garlic"
 * to "30g garlic" and get one number. That is only possible if there is a single
 * canonical unit, which means volume and count both have to collapse into mass.
 * Volume collapses via density (`gramsPerMl`); count collapses via per-ingredient
 * count units (`countUnits`, e.g. one garlic clove = 3g).
 *
 * The cost of this decision is that every ingredient needs density/count data
 * before a recipe using it in volume/count terms can be imported. That is a
 * feature, not a bug: it forces the failure to happen at import time, where it
 * can be fixed in bulk, instead of at plan time where it silently corrupts the
 * grocery list.
 *
 * Cooking-metric conventions are used for spoon/cup units (tsp = 5ml,
 * tbsp = 15ml, cup = 240ml) rather than US customary exact values
 * (4.93 / 14.79 / 236.6). The error is under 2%, which is far below the noise
 * floor of "one medium onion", and the round numbers display much better.
 */

export type Dimension = 'mass' | 'volume' | 'count';
export type UnitSystem = 'metric' | 'imperial';

export interface UnitDef {
  readonly dimension: Dimension;
  /** Multiplier into the dimension's base unit: grams for mass, millilitres for volume. */
  readonly toBase: number;
  /** Which system this unit belongs to when rendering. `both` units are never hidden. */
  readonly system: UnitSystem | 'both';
}

/** Canonical unit table. Keys are lowercase singular; aliases resolve via `UNIT_ALIASES`. */
export const UNITS: Readonly<Record<string, UnitDef>> = {
  // ---- mass (base: gram) ----
  mg: { dimension: 'mass', toBase: 0.001, system: 'metric' },
  g: { dimension: 'mass', toBase: 1, system: 'metric' },
  kg: { dimension: 'mass', toBase: 1000, system: 'metric' },
  oz: { dimension: 'mass', toBase: 28.3495, system: 'imperial' },
  lb: { dimension: 'mass', toBase: 453.592, system: 'imperial' },

  // ---- volume (base: millilitre) ----
  ml: { dimension: 'volume', toBase: 1, system: 'metric' },
  dl: { dimension: 'volume', toBase: 100, system: 'metric' },
  l: { dimension: 'volume', toBase: 1000, system: 'metric' },
  tsp: { dimension: 'volume', toBase: 5, system: 'both' },
  tbsp: { dimension: 'volume', toBase: 15, system: 'both' },
  cup: { dimension: 'volume', toBase: 240, system: 'imperial' },
  'fl oz': { dimension: 'volume', toBase: 30, system: 'imperial' },
  pint: { dimension: 'volume', toBase: 480, system: 'imperial' },
  quart: { dimension: 'volume', toBase: 960, system: 'imperial' },
};

/** Written forms that map onto a canonical unit key. Extend freely; importer uses this. */
export const UNIT_ALIASES: Readonly<Record<string, string>> = {
  gram: 'g', grams: 'g', gr: 'g',
  milligram: 'mg', milligrams: 'mg',
  kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml', cc: 'ml',
  litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp', t: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', T: 'tbsp',
  cups: 'cup', c: 'cup',
  'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz', floz: 'fl oz',
  pints: 'pint', pt: 'pint',
  quarts: 'quart', qt: 'quart',
};

/** Resolves a written unit string to a canonical `UNITS` key, or `null` if it is not a measure unit. */
export function canonicalUnit(written: string): string | null {
  const key = written.trim().toLowerCase();
  if (key in UNITS) return key;
  const alias = UNIT_ALIASES[key] ?? UNIT_ALIASES[written.trim()];
  return alias && alias in UNITS ? alias : null;
}

/**
 * Minimal shape `toGrams` needs from an ingredient. Declared structurally so the
 * unit layer stays independent of the full `Ingredient` type in `types.ts`.
 */
export interface Convertible {
  readonly id: string;
  readonly name: string;
  /** Density in g/ml. Required to convert volume units. */
  readonly gramsPerMl?: number;
  /** Grams per one of each ingredient-specific count unit, e.g. `{ clove: 3, head: 45 }`. */
  readonly countUnits?: Readonly<Record<string, number>>;
}

export class UnitConversionError extends Error {
  constructor(
    readonly ingredientId: string,
    readonly unit: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnitConversionError';
  }
}

/**
 * Converts a written quantity to canonical grams.
 * Throws `UnitConversionError` when the ingredient lacks the data to do so —
 * callers at import time should collect these rather than swallow them.
 */
export function toGrams(quantity: number, unit: string, ingredient: Convertible): number {
  const written = unit.trim();

  // Count units are ingredient-specific and take priority: "clove" means something
  // for garlic and nothing for flour, and must never fall through to a measure unit.
  const countGrams = ingredient.countUnits?.[written.toLowerCase()];
  if (countGrams !== undefined) return quantity * countGrams;

  const canon = canonicalUnit(written);
  if (canon === null) {
    throw new UnitConversionError(
      ingredient.id,
      written,
      `"${written}" is not a known measure unit and is not a count unit of ${ingredient.name}. ` +
        `Add it to the ingredient's countUnits (grams per one ${written}) or fix the recipe.`,
    );
  }

  const def = UNITS[canon];
  if (def.dimension === 'mass') return quantity * def.toBase;

  // volume → mass requires density
  if (ingredient.gramsPerMl === undefined) {
    throw new UnitConversionError(
      ingredient.id,
      written,
      `${ingredient.name} is measured by volume ("${quantity} ${written}") but has no gramsPerMl. ` +
        `Add a density to the ingredient so volume can be normalized to grams.`,
    );
  }
  return quantity * def.toBase * ingredient.gramsPerMl;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** How an ingredient prefers to be shown to a human, independent of how it is stored. */
export type DisplayPreference = 'mass' | 'volume' | 'count';

const MASS_LADDER: Record<UnitSystem, readonly string[]> = {
  metric: ['g', 'kg'],
  imperial: ['oz', 'lb'],
};

const VOLUME_LADDER: Record<UnitSystem, readonly string[]> = {
  metric: ['ml', 'l'],
  imperial: ['tsp', 'tbsp', 'cup'],
};

const FRACTIONS: ReadonlyArray<readonly [number, string]> = [
  [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'],
  [2 / 3, '⅔'], [3 / 4, '¾'],
];

/** Renders imperial amounts with cooking fractions: 1.5 → "1½", 0.25 → "¼". */
function formatImperialNumber(value: number): string {
  const whole = Math.floor(value);
  const frac = value - whole;
  if (frac < 0.06) return String(whole);

  let best = FRACTIONS[0];
  for (const candidate of FRACTIONS) {
    if (Math.abs(candidate[0] - frac) < Math.abs(best[0] - frac)) best = candidate;
  }
  // Too far from any cooking fraction to pretend — fall back to a decimal.
  if (Math.abs(best[0] - frac) > 0.07) return value.toFixed(1);
  return whole === 0 ? best[1] : `${whole}${best[1]}`;
}

function formatMetricNumber(value: number): string {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(1).replace(/\.0$/, '');
}

export interface FormattedQuantity {
  readonly value: number;
  readonly unit: string;
  /** Ready-to-render string, e.g. "1½ cups" or "350 g" or "3 cloves". */
  readonly text: string;
}

/**
 * Renders canonical grams back into whatever a human wants to read, in the
 * requested system. Count-preferring ingredients render as counts regardless of
 * system, because "2 onions" is correct in both and "300 g onion" is correct in
 * neither.
 */
export function formatQuantity(
  grams: number,
  ingredient: Convertible & { readonly displayAs?: DisplayPreference; readonly countUnit?: string },
  system: UnitSystem,
): FormattedQuantity {
  const prefer = ingredient.displayAs ?? 'mass';

  if (prefer === 'count' && ingredient.countUnits) {
    const unitName = ingredient.countUnit ?? Object.keys(ingredient.countUnits)[0];
    const perUnit = ingredient.countUnits[unitName];
    if (perUnit) {
      const count = grams / perUnit;
      const rounded = count < 1 ? Math.round(count * 4) / 4 : Math.round(count * 2) / 2;
      const label = rounded === 1 ? unitName : pluralize(unitName);
      return { value: rounded, unit: unitName, text: `${formatImperialNumber(rounded)} ${label}` };
    }
  }

  if (prefer === 'volume' && ingredient.gramsPerMl) {
    const ml = grams / ingredient.gramsPerMl;
    return pickFromLadder(ml, VOLUME_LADDER[system], system);
  }

  return pickFromLadder(grams, MASS_LADDER[system], system);
}

/** Walks up a unit ladder to the largest unit that still yields a value >= 1. */
function pickFromLadder(baseValue: number, ladder: readonly string[], system: UnitSystem): FormattedQuantity {
  let chosen = ladder[0];
  for (const unit of ladder) {
    if (baseValue / UNITS[unit].toBase >= 1) chosen = unit;
  }
  const value = baseValue / UNITS[chosen].toBase;
  const text = system === 'imperial' ? formatImperialNumber(value) : formatMetricNumber(value);
  return { value, unit: chosen, text: `${text} ${chosen}` };
}

function pluralize(unit: string): string {
  // "each" is already a quantity word — "2 eaches" is not English.
  if (unit === 'each') return unit;
  if (unit.endsWith('s') || unit.endsWith('ch') || unit.endsWith('sh')) return `${unit}es`;
  return `${unit}s`;
}
