/**
 * End-to-end smoke run: import → filter → generate → grocery list.
 *
 * This exists to prove the domain layer actually works on real data, and to make
 * the scoring weights inspectable while they are being tuned. Run with:
 *
 *     npm run demo
 */

import { loadSeedData } from '../src/data/seed';
import { buildGroceryList, renderGroceryList } from '../src/domain/grocery';
import { FILTER_PRESETS, explainFilter } from '../src/domain/filters';
import { recipeNutrition } from '../src/domain/nutrition';
import { DEFAULT_REGION_ID, getRegion } from '../src/domain/seasonality';
import { generateWeekPlan, pickWildcards } from '../src/domain/planner/generate';
import type { PlanningContext } from '../src/domain/planner/scoring';
import type {
  Id, Ingredient, PantryItem, PlannerSettings, Recipe, SalePrice, SlotSpec, StapleItem,
} from '../src/domain/types';

const MONTH = 9; // September — peak BC harvest, so seasonality has something to say.

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m\n${'─'.repeat(text.length)}`);
}

// ---------------------------------------------------------------------------

heading('Import');

const seed = loadSeedData();
console.log(`ingredients: ${seed.ingredients.length}`);
console.log(`recipes:     ${seed.recipes.length}`);
console.log(`rejected:    ${seed.rejected.length}`);
console.log(`ok:          ${seed.ok}`);

for (const issue of seed.issues) {
  console.log(`  [${issue.severity}] ${issue.path}: ${issue.message}`);
}
for (const r of seed.rejected) {
  console.log(`  REJECTED ${r.name}: ${r.reasons.join('; ')}`);
}

const ingredients = new Map<Id, Ingredient>(seed.ingredients.map((i) => [i.id, i]));
const recipes = new Map<Id, Recipe>(seed.recipes.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------

const settings: PlannerSettings = {
  unitSystem: 'metric',
  regionId: DEFAULT_REGION_ID,
  diets: [],
  excludedIngredients: [],
  weeklyTimeBudgetMinutes: 240,
  repeatWindowWeeks: 3,
  wildcardCount: 4,
};

// Things bought every week regardless of the plan.
const staples: StapleItem[] = [
  { ingredientId: 'milk', grams: 2060, active: true },
  { ingredientId: 'bread', grams: 675, active: true },
];

// Things kept in stock. `stocked` items are free and unwasteable.
const pantry = new Map<Id, PantryItem>([
  ['salt', { ingredientId: 'salt', status: 'stocked', usesSincePurchase: 0 }],
  ['black-pepper', { ingredientId: 'black-pepper', status: 'stocked', usesSincePurchase: 0 }],
  ['olive-oil', { ingredientId: 'olive-oil', status: 'stocked', usesSincePurchase: 0 }],
  ['cumin', { ingredientId: 'cumin', status: 'stocked', usesSincePurchase: 0 }],
  ['curry-powder', { ingredientId: 'curry-powder', status: 'low', usesSincePurchase: 6 }],
]);

const sales = new Map<Id, SalePrice>([
  ['butternut-squash', { ingredientId: 'butternut-squash', costPerKg: 2.2, store: 'Demo Foods' }],
  ['chicken-thigh', { ingredientId: 'chicken-thigh', costPerKg: 9.9, store: 'Demo Foods' }],
]);

const ctx: PlanningContext = {
  ingredients,
  recipes,
  staples,
  pantry,
  sales,
  settings,
  recentlyUsed: new Map(),
  month: MONTH,
  region: getRegion(settings.regionId),
};

// ---------------------------------------------------------------------------

heading(`Filters (${ctx.region.name}, month ${MONTH})`);

for (const preset of FILTER_PRESETS) {
  const { matched, rejections } = explainFilter(recipes.values(), preset.filter, {
    ingredients, region: ctx.region, month: MONTH,
  });
  const why = [...rejections.entries()].map(([r, n]) => `${r} ${n}`).join(', ');
  console.log(`${preset.label.padEnd(24)} ${String(matched.length).padStart(2)} match   ${why}`);
}

heading('Nutrition (per serving, at base servings)');

const byProtein = [...recipes.values()]
  .map((r) => ({ r, n: recipeNutrition(r, ingredients) }))
  .sort((a, b) => b.n.proteinG - a.n.proteinG);

for (const { r, n } of byProtein.slice(0, 6)) {
  console.log(
    `${r.name.padEnd(40)} ${n.proteinG.toFixed(0).padStart(3)} g protein  ` +
    `${n.kcal.toFixed(0).padStart(4)} kcal  ${(n.proteinRatio * 100).toFixed(0).padStart(2)}% from protein  ` +
    `(coverage ${(n.coverage * 100).toFixed(0)}%)`,
  );
}

// ---------------------------------------------------------------------------

heading('Generated week');

const spec: SlotSpec = {
  full: 4,
  light: 3,
  snack: 3,
  servingsPerMeal: { full: 4, light: 2, snack: 2 },
};

const wildcards = pickWildcards(ctx, settings.wildcardCount, 42);
const result = generateWeekPlan(ctx, { spec, wildcards, seed: 12345 });

console.log(`candidates: ${result.candidateCount}   unfilled slots: ${result.unfilledSlots}`);
console.log();

for (const slot of result.plan.slots) {
  const recipe = slot.recipeId ? recipes.get(slot.recipeId) : null;
  const label = recipe ? recipe.name : '(empty)';
  console.log(`  ${slot.mealType.padEnd(6)} ${label.padEnd(42)} ×${slot.servings}`);
}

heading('Score');

const s = result.score;
console.log(`total          ${s.total.toFixed(2)}`);
console.log(`  waste        $${s.waste.toFixed(2)}   ← primary objective, lower is better`);
console.log(`  variety      ${s.variety.toFixed(2)}`);
console.log(`  season       ${(s.season * 100).toFixed(0)}%  of produce in season`);
console.log(`  sale saving  $${s.sale.toFixed(2)}`);
console.log(`  effort       ${s.effort.toFixed(0)} min over budget`);
console.log(`  repeat       ${s.repeat.toFixed(2)}`);

// ---------------------------------------------------------------------------

heading('Grocery list');

const list = buildGroceryList(result.plan, ctx);
const display = renderGroceryList(list, ctx, settings.unitSystem);

let category = '';
let totalLeftover = 0;
let totalWaste = 0;

for (const line of display) {
  if (line.category !== category) {
    category = line.category;
    console.log(`\n  ${category.toUpperCase()}`);
  }

  const flags = [
    line.fromStaples ? 'staple' : null,
    line.fromPantry ? 'pantry' : null,
    line.fromWildcard ? 'wildcard' : null,
  ].filter(Boolean).join(' ');

  totalLeftover += line.leftoverCost;
  totalWaste += line.wasteCost;

  console.log(
    `    ${line.name.padEnd(24)} ${line.buyText.padEnd(12)}` +
    `${line.needText ? `(need ${line.needText})`.padEnd(18) : ''.padEnd(18)}` +
    `${flags.padEnd(10)}${line.usedBy.slice(0, 2).join(', ')}`,
  );
}

console.log(
  `\n  ${display.length} lines · $${totalLeftover.toFixed(2)} surplus, of which ` +
  `$${totalWaste.toFixed(2)} is likely to actually spoil`,
);

const spoilage = display
  .filter((l) => l.wasteCost > 0.2)
  .sort((a, b) => b.wasteCost - a.wasteCost);

if (spoilage.length > 0) {
  console.log('\n  Most likely to be thrown out:');
  for (const line of spoilage.slice(0, 5)) {
    console.log(`    ${line.name.padEnd(24)} $${line.wasteCost.toFixed(2)}`);
  }
}

// ---------------------------------------------------------------------------

heading('Region switch: same seed, Ontario instead of BC');

const onCtx: PlanningContext = { ...ctx, region: getRegion('on-canada') };
const onResult = generateWeekPlan(onCtx, { spec, wildcards, seed: 12345 });
console.log(`BC season score: ${(result.score.season * 100).toFixed(0)}%`);
console.log(`ON season score: ${(onResult.score.season * 100).toFixed(0)}%`);
