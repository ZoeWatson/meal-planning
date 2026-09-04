# Meal Planning

A weekly meal planner that picks meals which **share ingredients**, so nothing is
bought for a single recipe and left to rot — and the grocery list to match.

Offline-first and phone-first: generate a plan on a laptop, tick the list off in a
supermarket with no signal, and it catches up when you reconnect.

```bash
npm install
npm run dev            # the app
npm run sync-server    # optional, for syncing between devices
```

## What it does

- **Waste-minimising plans.** Meals are chosen to minimise the money you throw
  away, not to maximise ingredient overlap — those come apart constantly, and only
  one of them is the thing you actually care about.
- **Meal types.** Full meals, light meals and snacks. Light meals and snacks are
  filled last, deliberately, so they can mop up what the full meals leave behind.
- **Portions per recipe**, adjustable per slot.
- **Filters** — vegetarian, high protein (computed from ingredients, not tagged),
  cooking time, in-season, ingredient count.
- **Regional seasonality** — BC and Ontario ship; the picker is in Settings.
- **Allergies.** Group-level (tree nuts, milk, wheat…) rather than per ingredient,
  with name inference as a backstop for imported data. Removed from plans and the
  shopping list, and flagged loudly wherever a recipe could still slip through.
- **Weekly staples** always on the list, and a **pantry** whose stocked items are
  treated as free.
- **A produce grab bag** of random in-season items, as the antidote to cooking the
  same eight things forever.
- **Metric and imperial**, toggled at display time.
- **Bulk import** with a prose-line parser, and export as backup.
- **Sync** between devices, last-write-wins over hybrid logical clocks.
- **Spending tracker.** Price items at the shelf with a running total, record what
  the till actually said, log meals out, and track a monthly goal. Barcode
  scanning where the browser supports it. All money is integer cents.

## Layout

```
src/domain/        pure logic — no React, no database, all testable
  units.ts         everything normalises to grams
  waste.ts         the objective function the planner minimises
  budget.ts        spending, months, and integer-cent money
  allergens.ts     allergen groups, detection, and its own limits
  planner/         scoring and week generation
  import/          format, validator, prose parser, stub generator
  sync/            clocks and merge rules
src/db/            Dexie schema and the single write choke point
src/sync/          transport and orchestration
src/screens/       the six tabs
server/            reference sync server (no dependencies)
scripts/           tests and CLI tooling
docs/              import format reference
```

The domain layer knows nothing about React or IndexedDB, which is why the
optimizer can be benchmarked from a script and the merge rules tested exhaustively
without a browser.

## Commands

```bash
npm run dev            # dev server
npm run build          # typecheck + production PWA build
npm test               # all tests
npm run tune           # waste model tuning harness and optimizer benchmark
npm run demo           # end-to-end planner run, printed
npm run import         # bulk import CLI — see docs/import-format.md
npm run sync-server    # reference sync server — see server/README.md
```

## Adding recipes

See [docs/import-format.md](docs/import-format.md). The short version: recipe
lines can be written as prose (`"2 cloves garlic, minced"`), the importer rejects
anything it cannot fully resolve rather than importing it with holes, and
`npm run import stub` generates the ingredient dictionary for whatever is missing.

## Notes

- Requires Node 18.18+. Two of workbox's transitive dependencies assume Node 20+
  and are pinned in `overrides`; delete that block once the toolchain moves.
- The sync server has no authentication — the pairing code is the only credential.
  Read `server/README.md` before exposing it to the internet.
- Seed prices are BC estimates, fine for tuning and wrong for budgeting.
