/**
 * Allergen detection tests.
 *
 * Two failure modes, and they are not symmetric.
 *
 * A MISS is the dangerous one: an ingredient that should have been caught and was
 * not. Those tests are the point of this file.
 *
 * A FALSE POSITIVE is not merely cosmetic either. Butternut squash flagged as
 * dairy trains someone to dismiss the warnings, and then the real one gets
 * dismissed too. Six of ten probes misfired before the veto lists existed, which
 * is why they are pinned here.
 *
 * Run with: npm run test:allergens
 */

import assert from 'node:assert/strict';

import {
  ALLERGEN_GROUPS, checkRecipe, describeMatches, excludedByAllergens, ingredientAllergens,
} from '../src/domain/allergens';
import { loadSeedData } from '../src/data/seed';
import type { Id, Ingredient, Recipe } from '../src/domain/types';

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

function ing(name: string, extra: Partial<Ingredient> = {}): Ingredient {
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    aliases: [],
    category: 'other',
    purchase: { unit: 'pack', gramsPerPack: 100, divisible: false, costPerKg: 1 },
    shelfLifeDays: 10,
    ...extra,
  } as Ingredient;
}

function hits(name: string, extra: Partial<Ingredient> = {}): string[] {
  return [...ingredientAllergens(ing(name, extra)).keys()].sort();
}

// ---------------------------------------------------------------------------

group('Catching allergens by name — the misses that matter');

test('obvious cases', () => {
  assert.deepEqual(hits('Whole milk'), ['milk']);
  assert.deepEqual(hits('Cheddar cheese'), ['milk']);
  assert.deepEqual(hits('Free range eggs'), ['eggs']);
  assert.deepEqual(hits('Peanut butter'), ['peanuts']);
  assert.deepEqual(hits('Tahini'), ['sesame']);
});

test('non-obvious cases are the reason this exists', () => {
  // Nobody scanning a recipe for "fish" spots Worcestershire sauce.
  assert.ok(hits('Worcestershire sauce').includes('fish'));
  assert.ok(hits('Caesar dressing').includes('fish') === false, 'not inferrable by name');
  assert.ok(hits('Soy sauce').includes('wheat'), 'soy sauce contains wheat');
  assert.ok(hits('Marzipan').includes('tree-nuts'));
  assert.ok(hits('Surimi').includes('fish'));
});

test('an unknown imported ingredient is still caught', () => {
  // The whole point of inference: no data, but the name gives it away.
  assert.deepEqual(hits('Cashew butter'), ['tree-nuts']);
  assert.deepEqual(hits('Almond flour'), ['tree-nuts', 'wheat'].sort());
  assert.ok(hits('Pistachio paste').includes('tree-nuts'));
});

test('plurals and compounds', () => {
  assert.ok(hits('Mixed nuts').includes('tree-nuts'));
  assert.ok(hits('King prawns').includes('shellfish'));
  assert.ok(hits('Anchovies').includes('fish'));
});

group('False positives — warnings must stay trustworthy');

test('coconut is not dairy and not a tree nut', () => {
  assert.deepEqual(hits('Coconut milk'), []);
  assert.deepEqual(hits('Coconut cream'), []);
});

test('butternut squash is not dairy', () => {
  // The original matcher flagged this. A warning that is obviously absurd is how
  // people learn to ignore warnings.
  assert.deepEqual(hits('Butternut squash'), []);
});

test('plant milks are not dairy', () => {
  assert.deepEqual(hits('Oat milk'), []);
  assert.deepEqual(hits('Soy milk'), ['soy']);
  assert.deepEqual(hits('Almond milk'), ['tree-nuts'], 'nuts yes, dairy no');
});

test('nut butters are not dairy', () => {
  assert.deepEqual(hits('Peanut butter'), ['peanuts']);
  assert.deepEqual(hits('Cashew butter'), ['tree-nuts']);
});

test('nutmeg and water chestnuts are not tree nuts', () => {
  assert.deepEqual(hits('Nutmeg'), []);
  assert.deepEqual(hits('Water chestnuts'), []);
});

test('but real dairy still matches', () => {
  assert.deepEqual(hits('Buttermilk'), ['milk']);
  assert.deepEqual(hits('Salted butter'), ['milk']);
  assert.deepEqual(hits('Double cream'), ['milk']);
});

group('Declared data and verification');

test('a declared allergen is reported as declared, not inferred', () => {
  const map = ingredientAllergens(ing('Mystery Paste', { allergens: ['sesame'] }));
  assert.equal(map.get('sesame'), 'declared');
});

test('inference still runs alongside undeclared groups', () => {
  // Declaring one allergen must not imply the absence of others.
  const map = ingredientAllergens(ing('Almond butter', { allergens: ['sesame'] }));
  assert.equal(map.get('sesame'), 'declared');
  assert.equal(map.get('tree-nuts'), 'inferred');
});

test('verified data turns inference off', () => {
  const map = ingredientAllergens(
    ing('Coconut milk', { allergens: [], allergensVerified: true }),
  );
  assert.equal(map.size, 0);
});

test('verified never hides a declared allergen', () => {
  const map = ingredientAllergens(
    ing('Cream substitute', { allergens: ['soy'], allergensVerified: true }),
  );
  assert.deepEqual([...map.keys()], ['soy']);
});

group('Recipe checking');

const ingredients = new Map<Id, Ingredient>([
  ['milk', ing('Milk', { allergens: ['milk'], allergensVerified: true })],
  ['flour', ing('Plain flour', { allergens: ['wheat'], allergensVerified: true })],
  ['carrot', ing('Carrots', { allergens: [], allergensVerified: true })],
]);

function recipe(ids: string[], optionalIds: string[] = []): Recipe {
  return {
    id: 'r', name: 'R', mealType: 'full', baseServings: 2,
    ingredients: [...ids, ...optionalIds].map((id) => ({
      ingredientId: id, quantity: 1, unit: 'g', grams: 1,
      optional: optionalIds.includes(id), scaling: 'linear' as const,
    })),
    steps: [], prepMinutes: 0, cookMinutes: 0, tags: [], diets: [], builtIn: true,
  };
}

test('finds a matching allergen', () => {
  const report = checkRecipe(recipe(['milk', 'carrot']), ingredients, ['milk']);
  assert.ok(report.hasMatch);
  assert.equal(report.matches[0].ingredientName, 'Milk');
});

test('clean recipe is clean', () => {
  assert.equal(checkRecipe(recipe(['carrot']), ingredients, ['milk']).hasMatch, false);
});

test('optional ingredients still count', () => {
  // They can still end up in the dish. A warning about something you meant to
  // leave out is a small annoyance next to the alternative.
  const report = checkRecipe(recipe(['carrot'], ['milk']), ingredients, ['milk']);
  assert.ok(report.hasMatch, 'optional milk must still warn');
});

test('unknown ingredients are reported, never assumed safe', () => {
  const report = checkRecipe(recipe(['carrot', 'mystery-sauce']), ingredients, ['milk']);
  assert.equal(report.hasMatch, false);
  assert.deepEqual(report.unverifiable, ['mystery-sauce']);
});

test('no active allergens means no work and no matches', () => {
  const report = checkRecipe(recipe(['milk']), ingredients, []);
  assert.equal(report.hasMatch, false);
  assert.equal(report.unverifiable.length, 0);
});

test('summary groups ingredients under their allergen', () => {
  const report = checkRecipe(recipe(['milk', 'flour']), ingredients, ['milk', 'wheat']);
  const text = describeMatches(report.matches);
  assert.ok(text.includes('Milk (Milk)'), text);
  assert.ok(text.includes('Wheat & gluten (Plain flour)'), text);
});

group('Exclusion expansion');

test('expands a group to concrete ingredient ids', () => {
  const excluded = excludedByAllergens(ingredients.values(), ['milk']);
  assert.deepEqual(excluded, ['milk']);
});

test('empty allergens excludes nothing', () => {
  assert.deepEqual(excludedByAllergens(ingredients.values(), []), []);
});

group('Against the real seed library');

const seed = loadSeedData();
const seedMap = new Map(seed.ingredients.map((i) => [i.id, i]));

test('library declares the allergens it should', () => {
  const expect: Record<string, string> = {
    'salmon-fillet': 'fish', egg: 'eggs', 'greek-yogurt': 'milk',
    feta: 'milk', parmesan: 'milk', milk: 'milk',
    'peanut-butter': 'peanuts', tahini: 'sesame', pasta: 'wheat',
    bread: 'wheat', tortilla: 'wheat',
  };
  for (const [id, allergen] of Object.entries(expect)) {
    const found = ingredientAllergens(seedMap.get(id)!);
    assert.ok(found.has(allergen), `${id} should carry ${allergen}`);
  }
});

test('no library ingredient is falsely flagged', () => {
  const shouldBeClean = [
    'butternut-squash', 'coconut-milk', 'chicken-thigh', 'potato', 'carrot',
    'yellow-onion', 'olive-oil', 'chickpeas', 'kale', 'apple', 'long-grain-rice',
  ];
  for (const id of shouldBeClean) {
    const found = [...ingredientAllergens(seedMap.get(id)!).keys()];
    assert.deepEqual(found, [], `${id} was flagged as ${found.join(', ')}`);
  }
});

test('a dairy allergy rules out the expected recipes', () => {
  const blocked = seed.recipes.filter(
    (r) => checkRecipe(r, seedMap, ['milk']).hasMatch,
  ).map((r) => r.id);

  assert.ok(blocked.includes('greek-salad-bowl'), 'feta');
  assert.ok(blocked.includes('mushroom-kale-risotto'), 'parmesan');
  assert.ok(blocked.includes('yogurt-blueberry-oats'), 'yogurt');
  assert.ok(!blocked.includes('paprika-roasted-chickpeas'), 'chickpeas are dairy-free');
});

test('every recipe in the library is checkable', () => {
  // An unresolvable ingredient anywhere in the built-in library would mean the
  // allergen check silently cannot vouch for that recipe.
  for (const recipe of seed.recipes) {
    const report = checkRecipe(recipe, seedMap, ['milk', 'wheat', 'fish']);
    assert.equal(report.unverifiable.length, 0, `${recipe.id}: ${report.unverifiable.join(', ')}`);
  }
});

group('Group definitions');

test('every group has an id, label, scope text and keywords', () => {
  for (const g of ALLERGEN_GROUPS) {
    assert.ok(g.id && g.label && g.covers, `${g.id} is incomplete`);
    assert.ok(g.keywords.length > 0, `${g.id} has no keywords`);
  }
});

test('group ids are unique', () => {
  const ids = ALLERGEN_GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
