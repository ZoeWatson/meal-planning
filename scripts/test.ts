/**
 * Assertion tests.
 *
 * Plain `node:assert` run through tsx rather than a test framework — the project
 * has one genuinely risky pure function (the ingredient-line parser) and adding a
 * runner for it would be more machinery than the problem deserves. Swap in vitest
 * the moment there is a second thing worth testing properly.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { parseIngredientLine, type ParsedLine } from '../src/domain/import/parseLine';
import { importBundle, type RawRecipe } from '../src/domain/import/importer';
import { toBundle } from '../src/domain/import/export';
import { guessCategory, stubsFromResult } from '../src/domain/import/stubs';
import { loadSeedData } from '../src/data/seed';
import { REGIONS, getRegion, seasonStatus } from '../src/domain/seasonality';
import { produceKind } from '../src/domain/produce';
import { fitWildcards, type WildcardSizes } from '../src/domain/planner/generate';
import type { PlanningContext } from '../src/domain/planner/scoring';
import type { Id, Ingredient, PlannerSettings, Recipe, WildcardItem } from '../src/domain/types';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`\x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

function group(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

/** Narrows a ParseResult, failing the test if the line did not parse. */
function mustParse(input: string): ParsedLine {
  const result = parseIngredientLine(input);
  if (!result.ok) assert.fail(`"${input}" failed to parse: ${result.reason}`);
  return result.value;
}

function expectLine(
  input: string,
  expected: { quantity: number; unit: string; item: string; prep?: string; optional?: boolean },
): void {
  const { quantity, unit, item, prep, optional } = mustParse(input);
  assert.equal(quantity, expected.quantity, `"${input}" quantity`);
  assert.equal(unit, expected.unit, `"${input}" unit`);
  assert.equal(item, expected.item, `"${input}" item`);
  if (expected.prep !== undefined) assert.equal(prep, expected.prep, `"${input}" prep`);
  if (expected.optional !== undefined) {
    assert.equal(optional ?? false, expected.optional, `"${input}" optional`);
  }
}

function expectReject(input: string): void {
  const result = parseIngredientLine(input);
  assert.ok(!result.ok, `"${input}" should have been rejected but parsed`);
}

// ---------------------------------------------------------------------------

group('Ingredient line parsing — the ordinary shapes');

test('plain metric weight', () =>
  expectLine('800 g chicken thighs', { quantity: 800, unit: 'g', item: 'chicken thighs' }));
test('count with unit', () =>
  expectLine('2 cloves garlic', { quantity: 2, unit: 'clove', item: 'garlic' }));
test('bare count', () =>
  expectLine('1 onion', { quantity: 1, unit: 'each', item: 'onion' }));
test('spoon measure', () =>
  expectLine('3 tbsp olive oil', { quantity: 3, unit: 'tbsp', item: 'olive oil' }));
test('abbreviated with period', () =>
  expectLine('2 tsp. cumin', { quantity: 2, unit: 'tsp', item: 'cumin' }));
test('imperial weight', () =>
  expectLine('1 lb ground beef', { quantity: 1, unit: 'lb', item: 'ground beef' }));

group('Fractions');

test('vulgar fraction', () =>
  expectLine('1/2 cup rice', { quantity: 0.5, unit: 'cup', item: 'rice' }));
test('mixed vulgar', () =>
  expectLine('1 1/2 cups flour', { quantity: 1.5, unit: 'cup', item: 'flour' }));
test('unicode fraction', () =>
  expectLine('½ tsp salt', { quantity: 0.5, unit: 'tsp', item: 'salt' }));
test('mixed unicode, joined', () =>
  expectLine('1½ cups milk', { quantity: 1.5, unit: 'cup', item: 'milk' }));
test('mixed unicode, spaced', () =>
  expectLine('2 ¼ cups stock', { quantity: 2.25, unit: 'cup', item: 'stock' }));
test('decimal', () =>
  expectLine('0.5 kg potatoes', { quantity: 0.5, unit: 'kg', item: 'potatoes' }));

group('Ranges');

test('hyphen range averages', () =>
  expectLine('2-3 cloves garlic', { quantity: 2.5, unit: 'clove', item: 'garlic' }));
test('word range averages', () =>
  expectLine('2 to 4 tbsp water', { quantity: 3, unit: 'tbsp', item: 'water' }));
test('range is flagged for review', () => {
  const parsed = mustParse('2-3 cloves garlic');
  assert.ok(parsed.notes?.some((n) => n.includes('averaged')));
});

group('Preparation and asides');

test('comma becomes prep', () =>
  expectLine('2 cloves garlic, minced', { quantity: 2, unit: 'clove', item: 'garlic', prep: 'minced' }));
test('parenthetical becomes prep, not quantity', () =>
  expectLine('1 (400 g) can chickpeas', { quantity: 1, unit: 'can', item: 'chickpeas', prep: '400 g' }));
test('prep and parenthetical combine', () => {
  assert.equal(mustParse('1 (400g) can black beans, drained').prep, 'drained; 400g');
});
test('noise words are dropped', () =>
  expectLine('2 large ripe tomatoes', { quantity: 2, unit: 'each', item: 'tomatoes' }));
test('leading bullet is stripped', () =>
  expectLine('- 250 g pasta', { quantity: 250, unit: 'g', item: 'pasta' }));

group('Optional and vague lines');

test('to taste is optional', () =>
  expectLine('Salt to taste', { quantity: 1, unit: 'pinch', item: 'Salt', optional: true }));
test('explicit optional marker', () => {
  assert.equal(mustParse('30 g parmesan, optional').optional, true);
});
test('plus more is optional', () => {
  assert.equal(mustParse('2 tbsp olive oil, plus more for drizzling').optional, true);
});
test('juice of N X', () =>
  expectLine('juice of 1 lemon', { quantity: 1, unit: 'each', item: 'lemon' }));

group('Conservative rejection — the important half');

test('no quantity is rejected', () => expectReject('Chicken thighs'));
test('quantity with no ingredient is rejected', () => expectReject('2 tbsp'));
test('empty line is rejected', () => expectReject('   '));
test('zero quantity is rejected', () => expectReject('0 g salt'));
test('rejection explains the fix', () => {
  const result = parseIngredientLine('Chicken thighs');
  assert.ok(!result.ok, 'should reject');
  assert.ok(/quantity/i.test(result.reason) && /optional/i.test(result.reason));
});

group('Importer integration');

test('raw lines import end to end', () => {
  const seed = loadSeedData();
  const recipe: RawRecipe = {
    id: 'test-raw', name: 'Raw line test', mealType: 'full', baseServings: 2,
    prepMinutes: 5, cookMinutes: 5, steps: [],
    ingredients: [
      { raw: '2 cloves garlic, minced' },
      { raw: '400 g potatoes' },
      { raw: '1 tbsp olive oil' },
    ],
  };
  const result = importBundle({ recipes: [recipe] }, seed.ingredients);
  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));

  const imported = result.recipes[0];
  assert.equal(imported.ingredients.length, 3);
  assert.equal(imported.ingredients[0].ingredientId, 'garlic');
  assert.equal(imported.ingredients[0].grams, 6, '2 cloves = 6 g');
  assert.equal(imported.ingredients[1].grams, 400);
  assert.ok(Math.abs(imported.ingredients[2].grams - 13.8) < 0.1, '1 tbsp oil is about 13.8 g');
});

test('unparseable raw line rejects the whole recipe', () => {
  const seed = loadSeedData();
  const recipe: RawRecipe = {
    id: 'bad', name: 'Bad', mealType: 'full', baseServings: 2,
    prepMinutes: 0, cookMinutes: 0, steps: [],
    ingredients: [{ raw: 'some garlic' }],
  };
  const result = importBundle({ recipes: [recipe] }, seed.ingredients);
  assert.equal(result.recipes.length, 0, 'nothing imported half-resolved');
  assert.equal(result.rejected.length, 1);
  assert.ok(/quantity/i.test(result.rejected[0].reasons.join(' ')));
});

test('seed library imports with zero rejections', () => {
  const seed = loadSeedData();
  assert.equal(seed.rejected.length, 0, JSON.stringify(seed.rejected));
  assert.ok(seed.ok, JSON.stringify(seed.issues.filter((i) => i.severity === 'error')));
});

group('Stub category inference');

function expectCategory(name: string, expected: string): void {
  const actual = guessCategory(name);
  assert.equal(actual, expected, `"${name}" was ${actual}, expected ${expected}`);
}

test('plurals are matched, not just singulars', () => {
  // The first version used \bnoodle\b, which silently missed every plural — and
  // recipe lines are overwhelmingly written in the plural.
  expectCategory('udon noodles', 'grain');
  expectCategory('black beans', 'legume');
  expectCategory('rolled oats', 'grain');
  expectCategory('free range eggs', 'dairy');
  expectCategory('king prawns', 'seafood');
  expectCategory('anchovies', 'seafood');
});

test('pepper disambiguates between vegetable and spice', () => {
  expectCategory('bell peppers', 'produce');
  expectCategory('red pepper', 'produce');
  expectCategory('black pepper', 'spice');
  expectCategory('peppercorns', 'spice');
});

test('specific rules beat general ones', () => {
  expectCategory('coconut milk', 'canned');
  expectCategory('white miso paste', 'condiment');
  expectCategory('sesame oil', 'oil');
  expectCategory('canned tomatoes', 'canned');
});

test('unknown things default to produce', () => {
  expectCategory('cauliflower', 'produce');
  expectCategory('romanesco', 'produce');
});

test('stubs carry a TODO and are ordered by demand', () => {
  const seed = loadSeedData();
  const result = importBundle({
    recipes: [{
      id: 'x', name: 'X', mealType: 'full', baseServings: 2,
      prepMinutes: 0, cookMinutes: 0, steps: [],
      // Deliberately things the library does not have — the point of a stub is
      // that nothing resolved, so anything stocked here would test nothing.
      ingredients: [
        { raw: '1 kohlrabi' },
        { raw: '2 tbsp doubanjiang' },
        { raw: '1 kohlrabi' },
      ],
    }],
  }, seed.ingredients);

  const stubs = stubsFromResult(result);
  assert.equal(stubs[0].id, 'kohlrabi', 'most-wanted first');
  assert.equal(stubs[0]._usedBy, 2);
  assert.ok(stubs[0].TODO.includes('purchase.divisible'));
});

group('Regional seasonality');

test('region ids are unique and resolvable', () => {
  const ids = REGIONS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(getRegion(id).id, id);
});

test('every region has a name and a description', () => {
  for (const region of REGIONS) {
    assert.ok(region.name.length > 0, `${region.id} has no name`);
    assert.ok(region.description.length > 0, `${region.id} has no description`);
  }
});

test('all months are 1-12', () => {
  for (const region of REGIONS) {
    for (const [ingredientId, entry] of Object.entries(region.seasons)) {
      for (const month of [...entry.peak, ...(entry.available ?? [])]) {
        assert.ok(
          Number.isInteger(month) && month >= 1 && month <= 12,
          `${region.id}/${ingredientId}: ${month}`,
        );
      }
    }
  }
});

test('available always covers peak', () => {
  // Otherwise a month is simultaneously "peak" and absent from availability. Peak
  // is checked first so nothing breaks, but the data would be self-contradictory
  // and the next person to read it would be right to be confused.
  for (const region of REGIONS) {
    for (const [ingredientId, entry] of Object.entries(region.seasons)) {
      if (!entry.available) continue;
      for (const month of entry.peak) {
        assert.ok(
          entry.available.includes(month),
          `${region.id}/${ingredientId}: month ${month} is peak but not available`,
        );
      }
    }
  }
});

test('no duplicate months within a list', () => {
  for (const region of REGIONS) {
    for (const [ingredientId, entry] of Object.entries(region.seasons)) {
      assert.equal(new Set(entry.peak).size, entry.peak.length, `${region.id}/${ingredientId} peak`);
    }
  }
});

test('Las Vegas inverts the Canadian pattern for greens', () => {
  // The whole point of a separate desert table. Winter lettuce is the norm in the
  // Southwest and unavailable in BC; if these ever agree, one of them is wrong.
  const lettuce = loadSeedData().ingredients.find((i) => i.id === 'lettuce');
  if (!lettuce) assert.fail('seed library lost its lettuce');

  assert.equal(seasonStatus(lettuce, 1, getRegion('las-vegas')), 'peak', 'January in Vegas');
  assert.equal(seasonStatus(lettuce, 1, getRegion('bc-canada')), 'out-of-season', 'January in BC');
  assert.equal(seasonStatus(lettuce, 7, getRegion('bc-canada')), 'peak', 'July in BC');
});

test('Las Vegas has a high-summer gap for warm crops', () => {
  // Desert tomatoes stop setting fruit in the July/August heat, so August is a
  // trough between two harvests rather than the peak it is further north.
  const tomato = loadSeedData().ingredients.find((i) => i.id === 'tomato');
  if (!tomato) assert.fail('seed library lost its tomato');

  const vegas = getRegion('las-vegas');
  assert.equal(seasonStatus(tomato, 6, vegas), 'peak', 'June wave');
  assert.equal(seasonStatus(tomato, 8, vegas), 'available', 'August gap');
  assert.equal(seasonStatus(tomato, 9, vegas), 'peak', 'September wave');
});

group('Export round-trip');

test('export then re-import is lossless', () => {
  const seed = loadSeedData();
  const bundle = toBundle(seed.ingredients, seed.recipes);
  const round = importBundle(bundle, []);

  assert.equal(round.rejected.length, 0, JSON.stringify(round.rejected));
  assert.equal(round.ingredients.length, seed.ingredients.length);
  assert.equal(round.recipes.length, seed.recipes.length);

  // Quantities are the thing that matters: a round trip that loses grams would
  // silently corrupt every grocery list built from the re-imported library, and
  // the export doubles as the only backup that exists.
  for (const original of seed.recipes) {
    const copy = round.recipes.find((r) => r.id === original.id);
    if (!copy) assert.fail(`${original.id} did not survive the round trip`);

    assert.equal(copy.ingredients.length, original.ingredients.length, `${original.id} line count`);
    for (let i = 0; i < original.ingredients.length; i++) {
      assert.ok(
        Math.abs(copy.ingredients[i].grams - original.ingredients[i].grams) < 0.01,
        `${original.id} line ${i}: ${copy.ingredients[i].grams} vs ${original.ingredients[i].grams} g`,
      );
    }
    assert.deepEqual([...copy.diets].sort(), [...original.diets].sort(), `${original.id} diets`);
  }

  // Allergen data was dropped silently by the importer once, because the
  // round trip only checked grams and diets. Anything safety-relevant that
  // survives the wire format has to be asserted here explicitly.
  for (const original of seed.ingredients) {
    const copy = round.ingredients.find((i) => i.id === original.id);
    if (!copy) assert.fail(`${original.id} did not survive the round trip`);
    assert.deepEqual(
      [...(copy.allergens ?? [])].sort(), [...(original.allergens ?? [])].sort(),
      `${original.id} allergens`,
    );
    assert.equal(copy.allergensVerified, original.allergensVerified,
      `${original.id} allergensVerified`);
  }
});


group('Produce: fruit or vegetable');

/** Builds a bare ingredient. Only the fields the classifier reads are real. */
function fakeIngredient(name: string, aliases: string[] = []): Ingredient {
  return {
    id: name.toLowerCase().replace(/[^a-z]+/g, '-'),
    name,
    aliases,
    category: 'produce',
    purchase: { unit: 'each', gramsPerPack: 100, divisible: true, costPerKg: 4 },
    shelfLifeDays: 7,
  };
}

function kindOf(name: string, aliases: string[] = []): string {
  return produceKind(fakeIngredient(name, aliases));
}

test('the seed library splits the way a shopper would', () => {
  const seed = loadSeedData();
  const byId = new Map(seed.ingredients.map((i) => [i.id, i]));
  const kind = (id: Id): string => {
    const ing = byId.get(id);
    if (!ing) assert.fail(`seed library has no ${id}`);
    return produceKind(ing);
  };

  assert.equal(kind('apple'), 'fruit');
  assert.equal(kind('blueberry'), 'fruit');
  assert.equal(kind('lemon'), 'fruit');

  // Botanically fruit, every one of them. A fruit bag full of these would be a
  // bug report, not a clever classification.
  for (const id of ['tomato', 'cucumber', 'zucchini', 'bell-pepper', 'butternut-squash']) {
    assert.equal(kind(id), 'vegetable', id);
  }
  for (const id of ['potato', 'kale', 'garlic', 'mushroom', 'parsley']) {
    assert.equal(kind(id), 'vegetable', id);
  }
});

test('plurals and compounds land on the right side', () => {
  assert.equal(kindOf('Strawberries'), 'fruit');
  assert.equal(kindOf('Cherries'), 'fruit');
  assert.equal(kindOf('Peaches'), 'fruit');
  assert.equal(kindOf('Watermelon'), 'fruit');
  assert.equal(kindOf('Dragonfruit'), 'fruit');
  assert.equal(kindOf('Granny Smith apples'), 'fruit');

  // "apple" inside "pineapple" must not be what decides it — matching on
  // substrings rather than words is how "crab apple" logic goes wrong.
  assert.equal(kindOf('Pineapple'), 'fruit');
  assert.equal(kindOf('Eggplant'), 'vegetable');

  // The fruit word describes the size, not the thing. A vegetable word in the
  // name wins over a fruit one wherever both appear.
  assert.equal(kindOf('Cherry tomatoes', ['grape tomatoes']), 'vegetable');
  assert.equal(kindOf('Snap peas'), 'vegetable');
  assert.equal(kindOf('Cilantro'), 'vegetable');
});

test('an alias is enough — imports rarely use the tidy name', () => {
  assert.equal(kindOf('Mandarins', ['clementine']), 'fruit');
  assert.equal(kindOf('Courgette', ['zucchini']), 'vegetable');
});

group('Grab bag draw');

function planningContext(): PlanningContext {
  const seed = loadSeedData();
  const settings: PlannerSettings = {
    unitSystem: 'metric',
    regionId: 'bc-canada',
    diets: [],
    allergens: [],
    excludedIngredients: [],
    weeklyTimeBudgetMinutes: 240,
    repeatWindowWeeks: 3,
    wildcardCount: 4,
    wildcardSplit: false,
    wildcardFruitCount: 2,
    wildcardVegCount: 2,
  };
  return {
    ingredients: new Map<Id, Ingredient>(seed.ingredients.map((i) => [i.id, i])),
    recipes: new Map<Id, Recipe>(seed.recipes.map((r) => [r.id, r])),
    staples: [],
    pantry: new Map(),
    sales: new Map(),
    settings,
    recentlyUsed: new Map(),
    month: 8,
    region: getRegion('bc-canada'),
  };
}

const SIZES: WildcardSizes = { split: false, count: 5, fruitCount: 2, vegCount: 3 };

function kindsOf(ctx: PlanningContext, items: readonly WildcardItem[]): string[] {
  return items.map((w) => {
    const ing = ctx.ingredients.get(w.ingredientId);
    if (!ing) assert.fail(`drew ${w.ingredientId}, which is not in the library`);
    return produceKind(ing);
  });
}

test('an unsplit bag comes back at the asked-for size, with no repeats', () => {
  const ctx = planningContext();
  const bag = fitWildcards(ctx, SIZES, 1234);

  assert.equal(bag.length, 5);
  assert.equal(new Set(bag.map((w) => w.ingredientId)).size, 5, 'drew the same thing twice');
});

test('a split bag hits both targets, not just the total', () => {
  const ctx = planningContext();
  // The reason the toggle exists: one weighted pool can legitimately return five
  // vegetables, and "some fruit this week" has to be guaranteed, not hoped for.
  const bag = fitWildcards(ctx, { ...SIZES, split: true }, 99);
  const kinds = kindsOf(ctx, bag);

  assert.equal(kinds.filter((k) => k === 'fruit').length, 2, 'fruit');
  assert.equal(kinds.filter((k) => k === 'vegetable').length, 3, 'vegetables');
});

test('a bag bigger than the library is capped, not padded', () => {
  const ctx = planningContext();
  const fruitAvailable = [...ctx.ingredients.values()].filter(
    (i) => i.category === 'produce' && produceKind(i) === 'fruit',
  ).length;

  const bag = fitWildcards(ctx, { split: true, count: 0, fruitCount: 50, vegCount: 0 }, 7);

  assert.equal(bag.length, fruitAvailable, 'asked for fifty, library has fewer');
  assert.ok(kindsOf(ctx, bag).every((k) => k === 'fruit'), 'padded the fruit bag with vegetables');
});

test('topping up keeps what is already in the bag and adds no duplicates', () => {
  const ctx = planningContext();
  const start = fitWildcards(ctx, { ...SIZES, count: 2 }, 4242);
  const grown = fitWildcards(ctx, { ...SIZES, count: 5 }, 555, start);

  assert.equal(grown.length, 5);
  assert.equal(new Set(grown.map((w) => w.ingredientId)).size, 5);
  for (const w of start) {
    assert.ok(grown.some((g) => g.ingredientId === w.ingredientId), `${w.ingredientId} was dropped`);
  }
});

test('shrinking drops un-promoted items first', () => {
  const ctx = planningContext();
  const start = fitWildcards(ctx, { ...SIZES, count: 4 }, 8080);
  // Promote the last one, which is exactly the one a naive trim would discard.
  const promoted = start.map((w, i) => (i === start.length - 1 ? { ...w, promoted: true } : w));

  const shrunk = fitWildcards(ctx, { ...SIZES, count: 2 }, 8081, promoted);

  assert.equal(shrunk.length, 2);
  assert.ok(
    shrunk.some((w) => w.ingredientId === promoted[promoted.length - 1].ingredientId),
    'threw away the item the plan was built around',
  );
});

test('excluded produce never turns up in the bag', () => {
  const base = planningContext();
  // Derived rather than listed: the assertion is about every fruit being
  // excluded, and a hardcoded list quietly stops meaning that as the library grows.
  const everyFruit = [...base.ingredients.values()]
    .filter((i) => i.category === 'produce' && produceKind(i) === 'fruit')
    .map((i) => i.id);
  const ctx: PlanningContext = {
    ...base,
    settings: { ...base.settings, excludedIngredients: everyFruit },
  };

  // Every fruit in the library is excluded, so the fruit bag must come back empty
  // rather than quietly reaching for something the user said no to.
  const bag = fitWildcards(ctx, { split: true, count: 0, fruitCount: 3, vegCount: 2 }, 31337);
  assert.ok(kindsOf(ctx, bag).every((k) => k === 'vegetable'));
  assert.equal(bag.length, 2);
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
