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
import {
  type BagLane, type GrabBagId, GRAB_BAGS, bagOf, grabBagLanes, isCheese, isPasta,
} from '../src/domain/grabbag';
import {
  MAX_TREAT_CENTS, TREATS, TREAT_KINDS, eligibleTreats, fitTreats, getTreat, pickTreats,
  treatTarget, type TreatEligibility, type TreatItem, type TreatKind,
} from '../src/domain/treats';
import {
  DISPLAY_SECTIONS, DRAWN_SECTIONS, WEEK_SECTIONS,
} from '../src/domain/weekSections';
import {
  dropSlot, fitWildcards, generateWeekPlan, placeRecipe, regenerateMeals, reinstateSlot,
  rerollSlot,
} from '../src/domain/planner/generate';
import { aggregateNeeds, DEFAULT_WEIGHTS, type PlanningContext } from '../src/domain/planner/scoring';
import {
  buildVariantIndex, chooseBestVariants, collapseToFamilies, familyIdOf,
} from '../src/domain/variants';
import { applyFilter } from '../src/domain/filters';
import { buildGroceryList, withoutRemoved } from '../src/domain/grocery';
import {
  CUISINE_REGIONS, cuisineLabel, cuisineOf, dishTypesOf, primaryDishType, regionOf,
} from '../src/domain/taxonomy';
import {
  type CompiledRule, type WeekRule, compileRules, countMatching, describeRule,
  evaluateRules, impossibleReason, isConfigured, newRule, rulePenalty, shortfallOf,
  withSubject,
} from '../src/domain/weekRules';
import {
  DEFAULT_NECESSITY, afterStockChange, autoRestock, describeItem, isOnList, isOverridden,
  necessityOf, reviewOrder, worthKeeping,
} from '../src/domain/pantry';
import { carryOverOf } from '../src/domain/waste';
import type {
  GroceryList, Id, Ingredient, MealType, PantryItem, PantryNecessity, PantryStock, PlanSlot,
  PlannerSettings, Recipe, SlotSpec, WeekPlan, WildcardItem,
} from '../src/domain/types';

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

group('Grab bag shelves');

const LIBRARY: readonly Ingredient[] = loadSeedData().ingredients;

function named(name: string): Ingredient {
  const ing = LIBRARY.find((i) => i.name === name);
  if (!ing) assert.fail(`the library has no "${name}" — this test's fixtures have moved`);
  return ing;
}

test('nothing is on two shelves at once', () => {
  // The draw counts each lane's target separately and holds on to what it has
  // already drawn, so an ingredient claimed by two bags would be drawn once and
  // counted twice — a bag that comes back one short for no visible reason. Cheap
  // to assert over the whole library, and impossible to spot by eye.
  for (const ing of LIBRARY) {
    const claimed = GRAB_BAGS.filter((bag) => bag.holds(ing)).map((b) => b.id);
    assert.ok(claimed.length <= 1, `${ing.name} is in ${claimed.join(' and ')}`);
  }
});

test('pasta is told apart from the rest of the grain shelf', () => {
  for (const name of ['Spaghetti', 'Penne', 'Orzo', 'Lasagne sheets', 'Soba noodles',
                      'Potato gnocchi', 'Glass noodles']) {
    assert.ok(isPasta(named(name)), name);
  }
  // The rest of the aisle it shares. Rice is not pasta however close it is shelved.
  for (const name of ['Long grain rice', 'Rolled oats', 'Polenta', 'Crackers',
                      'Pearl barley', 'Rice paper wrappers']) {
    assert.ok(!isPasta(named(name)), name);
  }
});

test('couscous is pasta, and the singulariser nearly hid it', () => {
  // `singular` turns "couscous" into "couscou", so a word list written in plain
  // English and compared raw silently never matched it. Both sides go through the
  // same mill now, and this is the regression guard for that.
  assert.ok(isPasta(named('Couscous')));
});

test('cheese is told apart from the rest of the dairy shelf', () => {
  for (const name of ['Brie', 'Cream cheese', 'Paneer', 'Gruyère', 'Burrata',
                      'Pecorino romano', 'Comté']) {
    assert.ok(isCheese(named(name)), name);
  }
  // Everything else in the fridge door. "Sour cream" and "Cream cheese" are one
  // word apart, and only one of them is a cheese.
  for (const name of ['Milk', 'Butter', 'Cream', 'Sour cream', 'Greek yogurt', 'Eggs']) {
    assert.ok(!isCheese(named(name)), name);
  }
});

test('the bread bag is the whole bakery shelf', () => {
  const bakery = LIBRARY.filter((i) => i.category === 'bakery');
  assert.ok(bakery.length >= 25, 'the point of the bread bag is that there are lots of breads');
  assert.ok(bakery.every((i) => bagOf(i) === 'bread'));
});

test('every name in the library belongs to exactly one ingredient', () => {
  // Import resolves a written line by name or alias, last one indexed winning. A
  // collision therefore does not fail — it silently re-points every recipe using
  // that word at a different ingredient. Adding seventy ingredients in one go is
  // exactly when that happens, and nothing else would catch it.
  const key = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');
  const owner = new Map<string, string>();
  for (const ing of LIBRARY) {
    for (const text of [ing.id, ing.name, ...ing.aliases]) {
      const existing = owner.get(key(text));
      assert.ok(
        existing === undefined || existing === ing.id,
        `"${text}" is claimed by both ${existing} and ${ing.id}`,
      );
      owner.set(key(text), ing.id);
    }
  }
});

// ---------------------------------------------------------------------------

group('Grab bag draw');

function testSettings(overrides: Partial<PlannerSettings> = {}): PlannerSettings {
  return {
    unitSystem: 'metric',
    regionId: 'bc-canada',
    diets: [],
    allergens: [],
    excludedIngredients: [],
    weekRules: [],
    weeklyTimeBudgetMinutes: 240,
    repeatWindowWeeks: 3,
    produceBagEnabled: true,
    wildcardCount: 4,
    wildcardSplit: false,
    wildcardFruitCount: 2,
    wildcardVegCount: 2,
    // The dry shelves ship switched on, but they start off here so that a test
    // about the produce bag is about the produce bag. They are switched on
    // deliberately, below.
    breadBagEnabled: false,
    breadBagCount: 2,
    pastaBagEnabled: false,
    pastaBagCount: 1,
    cheeseBagEnabled: false,
    cheeseBagCount: 1,
    treatBagEnabled: true,
    treatCount: 3,
    ...overrides,
  };
}

function planningContext(overrides: Partial<PlannerSettings> = {}): PlanningContext {
  const seed = loadSeedData();
  return {
    ingredients: new Map<Id, Ingredient>(seed.ingredients.map((i) => [i.id, i])),
    recipes: new Map<Id, Recipe>(seed.recipes.map((r) => [r.id, r])),
    staples: [],
    pantry: new Map(),
    sales: new Map(),
    settings: testSettings(overrides),
    recentlyUsed: new Map(),
    month: 8,
    region: getRegion('bc-canada'),
  };
}

/** The lanes those settings produce — the same call the app makes. */
function lanes(overrides: Partial<PlannerSettings> = {}): BagLane[] {
  return grabBagLanes(testSettings(overrides));
}

const PRODUCE_5 = lanes({ wildcardCount: 5, wildcardFruitCount: 2, wildcardVegCount: 3 });

function kindsOf(ctx: PlanningContext, items: readonly WildcardItem[]): string[] {
  return items.map((w) => {
    const ing = ctx.ingredients.get(w.ingredientId);
    if (!ing) assert.fail(`drew ${w.ingredientId}, which is not in the library`);
    return produceKind(ing);
  });
}

function bagsOf(ctx: PlanningContext, items: readonly WildcardItem[]): (GrabBagId | null)[] {
  return items.map((w) => {
    const ing = ctx.ingredients.get(w.ingredientId);
    if (!ing) assert.fail(`drew ${w.ingredientId}, which is not in the library`);
    return bagOf(ing);
  });
}

test('an unsplit bag comes back at the asked-for size, with no repeats', () => {
  const ctx = planningContext();
  const bag = fitWildcards(ctx, PRODUCE_5, 1234);

  assert.equal(bag.length, 5);
  assert.equal(new Set(bag.map((w) => w.ingredientId)).size, 5, 'drew the same thing twice');
});

test('a split bag hits both targets, not just the total', () => {
  const ctx = planningContext();
  // The reason the toggle exists: one weighted pool can legitimately return five
  // vegetables, and "some fruit this week" has to be guaranteed, not hoped for.
  const bag = fitWildcards(
    ctx,
    lanes({ wildcardSplit: true, wildcardFruitCount: 2, wildcardVegCount: 3 }),
    99,
  );
  const kinds = kindsOf(ctx, bag);

  assert.equal(kinds.filter((k) => k === 'fruit').length, 2, 'fruit');
  assert.equal(kinds.filter((k) => k === 'vegetable').length, 3, 'vegetables');
});

test('a bag bigger than the library is capped, not padded', () => {
  const ctx = planningContext();
  const fruitAvailable = [...ctx.ingredients.values()].filter(
    (i) => i.category === 'produce' && produceKind(i) === 'fruit',
  ).length;

  const bag = fitWildcards(
    ctx,
    lanes({ wildcardSplit: true, wildcardFruitCount: 50, wildcardVegCount: 0 }),
    7,
  );

  assert.equal(bag.length, fruitAvailable, 'asked for fifty, library has fewer');
  assert.ok(kindsOf(ctx, bag).every((k) => k === 'fruit'), 'padded the fruit bag with vegetables');
});

test('topping up keeps what is already in the bag and adds no duplicates', () => {
  const ctx = planningContext();
  const start = fitWildcards(ctx, lanes({ wildcardCount: 2 }), 4242);
  const grown = fitWildcards(ctx, PRODUCE_5, 555, start);

  assert.equal(grown.length, 5);
  assert.equal(new Set(grown.map((w) => w.ingredientId)).size, 5);
  for (const w of start) {
    assert.ok(grown.some((g) => g.ingredientId === w.ingredientId), `${w.ingredientId} was dropped`);
  }
});

test('shrinking drops un-promoted items first', () => {
  const ctx = planningContext();
  const start = fitWildcards(ctx, lanes({ wildcardCount: 4 }), 8080);
  // Promote the last one, which is exactly the one a naive trim would discard.
  const promoted = start.map((w, i) => (i === start.length - 1 ? { ...w, promoted: true } : w));

  const shrunk = fitWildcards(ctx, lanes({ wildcardCount: 2 }), 8081, promoted);

  assert.equal(shrunk.length, 2);
  assert.ok(
    shrunk.some((w) => w.ingredientId === promoted[promoted.length - 1].ingredientId),
    'threw away the item the plan was built around',
  );
});

test('excluded produce never turns up in the bag', () => {
  // Derived rather than listed: the assertion is about every fruit being
  // excluded, and a hardcoded list quietly stops meaning that as the library grows.
  const everyFruit = LIBRARY
    .filter((i) => i.category === 'produce' && produceKind(i) === 'fruit')
    .map((i) => i.id);
  const ctx = planningContext({ excludedIngredients: everyFruit });

  // Every fruit in the library is excluded, so the fruit bag must come back empty
  // rather than quietly reaching for something the user said no to.
  const bag = fitWildcards(
    ctx,
    lanes({ wildcardSplit: true, wildcardFruitCount: 3, wildcardVegCount: 2 }),
    31337,
  );
  assert.ok(kindsOf(ctx, bag).every((k) => k === 'vegetable'));
  assert.equal(bag.length, 2);
});

test('each bag draws from its own shelf and hits its own size', () => {
  const all = {
    wildcardCount: 5,
    breadBagEnabled: true, breadBagCount: 3,
    pastaBagEnabled: true, pastaBagCount: 2,
    cheeseBagEnabled: true, cheeseBagCount: 4,
  };
  const ctx = planningContext(all);
  const bag = fitWildcards(ctx, lanes(all), 4711);

  const drawn = bagsOf(ctx, bag);
  assert.equal(drawn.filter((b) => b === 'produce').length, 5, 'produce');
  assert.equal(drawn.filter((b) => b === 'bread').length, 3, 'bread');
  assert.equal(drawn.filter((b) => b === 'pasta').length, 2, 'pasta');
  assert.equal(drawn.filter((b) => b === 'cheese').length, 4, 'cheese');
  assert.equal(new Set(bag.map((w) => w.ingredientId)).size, bag.length, 'drew the same thing twice');
});

test('a bag switched off is emptied, and the others are left alone', () => {
  // The switch is not the same thing as a size of zero: the size is kept, so
  // turning the bag back on restores the bag the user had.
  const on = { breadBagEnabled: true, cheeseBagEnabled: true, cheeseBagCount: 2 };
  const ctx = planningContext(on);
  const full = fitWildcards(ctx, lanes(on), 606);
  assert.ok(bagsOf(ctx, full).includes('cheese'), 'nothing to switch off');

  const trimmed = fitWildcards(ctx, lanes({ ...on, cheeseBagEnabled: false }), 607, full);
  const drawn = bagsOf(ctx, trimmed);

  assert.ok(!drawn.includes('cheese'), 'the cheese bag was switched off and is still there');
  assert.equal(
    drawn.filter((b) => b === 'bread').length,
    bagsOf(ctx, full).filter((b) => b === 'bread').length,
    'switching off the cheese bag disturbed the bread bag',
  );
});

test('a promoted item in a bag that is switched off goes with it', () => {
  // Promotion says "build the week around this", not "keep this whatever
  // happens". The switch is the stronger statement, and a promoted cheese
  // surviving in a bag the user has turned off would be a ghost that nothing on
  // screen explains.
  const on = { cheeseBagEnabled: true, cheeseBagCount: 2 };
  const ctx = planningContext(on);
  const full = fitWildcards(ctx, lanes(on), 909).map((w) => ({ ...w, promoted: true }));

  const trimmed = fitWildcards(ctx, lanes({ ...on, cheeseBagEnabled: false }), 910, full);
  assert.ok(!bagsOf(ctx, trimmed).includes('cheese'));
});

test('diets rule an ingredient out of the draw, not just out of the recipes', () => {
  // Every vegetable passes every diet, so the produce bag never exercised this.
  // A cheese bag fails it on the first draw, by offering a vegan some manchego.
  const on = { produceBagEnabled: false, cheeseBagEnabled: true, cheeseBagCount: 20 };
  const vegan = planningContext({ ...on, diets: ['vegan'] });

  const bag = fitWildcards(vegan, lanes(on), 31415);

  assert.ok(bag.length > 0, 'there is at least one cheese a vegan can have');
  for (const w of bag) {
    const ing = vegan.ingredients.get(w.ingredientId)!;
    assert.ok(!(ing.excludesDiets ?? []).includes('vegan'), `offered a vegan ${ing.name}`);
  }
});

test('an ingredient that has left the library is dropped rather than kept', () => {
  // A plan synced from a build whose library had something this one does not.
  // Rendering it as a blank row would look like a bug.
  const ctx = planningContext();
  const stale: WildcardItem[] = [
    { ingredientId: 'dragonfruit-of-the-ancients', grams: 100, promoted: true },
  ];

  const bag = fitWildcards(ctx, PRODUCE_5, 8, stale);

  assert.equal(bag.length, 5);
  assert.ok(bag.every((w) => ctx.ingredients.get(w.ingredientId) !== undefined));
});

// ---------------------------------------------------------------------------

group('The pantry');

function pantryItem(
  ingredientId: Id,
  status: PantryStock,
  necessity?: PantryNecessity,
): PantryItem {
  return { ingredientId, status, necessity, usesSincePurchase: 0 };
}

test('necessity decides how empty a thing has to get before it is bought', () => {
  // The whole reason for the second dial: same stock, three different answers.
  assert.equal(autoRestock(pantryItem('x', 'low', 'must-have')), true);
  assert.equal(autoRestock(pantryItem('x', 'low', 'nice-to-have')), false);
  assert.equal(autoRestock(pantryItem('x', 'out', 'nice-to-have')), true);
  assert.equal(autoRestock(pantryItem('x', 'out', 'alright-without')), false);
  assert.equal(autoRestock(pantryItem('x', 'stocked', 'must-have')), false);
});

test('a new pantry item is quiet, an old one keeps the behaviour it had', () => {
  // Two different questions that look like one. A new item defaults to the quiet
  // end; a row written before the field existed was restocked whenever it ran
  // low, and reading it as anything else drops things off people's lists.
  assert.equal(DEFAULT_NECESSITY, 'alright-without');
  assert.equal(necessityOf({ ingredientId: 'x', status: 'low', usesSincePurchase: 0 }), 'must-have');
  assert.equal(autoRestock({ ingredientId: 'x', status: 'low', usesSincePurchase: 0 }), true);
});

test('adding something by hand beats the rule, in both directions', () => {
  const quiet = { ...pantryItem('x', 'out', 'alright-without'), restock: true };
  const loud = { ...pantryItem('x', 'out', 'must-have'), restock: false };

  assert.equal(isOnList(quiet), true, 'asked for it and did not get it');
  assert.equal(isOnList(loud), false, 'said not this week and got it anyway');
  assert.ok(isOverridden(quiet) && isOverridden(loud));
});

test('an override that agrees with the rule is not called an override', () => {
  // It is stored either way, because a button that writes nothing looks broken.
  // But it has not overridden anything, and the row should not claim it has.
  const agreeing = { ...pantryItem('x', 'out', 'must-have'), restock: true };
  assert.equal(isOnList(agreeing), true);
  assert.equal(isOverridden(agreeing), false);
});

test('a one-line row can still say why it is on the list', () => {
  // Everything a three-line card showed, for the row that has one line: the tick
  // and the stock buttons are the whole row, so this phrase is the only place
  // left to answer "why is that on here".
  assert.equal(
    describeItem(pantryItem('x', 'low', 'must-have')),
    'Must-have, low — on the list',
  );
  assert.equal(
    describeItem(pantryItem('x', 'out', 'alright-without')),
    'Alright without, out — not on the list',
  );
  assert.equal(
    describeItem({ ...pantryItem('x', 'stocked', 'alright-without'), restock: true }),
    'Alright without, in stock — on the list because you added it',
  );
  assert.equal(
    describeItem({ ...pantryItem('x', 'out', 'must-have'), restock: false }),
    'Must-have, out — off the list because you took it off',
  );
});

test('finding the jar emptier than you thought does not cancel your order', () => {
  // The bug the obvious rule has: clearing the override on any change cancels
  // "buy this" at the exact moment it became more urgent.
  const asked = { ...pantryItem('x', 'low', 'alright-without'), restock: true };
  assert.equal(isOnList(afterStockChange(asked, 'out')), true);
});

test('getting it back in stock ends the override, whichever way it pointed', () => {
  const asked = { ...pantryItem('x', 'out', 'alright-without'), restock: true };
  const declined = { ...pantryItem('x', 'out', 'must-have'), restock: false };

  assert.equal(afterStockChange(asked, 'stocked').restock, undefined);
  assert.equal(afterStockChange(declined, 'stocked').restock, undefined);
  // And the rule is back in charge the next time it runs low.
  assert.equal(isOnList(afterStockChange(afterStockChange(declined, 'stocked'), 'low')), true);
});

test('the review puts what needs deciding at the top', () => {
  const ingredients = new Map<Id, Ingredient>(
    loadSeedData().ingredients.map((i) => [i.id, i]),
  );
  const [a, b, c] = [...ingredients.keys()];

  const order = reviewOrder([
    pantryItem(a, 'stocked', 'must-have'),
    pantryItem(b, 'out', 'alright-without'),
    pantryItem(c, 'out', 'must-have'),
  ], ingredients);

  assert.deepEqual(
    order.map((r) => r.item.ingredientId),
    [c, b, a],
    'on the list first, then empty, then what is fine',
  );
});

test('a pantry item nobody has in the library is skipped, not rendered blank', () => {
  const ingredients = new Map<Id, Ingredient>(
    loadSeedData().ingredients.map((i) => [i.id, i]),
  );
  const order = reviewOrder([pantryItem('ingredient-that-left', 'out', 'must-have')], ingredients);
  assert.equal(order.length, 0);
});

test('the grocery list buys a pack of what the pantry says to buy', () => {
  const base = planningContext();
  const id = [...base.ingredients.keys()][0];
  const ing = base.ingredients.get(id)!;

  const ctx: PlanningContext = {
    ...base,
    pantry: new Map([[id, pantryItem(id, 'out', 'must-have')]]),
  };
  const needs = aggregateNeeds([], [], ctx);

  assert.equal(needs.get(id)?.grams, ing.purchase.gramsPerPack);
  assert.deepEqual(needs.get(id)?.origins, [{ kind: 'pantry' }]);
});

test('what the pantry is alright without stays off the list even when empty', () => {
  const base = planningContext();
  const id = [...base.ingredients.keys()][0];

  const ctx: PlanningContext = {
    ...base,
    pantry: new Map([[id, pantryItem(id, 'out', 'alright-without')]]),
  };

  assert.equal(aggregateNeeds([], [], ctx).has(id), false);
});

test('a restock you asked for is bought even though the cupboard is not empty', () => {
  // The two halves of "stocked" pulling in opposite directions, and both right:
  // recipes using it are still free, and the top-up you asked for is still a pack
  // you are paying for.
  const base = planningContext();
  const id = [...base.ingredients.keys()][0];

  const ctx: PlanningContext = {
    ...base,
    pantry: new Map([[id, { ...pantryItem(id, 'stocked', 'must-have'), restock: true }]]),
  };

  assert.equal(aggregateNeeds([], [], ctx).get(id)?.grams, base.ingredients.get(id)!.purchase.gramsPerPack);
});

test('an excluded ingredient is not bought just because the pantry wants it', () => {
  const base = planningContext();
  const id = [...base.ingredients.keys()][0];

  const ctx: PlanningContext = {
    ...base,
    pantry: new Map([[id, pantryItem(id, 'out', 'must-have')]]),
    settings: { ...base.settings, excludedIngredients: [id] },
  };

  assert.equal(aggregateNeeds([], [], ctx).has(id), false);
});

// ---------------------------------------------------------------------------

group('Already have it');

test('a bag of rice is worth a pantry row and a bunch of parsley is not', () => {
  const ingredients = new Map<Id, Ingredient>(
    loadSeedData().ingredients.map((i) => [i.id, i]),
  );

  // The distinction the offer turns on. Both are true sentences said in a shop —
  // "I have rice", "I have parsley" — and only the first is still true in a month.
  assert.equal(worthKeeping(ingredients.get('arborio-rice')!), true);
  assert.equal(worthKeeping(ingredients.get('olive-oil')!), true);
  assert.equal(worthKeeping(ingredients.get('parsley')!), false);
});

test('what is worth keeping is exactly what survives a week, across the library', () => {
  // One question, asked in two places: the offer here, and what a finished shop
  // banks as carry-over. They are the same test on purpose, so a library edit
  // cannot make them disagree — an ingredient the shop banks but the pantry will
  // not keep, or the reverse, is a quiet inconsistency nobody would go looking for.
  for (const ing of loadSeedData().ingredients) {
    assert.equal(
      worthKeeping(ing),
      carryOverOf(ing) === 'pantry',
      `${ing.name} disagrees with the waste model about whether it keeps`,
    );
  }
});

test('freezing is not the cupboard, however long it lasts', () => {
  const ingredients = new Map<Id, Ingredient>(
    loadSeedData().ingredients.map((i) => [i.id, i]),
  );
  // A loaf in the freezer keeps for months, and is still not a thing the pantry
  // should quietly treat as always-in. The pantry makes its contents free to the
  // planner, so the bar is "always there", not "lasts a while".
  const frozen = [...ingredients.values()].filter((i) => carryOverOf(i) === 'freezer');
  assert.ok(frozen.length > 0, 'the library has nothing freezable to check');
  for (const ing of frozen) assert.equal(worthKeeping(ing), false);
});

// ---------------------------------------------------------------------------

group('The treat bag');

/** Nobody is allergic to anything and no diet is on. The common case. */
const NO_RESTRICTIONS: TreatEligibility = { allergens: [], diets: [] };

function treatKinds(items: readonly TreatItem[]): TreatKind[] {
  return items.map((t) => {
    const treat = getTreat(t.treatId);
    if (!treat) assert.fail(`drew ${t.treatId}, which is not in the catalogue`);
    return treat.kind;
  });
}

function countKind(items: readonly TreatItem[], kind: TreatKind): number {
  return treatKinds(items).filter((k) => k === kind).length;
}

test('nothing in the catalogue costs more than ten dollars', () => {
  // The ceiling is the feature: a treat you have to think about is a purchase.
  for (const treat of TREATS) {
    assert.ok(
      treat.priceCents > 0 && treat.priceCents <= MAX_TREAT_CENTS,
      `${treat.id} is ${treat.priceCents} cents`,
    );
    // Cents, not dollars — a price written as 6 rather than 600 would pass the
    // ceiling check and then be wrong everywhere it was displayed.
    assert.ok(Number.isInteger(treat.priceCents), `${treat.id} price is not whole cents`);
  }
});

test('the catalogue is well formed and offers all three kinds', () => {
  assert.equal(new Set(TREATS.map((t) => t.id)).size, TREATS.length, 'duplicate treat id');

  for (const treat of TREATS) {
    assert.ok(treat.name.trim() !== '', `${treat.id} has no name`);
    assert.ok(treat.note.trim() !== '', `${treat.id} has no note`);
  }

  for (const kind of TREAT_KINDS) {
    const count = TREATS.filter((t) => t.kind === kind).length;
    // A kind with a handful of entries repeats itself within a month of redraws.
    assert.ok(count >= 8, `only ${count} treats of kind ${kind}`);
  }
});

test('a bag is never all food', () => {
  // The whole reason the draw balances kinds rather than picking uniformly. Two
  // thirds of the catalogue is edible, so a uniform draw of three would come
  // back with nothing to do and everything to eat often enough to be annoying.
  for (let seed = 0; seed < 40; seed++) {
    const bag = fitTreats(NO_RESTRICTIONS, 3, seed);
    assert.equal(bag.length, 3, `seed ${seed}`);
    for (const kind of TREAT_KINDS) {
      assert.equal(countKind(bag, kind), 1, `seed ${seed} wanted one ${kind}`);
    }
  }
});

test('a bigger bag keeps the kinds even', () => {
  const bag = fitTreats(NO_RESTRICTIONS, 6, 99);
  assert.equal(bag.length, 6);
  for (const kind of TREAT_KINDS) assert.equal(countKind(bag, kind), 2, kind);
});

test('the same treat is never drawn twice', () => {
  for (let seed = 0; seed < 20; seed++) {
    const bag = fitTreats(NO_RESTRICTIONS, 9, seed);
    assert.equal(new Set(bag.map((t) => t.treatId)).size, bag.length, `seed ${seed}`);
  }
});

test('a bag of zero is a bag of zero', () => {
  assert.deepEqual(fitTreats(NO_RESTRICTIONS, 0, 7), []);
});

test('an allergen rules a treat out of the draw entirely', () => {
  // Not flagged in the bag with a warning on it — never drawn. Offering someone
  // a bag of pistachios they cannot eat is not a treat.
  const nutty = TREATS.filter((t) => t.allergens?.includes('tree-nuts')).map((t) => t.id);
  assert.ok(nutty.length > 0, 'the catalogue has nothing with tree nuts in it to test');

  const settings: TreatEligibility = { allergens: ['tree-nuts'], diets: [] };
  assert.ok(eligibleTreats(settings).every((t) => !nutty.includes(t.id)));

  for (let seed = 0; seed < 20; seed++) {
    const bag = fitTreats(settings, 9, seed);
    for (const item of bag) assert.ok(!nutty.includes(item.treatId), `seed ${seed}`);
  }
});

test('a diet rules a treat out of the draw entirely', () => {
  const honeyAndWax = TREATS.filter((t) => t.excludesDiets?.includes('vegan')).map((t) => t.id);
  assert.ok(honeyAndWax.length > 0, 'the catalogue has nothing non-vegan to test');

  const bag = fitTreats({ allergens: [], diets: ['vegan'] }, 9, 5);
  for (const item of bag) assert.ok(!honeyAndWax.includes(item.treatId));
});

test('topping up keeps what is there and balances the whole bag', () => {
  // Pin two teas, ask for four. The two new ones must not be more tea — a
  // top-up that only balanced the new items would hand back four teas.
  const teas = TREATS.filter((t) => t.kind === 'tea').slice(0, 2);
  const pinned: TreatItem[] = teas.map((t) => ({ treatId: t.id, pinned: true }));

  const grown = fitTreats(NO_RESTRICTIONS, 4, 4242, pinned);

  assert.equal(grown.length, 4);
  for (const tea of teas) {
    assert.ok(grown.some((t) => t.treatId === tea.id), `${tea.id} was dropped`);
  }
  assert.equal(countKind(grown, 'tea'), 2, 'topped the bag up with yet more tea');
});

test('shrinking the bag drops what was not kept, and keeps the order', () => {
  const start = fitTreats(NO_RESTRICTIONS, 6, 2024);
  // Pin the last two, which are the two a naive "keep the first N" would lose.
  const pinnedIds = [start[4].treatId, start[5].treatId];
  const marked = start.map((t) => ({ ...t, pinned: pinnedIds.includes(t.treatId) }));

  const shrunk = fitTreats(NO_RESTRICTIONS, 2, 11, marked);

  assert.equal(shrunk.length, 2);
  assert.deepEqual(shrunk.map((t) => t.treatId), pinnedIds, 'lost a kept treat, or reordered');
});

test('a bag bigger than what is left is short, not padded with repeats', () => {
  // Three treats to choose from and a bag of eight asked for. The honest answer
  // is three: padding it would mean drawing something twice.
  const tiny = TREATS.filter((t) => ['tea-chamomile', 'kombucha', 'flowers'].includes(t.id));
  assert.equal(tiny.length, 3, 'the ids this test pins have moved');

  const bag = pickTreats(NO_RESTRICTIONS, 8, 1234, { catalogue: tiny });

  assert.equal(bag.length, 3);
  assert.equal(new Set(bag.map((t) => t.treatId)).size, 3);
});

test('a treat that has left the catalogue is dropped rather than drawn', () => {
  // A plan synced from a version that had a treat this one does not. Rendering a
  // blank row would look like a bug; quietly replacing it is the right answer.
  const stale: TreatItem[] = [{ treatId: 'tea-of-the-ancients', pinned: true }];
  const bag = fitTreats(NO_RESTRICTIONS, 3, 8, stale);

  assert.equal(bag.length, 3);
  assert.ok(bag.every((t) => getTreat(t.treatId) !== undefined));
});

test('switching the bag off draws nothing but keeps the size', () => {
  // The switch and the size are separate settings on purpose. Off has to mean a
  // bag of nothing, and switching back on has to give back the bag the household
  // chose rather than the default one.
  const off = { treatBagEnabled: false, treatCount: 5 };
  assert.equal(treatTarget(off), 0);
  assert.deepEqual(fitTreats(NO_RESTRICTIONS, treatTarget(off), 11), []);

  assert.equal(treatTarget({ ...off, treatBagEnabled: true }), 5, 'the size did not survive');
});

test('a negative size is read as none rather than trusted', () => {
  // Nothing in the UI can produce one, but a settings row synced from another
  // build can, and `fitTreats` would otherwise be handed a negative target.
  assert.equal(treatTarget({ treatBagEnabled: true, treatCount: -2 }), 0);
});

// ---------------------------------------------------------------------------

group('The This week screen sections');

test('every grab bag has a switch, and every switch is its own', () => {
  // The switchboard in Settings is built from this list, so a fifth bag added
  // without a row here would be a bag nobody can switch off.
  for (const bag of GRAB_BAGS) {
    const section = WEEK_SECTIONS.find((s) => s.enabledKey === bag.enabledKey);
    assert.ok(section !== undefined, `${bag.id} has no switch`);
    assert.equal(section.effect, 'grab-bag', `${bag.id} is switched as the wrong kind`);
  }

  assert.equal(
    new Set(WEEK_SECTIONS.map((s) => s.id)).size,
    WEEK_SECTIONS.length,
    'two sections share an id, so React keys and the switchboard would collide',
  );
  assert.equal(
    new Set(WEEK_SECTIONS.map((s) => s.enabledKey)).size,
    WEEK_SECTIONS.length,
    'two sections share a setting, so one switch would move both',
  );
});

test('the two groups are the whole list and nothing twice', () => {
  // Settings renders the groups, not the list. Anything falling out of both would
  // be a section with a setting and no way to reach it.
  assert.equal(DISPLAY_SECTIONS.length + DRAWN_SECTIONS.length, WEEK_SECTIONS.length);
  assert.ok(DRAWN_SECTIONS.every((s) => s.effect !== 'display'));
  assert.ok(DISPLAY_SECTIONS.every((s) => s.effect === 'display'));
});

// ---------------------------------------------------------------------------

group('Adding a recipe to the week by hand');

function planSlot(id: Id, mealType: MealType, recipeId: Id | null, pinned = false): PlanSlot {
  return { id, mealType, recipeId, servings: 2, pinned };
}

const CHILLI: Pick<Recipe, 'id' | 'mealType'> = { id: 'chilli', mealType: 'full' };

test('it goes into an empty slot of its own meal type', () => {
  const slots = [
    planSlot('full-0', 'full', 'stew'),
    planSlot('full-1', 'full', null),
    planSlot('light-0', 'light', null),
  ];
  const after = placeRecipe(slots, CHILLI, 4);

  assert.equal(after.length, 3, 'made a new slot with one going spare');
  assert.equal(after[1].recipeId, 'chilli');
  assert.equal(after[1].id, 'full-1', 'renamed the slot, orphaning anything keyed to it');
  assert.equal(after[0].recipeId, 'stew', 'threw out a meal the optimizer chose');
});

test('a snack does not land in an empty full-meal slot', () => {
  const after = placeRecipe([planSlot('full-0', 'full', null)], { id: 'popcorn', mealType: 'snack' }, 2);

  assert.equal(after[0].recipeId, null, 'put a snack where a full meal goes');
  assert.equal(after.length, 2);
  assert.equal(after[1].mealType, 'snack');
});

test('a full week gets another slot rather than losing a meal', () => {
  const slots = [planSlot('full-0', 'full', 'stew'), planSlot('full-1', 'full', 'curry')];
  const after = placeRecipe(slots, CHILLI, 4);

  assert.deepEqual(after.map((s) => s.recipeId), ['stew', 'curry', 'chilli']);
});

test('the new slot answers to an id nothing else does', () => {
  // Ids are numbered per meal type and unique only within their plan, so a gap in
  // the numbering is the case worth getting right: `full-1` is free here.
  const slots = [planSlot('full-0', 'full', 'stew'), planSlot('full-2', 'full', 'curry')];
  const ids = placeRecipe(slots, CHILLI, 4).map((s) => s.id);

  assert.equal(new Set(ids).size, ids.length, `two slots share an id: ${ids.join(', ')}`);
});

test('it is added at the portions it was added at', () => {
  assert.equal(placeRecipe([planSlot('full-0', 'full', null)], CHILLI, 6)[0].servings, 6);
});

test('it arrives pinned, so the next regenerate keeps it', () => {
  // The whole point of picking a meal by name is that it is in the week. A
  // regenerate quietly dropping it would read as the button not having worked.
  assert.equal(placeRecipe([planSlot('full-0', 'full', null)], CHILLI, 4)[0].pinned, true);
});

test('adding one the week already has changes nothing at all', () => {
  const slots = [planSlot('full-0', 'full', 'chilli')];
  assert.equal(placeRecipe(slots, CHILLI, 8), slots, 'a second copy, or a pointless write');
});

test('regenerating around a pinned slot does not mint a duplicate id', () => {
  // Pinning the third full meal and regenerating used to produce two slots both
  // called `full-2`, because the skeleton numbered from the pinned count rather
  // than around the ids already taken. Every per-slot write then hit both.
  const ctx = planningContext();
  const someFullMeal = [...ctx.recipes.values()].find((r) => r.mealType === 'full');
  if (!someFullMeal) assert.fail('the seed library has no full meals');

  const { plan } = generateWeekPlan(ctx, {
    spec: { full: 4, light: 3, snack: 2, servingsPerMeal: { full: 2, light: 2, snack: 1 } },
    pinnedSlots: [planSlot('full-2', 'full', someFullMeal.id, true)],
    restarts: 1,
    seed: 7,
  });

  const ids = plan.slots.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate slot id: ${ids.join(', ')}`);
});

// ---------------------------------------------------------------------------

group('Rerolling one kind of meal');

const WEEK: SlotSpec = {
  full: 4, light: 3, snack: 2, servingsPerMeal: { full: 2, light: 2, snack: 1 },
};

/** A generated week to reroll a section of. */
function plannedWeek(ctx: PlanningContext): readonly PlanSlot[] {
  return generateWeekPlan(ctx, { spec: WEEK, restarts: 2, seed: 4242 }).plan.slots;
}

function reroll(
  ctx: PlanningContext,
  slots: readonly PlanSlot[],
  mealType: MealType,
  seed: number,
  spec: SlotSpec = WEEK,
): readonly PlanSlot[] {
  return regenerateMeals(ctx, slots, mealType, { spec, restarts: 2, seed });
}

/** The recipes of one kind, as something two weeks can be compared on. */
function meals(slots: readonly PlanSlot[], mealType: MealType): string {
  return slots.filter((s) => s.mealType === mealType).map((s) => s.recipeId).sort().join(',');
}

test('the other kinds of meal come back untouched', () => {
  // The whole reason the button exists: not liking this week's light meals is
  // not a reason to lose four dinners you do like.
  const ctx = planningContext();
  const before = plannedWeek(ctx);
  const after = reroll(ctx, before, 'light', 9);

  const rest = (slots: readonly PlanSlot[]): PlanSlot[] =>
    slots.filter((s) => s.mealType !== 'light');
  assert.deepEqual(rest(after), rest(before));
});

test('it does not hand the same meals straight back', () => {
  // With the rest of the week standing still there is one best set of light
  // meals and the optimizer finds it from every start, so a reroll that merely
  // re-optimized would return the same three for ever — a button doing nothing.
  const ctx = planningContext();
  const before = plannedWeek(ctx);
  const after = reroll(ctx, before, 'light', 9);

  const rejected = new Set(before.filter((s) => s.mealType === 'light').map((s) => s.recipeId));
  assert.ok(
    after.filter((s) => s.mealType === 'light').every((s) => !rejected.has(s.recipeId)),
    'served back a light meal that had just been rejected',
  );
  assert.notEqual(meals(after, 'light'), meals(before, 'light'));
});

test('a library with nothing spare refills rather than leaving holes', () => {
  // Three light recipes and three light slots: the rejection cannot be honoured
  // and the section filled, and an empty slot is much the worse of the two.
  const ctx = planningContext();
  const only = [...ctx.recipes.values()].filter((r) => r.mealType === 'light').slice(0, 3);
  const small: PlanningContext = {
    ...ctx,
    recipes: new Map(
      [...ctx.recipes].filter(([, r]) => r.mealType !== 'light' || only.includes(r)),
    ),
  };

  const before = plannedWeek(small);
  const after = reroll(small, before, 'light', 9);
  const lights = after.filter((s) => s.mealType === 'light');

  assert.equal(lights.length, 3);
  assert.ok(lights.every((s) => s.recipeId !== null), 'left a light slot empty');
});

test('a pinned meal of that kind survives it', () => {
  const ctx = planningContext();
  const before = plannedWeek(ctx).map((s) => (s.id === 'light-0' ? { ...s, pinned: true } : s));
  const kept = before.find((s) => s.id === 'light-0');

  const slot = reroll(ctx, before, 'light', 11).find((s) => s.id === 'light-0');
  assert.equal(slot?.recipeId, kept?.recipeId, 'threw out a meal that was pinned');
  assert.equal(slot?.pinned, true);
});

test('a rerolled meal is never one the rest of the week already has', () => {
  // The other meal types arrive already filled, so they have to count as used —
  // or rerolling the light meals serves the soup the full meals are having.
  const ctx = planningContext();
  const after = reroll(ctx, plannedWeek(ctx), 'light', 3);

  const used = after.map((s) => s.recipeId).filter((id): id is Id => id !== null);
  assert.equal(new Set(used).size, used.length, 'the same recipe twice in one week');
});

test('it does not mint a duplicate slot id around a pin', () => {
  const ctx = planningContext();
  const before = plannedWeek(ctx).map((s) => (s.id === 'light-1' ? { ...s, pinned: true } : s));

  const ids = reroll(ctx, before, 'light', 5).map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate slot id: ${ids.join(', ')}`);
});

test('the section comes back at the size Settings asks for', () => {
  const ctx = planningContext();
  const before = plannedWeek(ctx);

  const grown = reroll(ctx, before, 'light', 8, { ...WEEK, light: 5 });
  assert.equal(grown.filter((s) => s.mealType === 'light').length, 5);
  assert.equal(
    grown.filter((s) => s.mealType === 'full').length, 4,
    'resized a section it was not asked about',
  );

  const shrunk = reroll(ctx, before, 'light', 8, { ...WEEK, light: 1 });
  assert.equal(shrunk.filter((s) => s.mealType === 'light').length, 1);
});

test('rerolling the snacks leaves the meals and the portions they were set to', () => {
  const ctx = planningContext();
  const before = plannedWeek(ctx).map((s) => (s.mealType === 'full' ? { ...s, servings: 6 } : s));

  const after = reroll(ctx, before, 'snack', 17);
  assert.ok(after.filter((s) => s.mealType === 'full').every((s) => s.servings === 6));
  assert.equal(meals(after, 'full'), meals(before, 'full'));
  assert.equal(meals(after, 'light'), meals(before, 'light'));
});

// ---------------------------------------------------------------------------

group('Redrawing one meal');

const SPEC = { full: 4, light: 3, snack: 2, servingsPerMeal: { full: 2, light: 2, snack: 1 } };

/** A week of real recipes, so the reroll has a pool and a plan worth scoring. */
function weekOfMeals(): { ctx: PlanningContext; slots: readonly PlanSlot[] } {
  const ctx = planningContext();
  const { plan } = generateWeekPlan(ctx, { spec: SPEC, restarts: 2, seed: 11 });
  return { ctx, slots: plan.slots };
}

test('it changes the one meal it was asked about and nothing else', () => {
  const { ctx, slots } = weekOfMeals();
  const target = slots.find((s) => s.mealType === 'full' && s.recipeId !== null);
  if (!target) assert.fail('the generated week has no full meals');

  const after = rerollSlot(ctx, slots, target.id, { spec: SPEC, seed: 3 });
  if (!after) assert.fail('nothing was drawn from a full seed library');

  assert.notEqual(
    after.find((s) => s.id === target.id)?.recipeId,
    target.recipeId,
    'handed back the meal it was told to throw out',
  );
  assert.deepEqual(
    after.filter((s) => s.id !== target.id).map((s) => s.recipeId),
    slots.filter((s) => s.id !== target.id).map((s) => s.recipeId),
    'moved a meal it was not asked about',
  );
  assert.equal(after.length, slots.length, 'changed the shape of the week');
});

test('it never draws something the week is already having', () => {
  const { ctx, slots } = weekOfMeals();
  const target = slots.find((s) => s.mealType === 'full' && s.recipeId !== null);
  if (!target) assert.fail('the generated week has no full meals');

  // Once is luck; the draw is random, so this is the claim worth repeating.
  for (let seed = 0; seed < 25; seed++) {
    const after = rerollSlot(ctx, slots, target.id, { spec: SPEC, seed });
    if (!after) assert.fail(`nothing drawn at seed ${seed}`);
    const ids = after.map((s) => s.recipeId).filter((id) => id !== null);
    assert.equal(new Set(ids).size, ids.length, `the week eats the same thing twice at seed ${seed}`);
  }
});

test('pressing it again does not hand back what it just threw out', () => {
  const { ctx, slots } = weekOfMeals();
  const target = slots.find((s) => s.mealType === 'full' && s.recipeId !== null);
  if (!target) assert.fail('the generated week has no full meals');

  const first = rerollSlot(ctx, slots, target.id, { spec: SPEC, seed: 5 });
  if (!first) assert.fail('nothing drawn on the first press');
  const passedOver = new Set([target.recipeId as Id]);

  // The dismissed meal is no longer in the week, so only `exclude` keeps it out
  // — and it was the optimizer's own pick, which is to say near the top of the
  // ranking the second draw is about to sample from.
  for (let seed = 0; seed < 25; seed++) {
    const again = rerollSlot(ctx, first, target.id, { spec: SPEC, seed, exclude: passedOver });
    if (!again) assert.fail(`nothing drawn at seed ${seed}`);
    assert.notEqual(
      again.find((s) => s.id === target.id)?.recipeId,
      target.recipeId,
      `seed ${seed} brought back the meal that was passed over`,
    );
  }
});

test('it gives a different answer on a different press', () => {
  // A steepest-descent reroll would find the single cheapest replacement every
  // time, and a shuffle button that repeats itself is a broken shuffle button.
  const { ctx, slots } = weekOfMeals();
  const target = slots.find((s) => s.mealType === 'full' && s.recipeId !== null);
  if (!target) assert.fail('the generated week has no full meals');

  const drawn = new Set(
    Array.from({ length: 20 }, (_, seed) =>
      rerollSlot(ctx, slots, target.id, { spec: SPEC, seed })?.find((s) => s.id === target.id)
        ?.recipeId),
  );
  assert.ok(drawn.size > 1, 'twenty presses drew the same meal every time');
});

test('the new meal comes at the portions the spec asks for', () => {
  const { ctx, slots } = weekOfMeals();
  const target = slots.find((s) => s.mealType === 'full' && s.recipeId !== null);
  if (!target) assert.fail('the generated week has no full meals');

  // The portions belonged to the meal being thrown out, exactly as they do when
  // a whole section is rerolled.
  const hand = slots.map((s) => (s.id === target.id ? { ...s, servings: 9 } : s));
  const after = rerollSlot(ctx, hand, target.id, { spec: SPEC, seed: 2 });

  assert.equal(after?.find((s) => s.id === target.id)?.servings, SPEC.servingsPerMeal.full);
});

test('a pinned meal is left alone', () => {
  const { ctx, slots } = weekOfMeals();
  const target = slots.find((s) => s.mealType === 'full' && s.recipeId !== null);
  if (!target) assert.fail('the generated week has no full meals');

  const pinned = slots.map((s) => (s.id === target.id ? { ...s, pinned: true } : s));
  assert.equal(rerollSlot(ctx, pinned, target.id, { spec: SPEC, seed: 1 }), null);
});

test('it fills an empty slot rather than refusing one', () => {
  // The slot the "could not be filled" warning is about. There is no meal to
  // dismiss, but there is still one to draw.
  const { ctx, slots } = weekOfMeals();
  const target = slots.find((s) => s.mealType === 'full' && s.recipeId !== null);
  if (!target) assert.fail('the generated week has no full meals');

  const emptied = slots.map((s) => (s.id === target.id ? { ...s, recipeId: null } : s));
  const after = rerollSlot(ctx, emptied, target.id, { spec: SPEC, seed: 4 });

  assert.notEqual(after?.find((s) => s.id === target.id)?.recipeId ?? null, null);
});

test('an empty pool says so instead of pretending', () => {
  const { ctx, slots } = weekOfMeals();
  const target = slots.find((s) => s.mealType === 'full' && s.recipeId !== null);
  if (!target) assert.fail('the generated week has no full meals');

  const everyFullMeal = new Set(
    [...ctx.recipes.values()].filter((r) => r.mealType === 'full').map((r) => r.id),
  );
  assert.equal(
    rerollSlot(ctx, slots, target.id, { spec: SPEC, seed: 1, exclude: everyFullMeal }),
    null,
  );
});

test('a slot the week does not have draws nothing', () => {
  const { ctx, slots } = weekOfMeals();
  assert.equal(rerollSlot(ctx, slots, 'full-99', { spec: SPEC, seed: 1 }), null);
});

// ---------------------------------------------------------------------------

group('Taking a meal out of the week');

test('it takes exactly the one out and leaves the rest untouched', () => {
  const week = [
    planSlot('full-0', 'full', 'stew'),
    planSlot('full-1', 'full', 'curry'),
    planSlot('light-0', 'light', 'soup'),
  ];
  const after = dropSlot(week, 'full-1');

  assert.deepEqual(after.map((s) => s.id), ['full-0', 'light-0']);
  assert.equal(after[0], week[0], 'rewrote a slot it was not asked about');
});

test('the week gets shorter rather than gaining a slot to fill', () => {
  // The difference between removing a meal and clearing one. An empty slot is a
  // hole the week still wants filled — it is what the "could not be filled"
  // warning counts — and a removed meal is not wanted at all.
  const after = dropSlot([planSlot('full-0', 'full', 'stew')], 'full-0');

  assert.equal(after.length, 0);
  assert.equal(after.filter((s) => s.recipeId === null).length, 0, 'left a hole behind');
});

test('a pinned meal comes out too', () => {
  // A pin means keep through a shuffle. Pressing ✕ is not a shuffle, and a pin
  // that could not be undone by the button next to it would be a trap.
  assert.equal(dropSlot([planSlot('full-0', 'full', 'stew', true)], 'full-0').length, 0);
});

test('an id the week does not have changes nothing', () => {
  const week = [planSlot('full-0', 'full', 'stew')];
  assert.deepEqual(dropSlot(week, 'full-7'), week);
});

test('undo puts it back where it was, not on the end', () => {
  const week = [
    planSlot('full-0', 'full', 'stew'),
    planSlot('full-1', 'full', 'curry'),
    planSlot('full-2', 'full', 'chilli'),
  ];
  const after = reinstateSlot(dropSlot(week, 'full-1'), week[1], 1);

  assert.deepEqual(after.map((s) => s.id), ['full-0', 'full-1', 'full-2']);
});

test('out and back again leaves the week exactly as it was', () => {
  // Portions and the pin travel with it. Recovering the meal but not the four
  // portions it was set to is the kind of undo that is worse than none.
  const week = [
    planSlot('full-0', 'full', 'stew'),
    { ...planSlot('full-1', 'full', 'curry', true), servings: 6 },
    planSlot('light-0', 'light', 'soup'),
  ];
  assert.deepEqual(reinstateSlot(dropSlot(week, 'full-1'), week[1], 1), week);
});

test('a slot whose id the week has handed out again is not put back', () => {
  // `freeSlotId` takes the lowest number going spare, so the id a removal just
  // vacated is the first one a section shuffle reaches for. Two slots answering
  // to `full-1` means every per-slot write from then on lands on both.
  const week = [planSlot('full-0', 'full', 'curry'), planSlot('full-1', 'full', 'chilli')];

  assert.equal(reinstateSlot(week, planSlot('full-1', 'full', 'stew'), 1), week);
});

test('an index the week has outgrown is clamped rather than dropped', () => {
  const week = [planSlot('full-0', 'full', 'curry')];
  const after = reinstateSlot(week, planSlot('full-9', 'full', 'stew'), 7);

  assert.deepEqual(after.map((s) => s.id), ['full-0', 'full-9']);
});

test('a lost position puts it back at the front rather than nowhere', () => {
  // -1 is what `findIndex` answers when the slot had already gone, which is the
  // realistic way a nonsense index reaches this.
  const after = reinstateSlot([planSlot('full-0', 'full', 'curry')], planSlot('full-1', 'full', 'stew'), -1);

  assert.deepEqual(after.map((s) => s.id), ['full-1', 'full-0']);
});

test('shuffling the section brings the week back to the size settings ask for', () => {
  // What the empty-section note on the week screen promises, and the only way
  // back from having removed every meal of one kind. Removing is an edit to this
  // week; how big a week is lives in Settings.
  const ctx = planningContext();
  const week = plannedWeek(ctx);
  const aLightMeal = week.find((s) => s.mealType === 'light');
  if (!aLightMeal) assert.fail('the generated week has no light meals to remove');

  const shortened = dropSlot(week, aLightMeal.id);
  assert.equal(shortened.filter((s) => s.mealType === 'light').length, WEEK.light - 1);

  const after = reroll(ctx, shortened, 'light', 11);
  assert.equal(after.filter((s) => s.mealType === 'light').length, WEEK.light);

  const ids = after.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate slot id: ${ids.join(', ')}`);
});

// ---------------------------------------------------------------------------

group('Taking something off the shopping list');

/** A week's shopping, built the way the app builds it. */
function shoppingList(): { list: GroceryList; ctx: PlanningContext; plan: WeekPlan } {
  const ctx = planningContext();
  const { plan } = generateWeekPlan(ctx, { spec: WEEK, restarts: 2, seed: 4242 });
  const list = buildGroceryList(plan, ctx);

  if (list.lines.length < 3) assert.fail('the generated week bought almost nothing');
  return { list, ctx, plan };
}

test('a line taken off is off the list', () => {
  const { list } = shoppingList();
  const gone = list.lines[1].ingredientId;

  const after = withoutRemoved(list, new Set([gone]));

  assert.equal(after.lines.length, list.lines.length - 1);
  assert.equal(after.lines.some((l) => l.ingredientId === gone), false);
});

test('the rest of the shop is untouched, down to the line', () => {
  // Not merely "still there": the packs and the grams on every other line are
  // what the running total and the carry-over are read off, and a removal that
  // rewrote any of them would be silently changing what the week costs.
  const { list } = shoppingList();
  const after = withoutRemoved(list, new Set([list.lines[1].ingredientId]));

  assert.deepEqual(after.lines, [list.lines[0], ...list.lines.slice(2)]);
  assert.equal(after.lines[0], list.lines[0], 'rewrote a line it was not asked about');
  assert.equal(after.planId, list.planId);
});

test('the rebuild brings it straight back, which is why it is stored elsewhere', () => {
  // The whole reason a removal lives beside the ticks rather than anywhere in the
  // derived list. Nothing about the week changed, so the builder has no way to
  // know — handed the shortened list as the previous one, it still returns the
  // line, because the plan still wants the ingredient. Staying off is the removal
  // being applied over the top, every time.
  const { list, ctx, plan } = shoppingList();
  const gone = list.lines[1].ingredientId;
  const removed = new Set([gone]);

  const rebuilt = buildGroceryList(plan, ctx, withoutRemoved(list, removed));

  assert.equal(
    rebuilt.lines.some((l) => l.ingredientId === gone),
    true,
    'the builder remembered something the plan does not say',
  );
  assert.equal(
    withoutRemoved(rebuilt, removed).lines.some((l) => l.ingredientId === gone),
    false,
  );
});

test('a treat id takes nothing off the groceries', () => {
  // Both kinds of line are taken off through the same table, keyed by treat id
  // for one and ingredient id for the other, and they meet in one set.
  const { list } = shoppingList();

  assert.equal(withoutRemoved(list, new Set(['treat-dark-chocolate'])).lines.length,
    list.lines.length);
});

test('nothing taken off hands the same list straight back', () => {
  const { list } = shoppingList();
  assert.equal(withoutRemoved(list, new Set()), list);
});

// ---------------------------------------------------------------------------

group('Recipe variants');

/** A family plus an unrelated meal, built through the real importer so grams resolve. */
function variantLibrary(): { recipes: Recipe[]; byId: Map<Id, Recipe> } {
  const snack = (id: string, item: string, extra: Partial<RawRecipe> = {}): RawRecipe => ({
    id, name: id, mealType: 'snack', baseServings: 2,
    prepMinutes: 5, cookMinutes: 0, steps: ['Eat.'],
    ingredients: [{ item, quantity: 200, unit: 'g' }],
    ...extra,
  } as RawRecipe);

  const result = importBundle({
    recipes: [
      snack('bean-bowl', 'pinto beans'),
      snack('bean-bowl-kidney', 'kidney beans', { variantOf: 'bean-bowl', variantLabel: 'with kidney beans' }),
      snack('other-snack', 'kidney beans'),
    ],
  }, loadSeedData().ingredients);

  assert.equal(result.rejected.length, 0, `family rejected: ${JSON.stringify(result.rejected)}`);
  return { recipes: result.recipes, byId: new Map(result.recipes.map((r) => [r.id, r])) };
}

function variantContext(): PlanningContext {
  const { recipes } = variantLibrary();
  return { ...planningContext(), recipes: new Map<Id, Recipe>(recipes.map((r) => [r.id, r])) };
}

const EVERY_VARIANT = new Set<Id>(['bean-bowl', 'bean-bowl-kidney', 'other-snack']);

test('a family indexes parent first, however the file was ordered', () => {
  const { recipes } = variantLibrary();
  // Reversed, so a variant is seen before the parent it belongs to.
  const index = buildVariantIndex([...recipes].reverse());

  assert.deepEqual(index.members.get('bean-bowl'), ['bean-bowl', 'bean-bowl-kidney']);
  assert.equal(familyIdOf(recipes.find((r) => r.id === 'bean-bowl-kidney')!), 'bean-bowl');
});

test('the planner is shown one member of each family', () => {
  const { recipes } = variantLibrary();
  const ids = collapseToFamilies(recipes).map((r) => r.id).sort();

  assert.deepEqual(ids, ['bean-bowl', 'other-snack'], 'offered two versions of the same dish');
});

test('a family survives its parent being filtered out', () => {
  // The case that matters: the default uses something you cannot eat but a
  // variant does not, and hiding the whole dish would be the wrong answer.
  const { byId } = variantLibrary();
  const withoutParent = [byId.get('bean-bowl-kidney')!, byId.get('other-snack')!];

  assert.deepEqual(
    collapseToFamilies(withoutParent).map((r) => r.id),
    ['other-snack', 'bean-bowl-kidney'],
  );
});

test('the variant that shares a pack with the rest of the week wins', () => {
  const ctx = variantContext();
  const slots = [planSlot('snack-0', 'snack', 'other-snack'), planSlot('snack-1', 'snack', 'bean-bowl')];

  const after = chooseBestVariants(
    slots, [], ctx, DEFAULT_WEIGHTS, EVERY_VARIANT, buildVariantIndex(ctx.recipes.values()),
  );

  // Both snacks want 200 g of bean. Two different beans is two cans; the same
  // bean twice is one, which is the entire reason variants are worth having.
  assert.equal(after[1].recipeId, 'bean-bowl-kidney');
});

test('a pinned meal keeps the exact recipe that was pinned', () => {
  const ctx = variantContext();
  const slots = [
    planSlot('snack-0', 'snack', 'other-snack'),
    planSlot('snack-1', 'snack', 'bean-bowl', true),
  ];

  const after = chooseBestVariants(
    slots, [], ctx, DEFAULT_WEIGHTS, EVERY_VARIANT, buildVariantIndex(ctx.recipes.values()),
  );

  assert.equal(after[1].recipeId, 'bean-bowl', 'swapped an ingredient inside a pinned meal');
});

test('a variant the filter removed is never substituted in', () => {
  const ctx = variantContext();
  const slots = [planSlot('snack-0', 'snack', 'other-snack'), planSlot('snack-1', 'snack', 'bean-bowl')];
  // The cheaper variant is exactly the one the filter rejected.
  const allowed = new Set<Id>(['bean-bowl', 'other-snack']);

  const after = chooseBestVariants(
    slots, [], ctx, DEFAULT_WEIGHTS, allowed, buildVariantIndex(ctx.recipes.values()),
  );

  assert.equal(after[1].recipeId, 'bean-bowl', 'served a recipe the filter had removed');
});

test('substitution never puts the same recipe in the week twice', () => {
  const ctx = variantContext();
  const slots = [
    planSlot('snack-0', 'snack', 'bean-bowl-kidney'),
    planSlot('snack-1', 'snack', 'bean-bowl'),
  ];

  const after = chooseBestVariants(
    slots, [], ctx, DEFAULT_WEIGHTS, EVERY_VARIANT, buildVariantIndex(ctx.recipes.values()),
  );

  assert.equal(new Set(after.map((s) => s.recipeId)).size, 2, 'served the same recipe twice');
});

test('a broken family is rejected rather than imported as a loose recipe', () => {
  const base = (id: string, extra: Partial<RawRecipe>): RawRecipe => ({
    id, name: id, mealType: 'snack', baseServings: 2,
    prepMinutes: 1, cookMinutes: 0, steps: [],
    ingredients: [{ item: 'kidney beans', quantity: 100, unit: 'g' }],
    ...extra,
  } as RawRecipe);

  const result = importBundle({
    recipes: [
      base('root', {}),
      base('orphan', { variantOf: 'not-here', variantLabel: 'with x' }),
      base('unlabelled', { variantOf: 'root' }),
      base('wrong-meal', { variantOf: 'root', variantLabel: 'with x', mealType: 'full' }),
      base('child', { variantOf: 'root', variantLabel: 'with x' }),
      base('grandchild', { variantOf: 'child', variantLabel: 'with y' }),
    ],
  }, loadSeedData().ingredients);

  assert.deepEqual(result.rejected.map((r) => r.id).sort(), ['grandchild', 'orphan', 'unlabelled', 'wrong-meal']);
  assert.deepEqual(result.recipes.map((r) => r.id).sort(), ['child', 'root']);
});

test('an exported variant comes back a variant', () => {
  const { recipes } = variantLibrary();
  const raw = toBundle([], recipes).recipes!.find((r) => r.id === 'bean-bowl-kidney')!;

  assert.equal(raw.variantOf, 'bean-bowl');
  assert.equal(raw.variantLabel, 'with kidney beans');
});

// ---------------------------------------------------------------------------

group('Dish type and region');

/** A handful of dishes chosen to pull the rules apart, built through the real importer. */
function taxonomyLibrary(): Map<Id, Recipe> {
  const dish = (id: string, tags: string[], items: RawRecipe['ingredients']): RawRecipe => ({
    id, name: id, mealType: 'full', baseServings: 2, prepMinutes: 5, cookMinutes: 10,
    steps: ['Cook it.'], tags, ingredients: items,
  } as RawRecipe);

  const g = (item: string, extra: Record<string, unknown> = {}): RawRecipe['ingredients'][number] =>
    ({ item, quantity: 100, unit: 'g', ...extra });

  const result = importBundle({
    recipes: [
      dish('noodle-soup', ['soup', 'japanese'], [g('udon noodles'), g('baby spinach')]),
      dish('untagged-pasta', ['italian'], [g('penne'), g('cherry tomatoes')]),
      dish('rice-plate', ['korean'], [g('long grain rice'), g('kimchi')]),
      dish('rice-noodle-plate', ['thai'], [g('rice noodles'), g('bean sprouts')]),
      dish('beans-rice-optional', ['mexican'], [g('black beans'), g('long grain rice', { optional: true })]),
      dish('from-nowhere', [], [g('rolled oats')]),
    ],
  }, loadSeedData().ingredients);

  assert.equal(result.rejected.length, 0, `rejected: ${JSON.stringify(result.rejected)}`);
  return new Map(result.recipes.map((r) => [r.id, r]));
}

const TAXONOMY = taxonomyLibrary();
const TAXONOMY_INGREDIENTS = planningContext().ingredients;

function typeOf(id: Id): string {
  return primaryDishType(TAXONOMY.get(id)!, TAXONOMY_INGREDIENTS);
}

test('a soup with noodles in it files as a soup and is still found as pasta', () => {
  // The whole reason filing and filtering are separate calls.
  assert.equal(typeOf('noodle-soup'), 'soup');
  assert.ok(
    dishTypesOf(TAXONOMY.get('noodle-soup')!, TAXONOMY_INGREDIENTS).includes('pasta'),
    'a search for pasta would miss the noodle soup',
  );
});

test('pasta is found in a recipe that never says it is pasta', () => {
  // Half the library is like this: `pasta e ceci` and `mac and cheese` carry no
  // pasta tag, and filing them anywhere else would be indefensible.
  assert.equal(typeOf('untagged-pasta'), 'pasta');
});

test('rice noodles are noodles, and rice is not', () => {
  assert.equal(typeOf('rice-noodle-plate'), 'pasta');
  assert.equal(typeOf('rice-plate'), 'rice');
});

test('an optional ingredient does not decide what a dish is', () => {
  // "Serve with rice if you like" is a suggestion the shopping list already
  // ignores; it should not file the dish under rice either.
  assert.equal(typeOf('beans-rice-optional'), 'other');
});

test('a recipe with no cuisine tag is from nowhere rather than from Italy', () => {
  assert.equal(cuisineOf(TAXONOMY.get('from-nowhere')!), null);
  assert.equal(regionOf(TAXONOMY.get('from-nowhere')!), 'unfiled');
});

test('cuisines land in their region', () => {
  assert.equal(regionOf(TAXONOMY.get('noodle-soup')!), 'east-asia');
  assert.equal(regionOf(TAXONOMY.get('rice-noodle-plate')!), 'southeast-asia');
  assert.equal(regionOf(TAXONOMY.get('untagged-pasta')!), 'italy');
});

test('every cuisine belongs to exactly one region', () => {
  const seen = new Set<string>();
  for (const region of CUISINE_REGIONS) {
    for (const cuisine of region.cuisines) {
      assert.ok(!seen.has(cuisine), `"${cuisine}" is filed under two regions`);
      seen.add(cuisine);
    }
  }
});

test('hyphenated cuisine tags read as English', () => {
  assert.equal(cuisineLabel('middle-eastern'), 'Middle Eastern');
  assert.equal(cuisineLabel('sri-lankan'), 'Sri Lankan');
});

test('the dish-type filter matches every type, not only the one it files under', () => {
  const found = applyFilter(TAXONOMY.values(), { dishTypes: ['pasta'] }, {
    ingredients: TAXONOMY_INGREDIENTS, region: getRegion('bc-canada'), month: 8,
  }).map((r) => r.id).sort();

  assert.deepEqual(found, ['noodle-soup', 'rice-noodle-plate', 'untagged-pasta']);
});

// ---------------------------------------------------------------------------

group('Week rules');

function weekRule(overrides: Partial<WeekRule> = {}): WeekRule {
  return { ...newRule(), id: 'rule-test', ...overrides };
}

function compileOne(r: WeekRule, ctx: PlanningContext): CompiledRule {
  return compileRules([r], ctx.recipes.values(), {
    ingredients: ctx.ingredients, region: ctx.region, month: ctx.month,
  })[0];
}

test('a rule counts only the meals it covers', () => {
  const ctx = planningContext();
  const quick = compileOne(weekRule({ subject: 'quick', minutes: 30, mealTypes: ['full'] }), ctx);

  const quickSnack = [...ctx.recipes.values()].find(
    (r) => r.mealType === 'snack' && r.prepMinutes + r.cookMinutes <= 30,
  )!;

  // Nearly every snack in the library is already under half an hour, which is
  // exactly why a rule that counted them would be met before it was written.
  assert.equal(countMatching([planSlot('snack-0', 'snack', quickSnack.id)], quick), 0);
});

test('at least and at most are short in opposite directions', () => {
  const ctx = planningContext();
  const pasta = [...ctx.recipes.values()]
    .filter((r) => r.mealType === 'full' && dishTypesOf(r, ctx.ingredients).includes('pasta'))
    .slice(0, 2);
  const slots = pasta.map((r, i) => planSlot(`full-${i}`, 'full', r.id));

  const atLeast = compileOne(
    weekRule({ subject: 'dish-type', dishType: 'pasta', comparison: 'at-least', count: 3 }), ctx);
  const atMost = compileOne(
    weekRule({ subject: 'dish-type', dishType: 'pasta', comparison: 'at-most', count: 1 }), ctx);

  assert.equal(shortfallOf(slots, atLeast), 1, 'two of the three asked for');
  assert.equal(shortfallOf(slots, atMost), 1, 'one over the cap');
  assert.equal(
    rulePenalty(slots, [atLeast, atMost]), 2,
    'the penalty is the sum of the shortfalls, not a count of broken rules',
  );
});

test('a rule the library cannot meet says so before the week does', () => {
  const ctx = planningContext();
  const impossible = compileOne(
    weekRule({ subject: 'ingredient', ingredientId: 'not-a-real-ingredient', count: 2 }), ctx);
  const [status] = evaluateRules([], [impossible]);

  assert.equal(status.available, 0);
  assert.equal(impossibleReason(status), 'Nothing in your library matches this.');
  // An "at most" rule is satisfied by a week with none of the thing in it, so an
  // empty library can never break one.
  assert.equal(
    impossibleReason({ ...status, rule: { ...status.rule, comparison: 'at-most' } }),
    null,
  );
});

test('switching what a rule is about brings a parameter with it', () => {
  // The bug this locks in: the dropdown showed "Pasta & noodles" while the rule
  // still meant "any kind of dish", so it was quietly satisfied by every meal.
  const switched = withSubject(weekRule({ subject: 'quick' }), 'dish-type');

  assert.equal(switched.dishType, 'pasta');
  assert.ok(isConfigured(switched));
  assert.equal(describeRule(switched), 'At least 2 full meals that are pasta or noodles');
});

test('an unfinished rule matches nothing rather than everything', () => {
  const ctx = planningContext();
  const unfinished = weekRule({ subject: 'ingredient', ingredientId: undefined });

  assert.ok(!isConfigured(unfinished));
  assert.equal(compileOne(unfinished, ctx).matches.size, 0, 'every recipe in the library matched');
});

test('a rule reads as the sentence it is', () => {
  assert.equal(
    describeRule(weekRule({ subject: 'quick', minutes: 30, count: 3, mealTypes: ['full'] })),
    'At least 3 full meals under 30 minutes',
  );
  assert.equal(
    describeRule(
      weekRule({ subject: 'ingredient', ingredientId: 'halloumi', count: 1, mealTypes: [] }),
      'Halloumi',
    ),
    'At least 1 meal with Halloumi',
  );
});

const RULE_WEEK: SlotSpec = {
  full: 5, light: 3, snack: 2, servingsPerMeal: { full: 4, light: 2, snack: 2 },
};

test('the planner builds a week around a rule', () => {
  const base = planningContext();
  const wanted = weekRule({ subject: 'region', region: 'mediterranean', count: 2, mealTypes: ['full'] });
  const rules = [compileOne(wanted, base)];

  const { plan } = generateWeekPlan({ ...base, rules }, { spec: RULE_WEEK, restarts: 2, seed: 31 });
  const [status] = evaluateRules(plan.slots, rules);

  assert.ok(status.satisfied, `asked for 2 Mediterranean dinners and got ${status.matched}`);
});

test('an at-most rule keeps out a thing the library is full of', () => {
  // The library is pasta-heavy, so a week chosen on cost alone is very likely to
  // contain some. This is the version of the pair that can actually fail.
  const base = planningContext();
  const none = weekRule({
    subject: 'dish-type', dishType: 'pasta', comparison: 'at-most', count: 0, mealTypes: ['full'],
  });
  const rules = [compileOne(none, base)];

  const { plan } = generateWeekPlan({ ...base, rules }, { spec: RULE_WEEK, restarts: 2, seed: 31 });
  const [status] = evaluateRules(plan.slots, rules);

  assert.equal(status.matched, 0, 'a full meal is still pasta');
});

test('no rules costs nothing', () => {
  // The term has to vanish rather than merely be small, or every plan scored
  // before rules existed would score differently now.
  assert.equal(rulePenalty([planSlot('full-0', 'full', 'anything')], []), 0);
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
