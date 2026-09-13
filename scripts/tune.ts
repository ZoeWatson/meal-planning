/**
 * Waste model tuning harness.
 *
 * Three questions, in order of importance:
 *
 *   1. Does the risk curve assign sensible numbers to real ingredients?
 *   2. Did the retune actually fix the two known failures (yogurt, chicken)?
 *   3. Does the optimizer beat random selection? — if it does not, the entire
 *      objective function is theatre and the model is worthless however elegant.
 *
 * Run with: npm run tune
 */

import { loadSeedData } from '../src/data/seed';
import { getRegion, DEFAULT_REGION_ID } from '../src/domain/seasonality';
import { DEFAULT_WASTE_SETTINGS, analyzeSurplus, carryOverOf, spoilRisk } from '../src/domain/waste';
import { generateWeekPlan } from '../src/domain/planner/generate';
import {
  type PlanningContext, WASTE_ONLY_WEIGHTS, aggregateNeeds, resolveAllPurchases, scorePlan,
} from '../src/domain/planner/scoring';
import type {
  Id, Ingredient, PantryItem, PlanSlot, PlannerSettings, Recipe, SalePrice, SlotSpec, StapleItem,
} from '../src/domain/types';

const MONTH = 9;

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m\n${'─'.repeat(text.length)}`);
}

const seed = loadSeedData();
const ingredients = new Map<Id, Ingredient>(seed.ingredients.map((i) => [i.id, i]));
const recipes = new Map<Id, Recipe>(seed.recipes.map((r) => [r.id, r]));

const settings: PlannerSettings = {
  unitSystem: 'metric',
  regionId: DEFAULT_REGION_ID,
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
  breadBagEnabled: true,
  breadBagCount: 2,
  pastaBagEnabled: true,
  pastaBagCount: 1,
  cheeseBagEnabled: true,
  cheeseBagCount: 1,
  treatBagEnabled: true,
  treatCount: 3,
};

const staples: StapleItem[] = [
  { ingredientId: 'milk', grams: 2060, active: true },
  { ingredientId: 'bread', grams: 675, active: true },
];

const pantry = new Map<Id, PantryItem>([
  ['salt', { ingredientId: 'salt', status: 'stocked', usesSincePurchase: 0 }],
  ['black-pepper', { ingredientId: 'black-pepper', status: 'stocked', usesSincePurchase: 0 }],
  ['olive-oil', { ingredientId: 'olive-oil', status: 'stocked', usesSincePurchase: 0 }],
  ['cumin', { ingredientId: 'cumin', status: 'stocked', usesSincePurchase: 0 }],
]);

const sales = new Map<Id, SalePrice>([
  ['butternut-squash', { ingredientId: 'butternut-squash', costPerKg: 2.2 }],
  ['chicken-thigh', { ingredientId: 'chicken-thigh', costPerKg: 9.9 }],
]);

const ctx: PlanningContext = {
  ingredients, recipes, staples, pantry, sales, settings,
  recentlyUsed: new Map(),
  month: MONTH,
  region: getRegion(settings.regionId),
};

// ---------------------------------------------------------------------------
// 1. The risk curve
// ---------------------------------------------------------------------------

heading('Spoil risk by ingredient (7-day shopping cycle)');
console.log('  old = exp(-shelfLife/10), the first-pass model this replaces\n');
console.log(`  ${'ingredient'.padEnd(22)}${'carry'.padEnd(9)}${'shelf'.padStart(6)}${'old'.padStart(8)}${'new'.padStart(8)}`);

const sorted = [...ingredients.values()].sort((a, b) => spoilRisk(b) - spoilRisk(a));
for (const ing of sorted.slice(0, 14)) {
  const old = Math.exp(-ing.shelfLifeDays / 10);
  console.log(
    `  ${ing.name.padEnd(22)}${carryOverOf(ing).padEnd(9)}` +
    `${`${ing.shelfLifeDays}d`.padStart(6)}${old.toFixed(2).padStart(8)}${spoilRisk(ing).toFixed(2).padStart(8)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. The two known failures
// ---------------------------------------------------------------------------

heading('Regression check: the two cases that motivated the retune');

const cases: Array<{ id: Id; needed: number; note: string }> = [
  { id: 'greek-yogurt', needed: 60, note: 'you eat the rest of the tub' },
  { id: 'chicken-thigh', needed: 800, note: 'the extra 200 g goes in the freezer' },
  { id: 'kale', needed: 140, note: 'genuine waste — this should stay expensive' },
  { id: 'parsley', needed: 26, note: 'genuine waste — the classic half-bunch' },
  { id: 'arborio-rice', needed: 320, note: 'shelf-stable, carries to next week' },
];

for (const c of cases) {
  const ing = ingredients.get(c.id)!;
  const costPerKg = sales.get(c.id)?.costPerKg ?? ing.purchase.costPerKg;
  const packs = Math.max(1, Math.ceil(c.needed / ing.purchase.gramsPerPack));
  const leftover = packs * ing.purchase.gramsPerPack - c.needed;

  const oldWaste = (leftover / 1000) * costPerKg * Math.exp(-ing.shelfLifeDays / 10);
  const s = analyzeSurplus(leftover, ing, costPerKg);

  console.log(
    `\n  ${ing.name} — need ${c.needed} g, buy ${packs} × ${ing.purchase.gramsPerPack} g`,
  );
  console.log(`    surplus       ${leftover.toFixed(0)} g ($${s.surplusValue.toFixed(2)} retail)`);
  console.log(`    eaten anyway  ${s.absorbedGrams.toFixed(0)} g`);
  console.log(`    at risk       ${s.atRiskGrams.toFixed(0)} g × ${s.spoilRisk.toFixed(2)} risk`);
  console.log(`    waste  old $${oldWaste.toFixed(2)}  →  new $${s.wasteCost.toFixed(2)}   (${c.note})`);
}

// ---------------------------------------------------------------------------
// 3. Does the optimizer earn its keep?
// ---------------------------------------------------------------------------

heading('Optimizer vs. random selection');

const spec: SlotSpec = {
  full: 4, light: 3, snack: 3,
  servingsPerMeal: { full: 4, light: 2, snack: 2 },
};

function randomPlan(seedValue: number): PlanSlot[] {
  let a = seedValue >>> 0;
  const rng = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const slots: PlanSlot[] = [];
  const used = new Set<Id>();

  for (const [mealType, count] of [['full', spec.full], ['light', spec.light], ['snack', spec.snack]] as const) {
    const pool = [...recipes.values()].filter((r) => r.mealType === mealType);
    for (let i = 0; i < count; i++) {
      const available = pool.filter((r) => !used.has(r.id));
      if (available.length === 0) continue;
      const pick = available[Math.floor(rng() * available.length)];
      used.add(pick.id);
      slots.push({
        id: `${mealType}-${i}`, mealType, recipeId: pick.id,
        servings: spec.servingsPerMeal[mealType], pinned: false,
      });
    }
  }

  return slots;
}

const TRIALS = 400;
const samples = Array.from({ length: TRIALS }, (_, i) => randomPlan(i * 2654435761));

/**
 * How big is the space we are sampling?
 *
 * This matters enormously for interpreting the result below. With a 15-recipe
 * library there are only a few hundred distinct weeks, so 400 random draws is
 * close to exhaustive and "beats the best random draw" mostly proves the search
 * is not broken. It says nothing about how the same algorithm behaves at 500
 * recipes, where the space is astronomically larger and greedy + local search is
 * genuinely approximating rather than effectively enumerating.
 */
function choose(n: number, k: number): number {
  if (k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

const poolSizes = {
  full: [...recipes.values()].filter((r) => r.mealType === 'full').length,
  light: [...recipes.values()].filter((r) => r.mealType === 'light').length,
  snack: [...recipes.values()].filter((r) => r.mealType === 'snack').length,
};
const searchSpace =
  choose(poolSizes.full, spec.full) *
  choose(poolSizes.light, spec.light) *
  choose(poolSizes.snack, spec.snack);

console.log(`  search space: ${searchSpace.toLocaleString()} distinct weeks from ${recipes.size} recipes`);
console.log(
  searchSpace <= TRIALS * 5
    ? `  ⚠ ${TRIALS} random draws is near-exhaustive here — this validates correctness, NOT scaling\n`
    : `  ${TRIALS} random draws samples ${((TRIALS / searchSpace) * 100).toFixed(4)}% of the space\n`,
);

function stats(values: number[]): { mean: number; median: number; best: number; worst: number } {
  const s = [...values].sort((a, b) => a - b);
  return {
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    median: s[Math.floor(s.length / 2)],
    best: s[0],
    worst: s[s.length - 1],
  };
}

// Two comparisons, because they answer different questions.
//
//   A. Does the SEARCH work? Optimize waste alone and check it reaches the best
//      random draw. If it cannot, the algorithm is broken and no amount of weight
//      tuning will save it.
//
//   B. Does the DEFAULT objective work? Compare full score to full score. This is
//      the honest measure of the shipped configuration, and comparing an
//      optimized total against a random plan's waste — as the first version of
//      this harness did — is not a comparison at all.

const wasteOnlyRandom = stats(samples.map((s) => scorePlan(s, [], ctx, WASTE_ONLY_WEIGHTS).waste));
const totalRandom = stats(samples.map((s) => scorePlan(s, [], ctx).total));

const t0 = performance.now();
const wasteOnly = generateWeekPlan(ctx, { spec, wildcards: [], seed: 12345, weights: WASTE_ONLY_WEIGHTS });
const optimized = generateWeekPlan(ctx, { spec, wildcards: [], seed: 12345 });
const elapsed = performance.now() - t0;

console.log('  A. Search quality — waste as the only objective');
console.log(`     random:    best $${wasteOnlyRandom.best.toFixed(2)}   mean $${wasteOnlyRandom.mean.toFixed(2)}   worst $${wasteOnlyRandom.worst.toFixed(2)}`);
console.log(`     optimized: $${wasteOnly.score.waste.toFixed(2)}`);
console.log(
  wasteOnly.score.waste <= wasteOnlyRandom.best + 1e-9
    ? '     ✓ matches or beats the best of 400 random draws'
    : `     ✗ did NOT reach the best random draw ($${wasteOnlyRandom.best.toFixed(2)})`,
);

console.log('\n  B. Shipped objective — full score, like for like');
console.log(`     random:    best ${totalRandom.best.toFixed(2)}   mean ${totalRandom.mean.toFixed(2)}   worst ${totalRandom.worst.toFixed(2)}`);
console.log(`     optimized: ${optimized.score.total.toFixed(2)}`);
console.log(
  optimized.score.total <= totalRandom.best + 1e-9
    ? '     ✓ matches or beats the best of 400 random draws'
    : `     ✗ did NOT reach the best random draw (${totalRandom.best.toFixed(2)})`,
);

console.log(`\n  waste under the shipped objective: $${optimized.score.waste.toFixed(2)} ` +
  `(vs $${wasteOnlyRandom.mean.toFixed(2)} random mean, ` +
  `$${wasteOnly.score.waste.toFixed(2)} if waste were all that mattered)`);
console.log(`  both runs: ${elapsed.toFixed(0)} ms`);

// ---------------------------------------------------------------------------
// 4. Where the remaining waste actually is
// ---------------------------------------------------------------------------

heading('Remaining waste in the optimized plan');

const needs = aggregateNeeds(optimized.plan.slots, [], ctx);
const purchases = resolveAllPurchases(needs, ctx);

const ranked = [...purchases.entries()]
  .map(([id, p]) => ({ ing: ingredients.get(id)!, p }))
  .filter((r) => r.p.wasteCost > 0.01)
  .sort((a, b) => b.p.wasteCost - a.p.wasteCost);

let total = 0;
for (const { ing, p } of ranked) {
  total += p.wasteCost;
  console.log(
    `  ${ing.name.padEnd(24)}$${p.wasteCost.toFixed(2).padStart(5)}   ` +
    `${p.leftoverGrams.toFixed(0)} g surplus, ${p.absorbedGrams.toFixed(0)} g eaten anyway`,
  );
}
console.log(`\n  total $${total.toFixed(2)}  ·  spend $${optimized.score.spend.toFixed(2)}`);
console.log(`  waste is ${((total / optimized.score.spend) * 100).toFixed(1)}% of spend`);

// ---------------------------------------------------------------------------
// 5. Sensitivity: does the cycle length matter?
// ---------------------------------------------------------------------------

heading('Sensitivity to shopping cycle');

for (const cycleDays of [3, 5, 7, 10, 14]) {
  const alt: PlanningContext = {
    ...ctx,
    wasteSettings: { ...DEFAULT_WASTE_SETTINGS, cycleDays },
  };
  const r = generateWeekPlan(alt, { spec, wildcards: [], seed: 12345 });
  const differs = r.plan.slots.map((s) => s.recipeId).join() !==
    optimized.plan.slots.map((s) => s.recipeId).join();
  console.log(
    `  ${String(cycleDays).padStart(2)}-day cycle   waste $${r.score.waste.toFixed(2)}` +
    `   ${differs ? 'different plan' : 'same plan'}`,
  );
}
