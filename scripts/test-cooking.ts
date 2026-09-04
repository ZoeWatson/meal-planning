/**
 * Cooking, leftovers and meal-log tests.
 *
 * The keeping-time rules are the part worth testing hardest — they are the only
 * place in the app that makes a food-safety-shaped claim, and the failure mode is
 * telling someone their rice is fine on Thursday.
 *
 * Run with: npm run test:cooking
 */

import assert from 'node:assert/strict';

import {
  addDays, availableIngredients, estimateKeeping, freshness, isActive, localDate,
  matchFromPantry, summariseWeek, weekStart,
  type Leftover, type MealLogEntry,
} from '../src/domain/cooking';
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

const seed = loadSeedData();
const seedIngredients = new Map<Id, Ingredient>(seed.ingredients.map((i) => [i.id, i]));
const seedRecipes = new Map<Id, Recipe>(seed.recipes.map((r) => [r.id, r]));

function recipeWith(ingredientIds: string[]): Recipe {
  return {
    id: 'r', name: 'R', mealType: 'full', baseServings: 4,
    ingredients: ingredientIds.map((id) => ({
      ingredientId: id, quantity: 1, unit: 'g', grams: 100,
      optional: false, scaling: 'linear' as const,
    })),
    steps: [], prepMinutes: 0, cookMinutes: 0, tags: [], diets: [], builtIn: true,
  };
}

// ---------------------------------------------------------------------------

group('Keeping times');

test('an ordinary cooked dish keeps 3 days', () => {
  const rule = estimateKeeping(recipeWith(['potato', 'carrot']), seedIngredients, 'fridge');
  assert.equal(rule.days, 3);
});

test('rice cuts it to a single day', () => {
  // The one everyday case where the usual 3-4 days is wrong: Bacillus cereus
  // survives cooking and multiplies as rice cools.
  const rule = estimateKeeping(recipeWith(['long-grain-rice', 'carrot']), seedIngredients, 'fridge');
  assert.equal(rule.days, 1);
  assert.match(rule.reason, /rice/i);
});

test('arborio counts as rice too', () => {
  assert.equal(estimateKeeping(recipeWith(['arborio-rice']), seedIngredients, 'fridge').days, 1);
});

test('seafood keeps 2 days', () => {
  assert.equal(estimateKeeping(recipeWith(['salmon-fillet']), seedIngredients, 'fridge').days, 2);
});

test('the SHORTEST rule wins, not the last one matched', () => {
  // Chicken and rice together must take rice's day, not chicken's three. Getting
  // this backwards is the whole reason the rules are a minimum rather than a
  // lookup.
  const rule = estimateKeeping(
    recipeWith(['chicken-thigh', 'long-grain-rice']), seedIngredients, 'fridge',
  );
  assert.equal(rule.days, 1);
});

test('order of ingredients does not change the answer', () => {
  const a = estimateKeeping(recipeWith(['long-grain-rice', 'salmon-fillet']), seedIngredients, 'fridge');
  const b = estimateKeeping(recipeWith(['salmon-fillet', 'long-grain-rice']), seedIngredients, 'fridge');
  assert.equal(a.days, b.days);
  assert.equal(a.days, 1);
});

test('the freezer is measured in months', () => {
  assert.equal(estimateKeeping(recipeWith(['long-grain-rice']), seedIngredients, 'freezer').days, 90);
});

test('unknown ingredients fall back to the default rather than throwing', () => {
  assert.equal(estimateKeeping(recipeWith(['nonexistent']), seedIngredients, 'fridge').days, 3);
});

test('every seed recipe gets a usable window', () => {
  for (const recipe of seedRecipes.values()) {
    const rule = estimateKeeping(recipe, seedIngredients, 'fridge');
    assert.ok(rule.days >= 1 && rule.days <= 4, `${recipe.id}: ${rule.days} days`);
    assert.ok(rule.reason.length > 0, `${recipe.id} has no reason`);
  }
});

group('Freshness');

test('counts down to the use-by date', () => {
  assert.equal(freshness('2026-09-10', '2026-09-07').label, '3 days left');
  assert.equal(freshness('2026-09-08', '2026-09-07').label, 'Use tomorrow');
  assert.equal(freshness('2026-09-07', '2026-09-07').label, 'Use today');
});

test('past the date is reported as past, not as zero', () => {
  assert.equal(freshness('2026-09-06', '2026-09-07').state, 'past');
  assert.equal(freshness('2026-09-06', '2026-09-07').label, 'A day past');
  assert.equal(freshness('2026-09-04', '2026-09-07').label, '3 days past');
});

test('crosses a month boundary correctly', () => {
  assert.equal(freshness('2026-10-02', '2026-09-30').daysLeft, 2);
});

test('crosses a year boundary correctly', () => {
  assert.equal(freshness('2027-01-01', '2026-12-30').daysLeft, 2);
});

test('date arithmetic stays local, not UTC', () => {
  // toISOString on a late-evening local date rolls into the next day west of UTC,
  // which would put a use-by date a day early or late.
  const lateEvening = new Date(2026, 8, 30, 23, 45);
  assert.equal(localDate(lateEvening), '2026-09-30');
  assert.equal(addDays('2026-09-30', 3), '2026-10-03');
});

group('Leftover lifecycle');

function leftover(patch: Partial<Leftover> = {}): Leftover {
  return {
    id: 'l1', cookedMealId: 'c1', recipeId: 'r', label: 'Stew',
    servingsRemaining: 2, storedAtISO: '2026-09-01', storage: 'fridge',
    useByISO: '2026-09-04', ...patch,
  };
}

test('a leftover with portions left is active', () => {
  assert.equal(isActive(leftover()), true);
});

test('an emptied leftover is not', () => {
  assert.equal(isActive(leftover({ servingsRemaining: 0 })), false);
});

test('a closed leftover is not, even with portions recorded', () => {
  // Thrown out with food still in the tub. It must leave the fridge view.
  assert.equal(isActive(leftover({ closedAtISO: '2026-09-03', discarded: true })), false);
});

group('Cook from what you have');

test('recipes you can fully make come first', () => {
  const available = new Set(['potato', 'carrot', 'yellow-onion']);
  const matches = matchFromPantry([
    recipeWith(['potato', 'carrot', 'chicken-thigh']),
    { ...recipeWith(['potato', 'carrot']), id: 'ready' },
  ], available);

  assert.equal(matches[0].recipe.id, "ready");
  assert.equal(matches[0].missingIds.length, 0);
});

test('missing ingredients are named', () => {
  const matches = matchFromPantry([recipeWith(['potato', 'garlic'])], new Set(['potato']));
  assert.deepEqual(matches[0].missingIds, ['garlic']);
  assert.equal(matches[0].coverage, 0.5);
});

test('recipes missing too much are dropped', () => {
  const matches = matchFromPantry(
    [recipeWith(['a', 'b', 'c', 'd', 'e'])], new Set(['a']), { maxMissing: 3 },
  );
  assert.equal(matches.length, 0);
});

test('optional ingredients never count as missing', () => {
  // Being told a dish is "missing" its garnish is noise, and would push genuinely
  // cookable recipes down the list.
  const recipe: Recipe = {
    ...recipeWith(['potato']),
    ingredients: [
      { ingredientId: 'potato', quantity: 1, unit: 'g', grams: 100, optional: false, scaling: 'linear' },
      { ingredientId: 'parsley', quantity: 1, unit: 'g', grams: 5, optional: true, scaling: 'linear' },
    ],
  };
  const matches = matchFromPantry([recipe], new Set(['potato']));
  assert.equal(matches[0].missingIds.length, 0);
  assert.equal(matches[0].coverage, 1);
});

test('available set draws from all four sources', () => {
  const available = availableIngredients({
    pantryStocked: ['salt'],
    carriedOver: ['long-grain-rice'],
    purchased: ['chicken-thigh'],
    staples: ['milk'],
  });
  assert.equal(available.size, 4);
  // Ticked-off shopping is the source that makes this useful mid-week.
  assert.ok(available.has('chicken-thigh'));
});

group('The week log');

function entry(dateISO: string, source: MealLogEntry['source'], servings = 1): MealLogEntry {
  return {
    id: `${dateISO}-${source}-${Math.random()}`, dateISO, mealType: 'full',
    source, label: 'x', servings, createdAtISO: '',
  };
}

test('weeks start on Monday', () => {
  assert.equal(weekStart(new Date(2026, 8, 3)), '2026-08-31'); // Thu 3 Sep -> Mon 31 Aug
  assert.equal(weekStart(new Date(2026, 8, 7)), '2026-09-07'); // Mon is its own start
  assert.equal(weekStart(new Date(2026, 8, 6)), '2026-08-31'); // Sunday belongs to the week before
});

test('always returns seven days, including empty ones', () => {
  // A list of only the days you remembered to log looks like a complete record.
  const week = summariseWeek([entry('2026-09-07', 'cooked')], '2026-09-07', '2026-09-09');
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].entries.length, 1);
  assert.equal(week.days[1].entries.length, 0);
});

test('counts gaps only up to today, not into the future', () => {
  const week = summariseWeek([entry('2026-09-07', 'cooked')], '2026-09-07', '2026-09-09');
  assert.equal(week.daysWithNothing, 2, 'the 8th and 9th; the rest has not happened');
});

test('splits by source', () => {
  const week = summariseWeek([
    entry('2026-09-07', 'cooked'), entry('2026-09-07', 'leftover'), entry('2026-09-08', 'out'),
  ], '2026-09-07', '2026-09-13');
  assert.equal(week.bySource.cooked, 1);
  assert.equal(week.bySource.leftover, 1);
  assert.equal(week.bySource.out, 1);
});

test('home-cooked share counts leftovers as home cooking', () => {
  const week = summariseWeek([
    entry('2026-09-07', 'cooked'), entry('2026-09-07', 'leftover'),
    entry('2026-09-08', 'out'), entry('2026-09-08', 'out'),
  ], '2026-09-07', '2026-09-13');
  assert.equal(week.homeCookedShare, 0.5);
});

test('an empty week does not divide by zero', () => {
  const week = summariseWeek([], '2026-09-07', '2026-09-13');
  assert.equal(week.homeCookedShare, 0);
  assert.equal(week.totalEntries, 0);
});

test('servings are totalled per day', () => {
  const week = summariseWeek([
    entry('2026-09-07', 'cooked', 2), entry('2026-09-07', 'leftover', 3),
  ], '2026-09-07', '2026-09-13');
  assert.equal(week.days[0].servings, 5);
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
