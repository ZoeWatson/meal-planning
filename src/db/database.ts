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
import type { Change, SyncedCollection } from '../domain/sync/types';
import type { BarcodeEntry, CustomItem, Expense } from '../domain/budget';
import type { CookedMeal, Leftover, MealLogEntry } from '../domain/cooking';

/** A single ticked box, keyed by plan and by whatever is being ticked. */
export interface GroceryCheck {
  /** `${planId}:${ingredientId}` */
  readonly id: string;
  readonly planId: Id;
  /**
   * What was ticked: an ingredient for a planned line, a treat id for a line
   * from the treat bag.
   *
   * One table rather than two, because ticking is ticking — it is the same
   * gesture in the same aisle, and the reason this table exists at all (one small
   * record per line, so two devices merge last-write-wins on a boolean instead of
   * fighting over a whole plan) applies identically to both.
   */
  readonly ingredientId: Id;
  readonly checked: boolean;
  /**
   * What this line actually cost, in cents. Entered at the shelf or the till.
   *
   * Lives on the check rather than in its own table because it is the same unit
   * of work — one line of one shop — and reusing the record means one sync entry
   * per line instead of two racing each other.
   */
  readonly amountCents?: number;
  /** The field sync reconciles last-write-wins. */
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
  /** Monthly food budget in cents. Null means no goal set. */
  readonly monthlyBudgetCents: number | null;
  /** ISO 4217 code, used only for formatting. No conversion happens anywhere. */
  readonly currency: string;
  /** Whether eating out counts toward the monthly goal. */
  readonly budgetIncludesDining: boolean;
  /** Days between shopping trips. Feeds the waste model's survival horizon. */
  readonly cycleDays: number;
  readonly activePlanId: Id | null;
  /** Bumped by seeding so a library refresh can be detected later. */
  readonly seedVersion: number;
}

/**
 * Sync bookkeeping for one record, kept in its own table rather than on the
 * record itself.
 *
 * Two reasons. Domain types stay free of `_hlc` and `_deleted` fields that mean
 * nothing to the planner — and tombstones become natural: a deleted record is
 * genuinely gone from its table, with only a small marker left behind, instead of
 * every table needing filtering to hide soft-deleted rows from ordinary queries.
 */
export interface RecordMeta {
  /** `${collection}:${id}` */
  readonly key: string;
  readonly collection: SyncedCollection;
  readonly id: string;
  /** Serialised HLC of the last write. */
  readonly hlc: string;
  readonly deleted?: boolean;
  /** Per-field stamps, settings only — see `mergeSettings`. */
  readonly fieldHlc?: Record<string, string>;
}

/** A local change waiting to be pushed. Survives restarts; drains when online. */
export interface OutboxEntry extends Change {
  readonly localSeq?: number;
}

/** Device-level sync state. Single row. */
export interface SyncMeta {
  readonly id: 'sync';
  /** Stable per-device id, also the HLC tie-breaker. */
  readonly deviceId: string;
  readonly hlcPhysical: number;
  readonly hlcCounter: number;
  /** Namespace on the server. Null until this device is linked. */
  readonly spaceId: string | null;
  readonly serverUrl: string | null;
  /** Highest server sequence this device has pulled. */
  readonly lastPulledSeq: number;
  readonly lastSyncedAtISO: string | null;
  readonly lastError: string | null;
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

  expenses!: Table<Expense, string>;
  customItems!: Table<CustomItem, string>;
  barcodes!: Table<BarcodeEntry, string>;

  cookedMeals!: Table<CookedMeal, string>;
  leftovers!: Table<Leftover, string>;
  mealLog!: Table<MealLogEntry, string>;

  recordMeta!: Table<RecordMeta, string>;
  outbox!: Table<OutboxEntry, number>;
  syncMeta!: Table<SyncMeta, string>;

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

    this.version(2).stores({
      recordMeta: 'key, collection, hlc',
      outbox: '++localSeq, collection, id',
      syncMeta: 'id',
    });
    // Existing rows deliberately get no meta here. They are stamped on first link
    // by `enqueueEverything`, which needs a clock that does not exist yet at
    // migration time — and stamping them now would mean a device that never syncs
    // pays for bookkeeping it never uses.

    this.version(3).stores({
      // `dateISO` indexed because every budget query is "this month".
      expenses: 'id, dateISO, kind, planId',
      customItems: 'id, planId',
      barcodes: 'barcode',
    });

    this.version(4).stores({
      cookedMeals: 'id, recipeId, cookedAtISO, planId',
      // `useByISO` indexed because the fridge view is always "what expires next".
      leftovers: 'id, cookedMealId, useByISO, closedAtISO',
      // `dateISO` indexed because the log is always read a week at a time.
      mealLog: 'id, dateISO, source, recipeId',
    });
  }
}

export const db = new MealPlanningDatabase();

export const DEFAULT_SETTINGS: Omit<AppSettings, 'id'> = {
  unitSystem: 'metric',
  regionId: 'bc-canada',
  diets: [],
  allergens: [],
  excludedIngredients: [],
  weeklyTimeBudgetMinutes: 300,
  repeatWindowWeeks: 3,
  // No rules to begin with. A rule is a household saying what it wants out of a
  // week, and there is no default answer to that — a shipped one would just be
  // this app's opinion about somebody else's dinners.
  weekRules: [],
  produceBagEnabled: true,
  wildcardCount: 6,
  wildcardSplit: false,
  wildcardFruitCount: 2,
  wildcardVegCount: 4,
  // The three dry-shelf bags ship ON. They are the feature, and a feature that
  // arrives switched off is a feature nobody finds. The sizes are small on
  // purpose: one loaf, one box of pasta and one cheese is a week's worth of
  // "something different", and the point of these bags is variety rather than
  // volume. Two breads because bread freezes, so the second one costs nothing
  // if it is not eaten.
  breadBagEnabled: true,
  breadBagCount: 2,
  pastaBagEnabled: true,
  pastaBagCount: 1,
  cheeseBagEnabled: true,
  cheeseBagCount: 1,
  // Three, so the default bag is exactly one of each kind — a tea, something to
  // eat, and something that is not food.
  treatBagEnabled: true,
  treatCount: 3,
  cycleDays: 7,
  monthlyBudgetCents: null,
  currency: 'CAD',
  budgetIncludesDining: true,
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
 * MUST be incremented whenever `src/data/seed-*.json` changes — AND whenever the
 * importer starts carrying a field it previously dropped. Both change what ends
 * up in the database; only the first is obvious.
 *
 * Existing installs otherwise keep the old library indefinitely and quietly
 * diverge from the source file, which looks exactly like a code bug and is very
 * hard to spot from the outside.
 *
 * 2: added `pinch`/`dash` count units to salt and pepper (so "salt to taste"
 *    parses), and split long-grain rice out from arborio.
 * 3: declared allergens across the library.
 * 4: the importer was silently dropping `allergens` when 3 was seeded, so every
 *    device that took 3 has the data missing. Reseed.
 * 5: added 100 vegetarian recipes and the 118 ingredients they need, and made
 *    every milk-containing ingredient exclude `dairy-free` — cheese was only
 *    excluding `vegan`, so a parmesan pasta was being reported as dairy-free.
 * 6: a second 100 vegetarian recipes, and the 38 ingredients they need.
 * 7: the bakery, pasta and cheese shelves, for the three new grab bags — 26
 *    breads, 24 pastas and 26 cheeses. `spaghetti` and `penne` stopped being
 *    aliases of generic `pasta` in the same pass, because they are now
 *    ingredients of their own; any recipe asking for either resolves to the
 *    specific shape from here on.
 * 8: a third 100 vegetarian recipes, and the 21 ingredients they need.
 * 9: recipe variants, and 100 recipes that use them — 62 Japanese, and 38
 *    attached to dishes the library already had. Recipes gained `variantOf`,
 *    so a reseed is what puts the families on an existing device.
 * 10: 101 more vegetarian recipes, 71 of them variants, most of them pasta —
 *    plus broccoli rabe, dried porcini and ricotta salata, the three
 *    ingredients they needed that the library did not have.
 */
export const SEED_VERSION = 10;

export type { GroceryList };
