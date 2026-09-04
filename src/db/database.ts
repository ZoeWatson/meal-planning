/**
 * IndexedDB schema.
 *
 * The design principle here is that almost nothing is stored — it is derived.
 * The grocery list, plan nutrition, waste figures and filter results are all
 * computed from the plan plus the library, every time.
 *
 * The exception is `checks`: which boxes are ticked. That is the one piece of
 * state created by a human standing in an aisle, and it is the only thing two
 * devices can ever genuinely disagree about. Keeping it in its own table with its
 * own timestamp is what will make sync a last-write-wins merge on a handful of
 * booleans rather than a conflict resolution problem over whole documents.
 */

import Dexie, { type Table } from 'dexie';
import type {
  GroceryList, Id, Ingredient, PantryItem, Recipe, SalePrice, SlotSpec,
  PlannerSettings, StapleItem, WeekPlan,
} from '../domain/types';

/** A single ticked box, keyed by plan and ingredient. */
export interface GroceryCheck {
  /** `${planId}:${ingredientId}` */
  readonly id: string;
  readonly planId: Id;
  readonly ingredientId: Id;
  readonly checked: boolean;
  /** The field a future sync will reconcile last-write-wins. */
  readonly updatedAtISO: string;
}

/** Non-perishable stock surviving from previous weeks, reducing what must be bought. */
export interface CarryOverEntry {
  readonly ingredientId: Id;
  readonly grams: number;
  readonly updatedAtISO: string;
}

export interface AppSettings extends PlannerSettings {
  readonly id: 'settings';
  readonly spec: SlotSpec;
  /** Days between shopping trips. Feeds the waste model's survival horizon. */
  readonly cycleDays: number;
  readonly activePlanId: Id | null;
  /** Bumped by seeding so a library refresh can be detected later. */
  readonly seedVersion: number;
}

export class MealPlanningDatabase extends Dexie {
  ingredients!: Table<Ingredient, string>;
  recipes!: Table<Recipe, string>;
  plans!: Table<WeekPlan, string>;
  checks!: Table<GroceryCheck, string>;
  staples!: Table<StapleItem, string>;
  pantry!: Table<PantryItem, string>;
  sales!: Table<SalePrice, string>;
  carryOver!: Table<CarryOverEntry, string>;
  settings!: Table<AppSettings, string>;

  constructor() {
    super('meal-planning');
    this.version(1).stores({
      ingredients: 'id, category, name',
      recipes: 'id, mealType, name, builtIn',
      plans: 'id, weekStartISO, generatedAtISO',
      checks: 'id, planId, ingredientId',
      staples: 'ingredientId, active',
      pantry: 'ingredientId, status',
      sales: 'ingredientId',
      carryOver: 'ingredientId',
      settings: 'id',
    });
  }
}

export const db = new MealPlanningDatabase();

export const DEFAULT_SETTINGS: Omit<AppSettings, 'id'> = {
  unitSystem: 'metric',
  regionId: 'bc-canada',
  diets: [],
  excludedIngredients: [],
  weeklyTimeBudgetMinutes: 300,
  repeatWindowWeeks: 3,
  wildcardCount: 6,
  cycleDays: 7,
  spec: {
    full: 5,
    light: 5,
    snack: 4,
    servingsPerMeal: { full: 4, light: 2, snack: 2 },
  },
  activePlanId: null,
  seedVersion: 0,
};

/**
 * Bump to force the built-in library to be reloaded on next start.
 *
 * MUST be incremented whenever `src/data/seed-*.json` changes, or existing
 * installs keep the old library indefinitely and quietly diverge from the source
 * file — which looks exactly like a code bug and is very hard to spot.
 *
 * 2: added `pinch`/`dash` count units to salt and pepper (so "salt to taste"
 *    parses), and split long-grain rice out from arborio.
 */
export const SEED_VERSION = 2;

export type { GroceryList };
