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
      ingredients: [
        { raw: '1 cauliflower' },
        { raw: '2 tbsp harissa paste' },
        { raw: '1 cauliflower' },
      ],
    }],
  }, seed.ingredients);

  const stubs = stubsFromResult(result);
  assert.equal(stubs[0].id, 'cauliflower', 'most-wanted first');
  assert.equal(stubs[0]._usedBy, 2);
  assert.ok(stubs[0].TODO.includes('purchase.divisible'));
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
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
