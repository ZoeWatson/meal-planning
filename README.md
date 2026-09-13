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
- **Add a meal by hand** — every row in the Recipes tab has an Add button, and
  the meal joins the week at the portions the rest of that week's meals use. It
  takes a slot the planner could not fill, or makes one, and arrives pinned so
  the next regenerate keeps it.
- **Take a meal out**, with the ✕ on its card, for the Thursday you are eating
  out. The week gets shorter rather than gaining a hole to fill, and the shopping
  list drops exactly that meal's share of every ingredient — its half of the
  coriander, and the whole bunch if nothing else wanted any. Undo puts it back
  where it was, portions and pin and all. It is an edit to this week and not a
  change to how big a week is: the next regenerate, or Shuffle all over that kind
  of meal, rebuilds the section to the shape Settings asks for.
- **Take something off the shopping list**, with the ✕ on its line — the olive oil
  you turn out to have, the treat you have gone off. It leaves the shop, the count
  and the running total, and nothing else moves: the meal that wanted it still
  wants it, and the treat is still in the week's bag. The list is rebuilt from the
  week constantly, so this is remembered rather than derived — beside the ticks,
  and for this week only. What came off waits at the bottom of the list with a
  Put back beside it, a way back that does not expire rather than an undo that
  does, and next week's list starts with it back on.
- **"Already have it"** — the same removal, for the commonest reason a line comes
  off, with that reason kept. Open a line and say it, and it joins what is at the
  bottom of the list marked as something you own rather than something you decided
  against. For the things that keep, it then offers to put them in the pantry
  properly, which is the difference between not buying rice this week and not
  being asked about rice again. Only the things that keep: a stocked pantry item
  is free to the planner, so filing a bunch of parsley in there would quietly
  discount every week after this one. It is offered and never done for you, and
  the test for what keeps is the one the waste model already makes.
- **Browsing by type and region.** The Recipes tab groups the library by kind of
  dish — pasta, soups, curries, bakes — or by where the food is from, both
  derived rather than stored: a recipe is pasta if it is tagged pasta or if there
  is pasta in it, which is how the half of the library that never said so gets
  filed correctly. Filing and filtering answer differently on purpose. A
  minestrone with ditalini in it is a soup, and a search for pasta still finds it.
  Every group is on screen at once rather than on a strip you scroll sideways,
  and each carries the count you would get by tapping it — counted over whatever
  the search and the filters have already left, so it promises what it can
  deliver. Groups that would come back empty are not offered.
- **Filters, folded.** Meal type, diet (vegetarian, vegan, gluten free), effort
  (under 30 minutes, five ingredients or fewer), high protein — computed from
  ingredients rather than tagged — and in-season. They sit behind one fold below
  the browse chips, in labelled rows rather than one strip of seven, because
  browsing is why you opened the tab and narrowing is what you do second. The
  fold says on its own heading what is switched on: a hidden filter quietly
  removing half the library is how a good screen becomes a bug report. And the
  list can be ordered — A to Z, quickest, fewest ingredients, most protein —
  with ties broken by name, so it never appears to reshuffle itself.
- **Week rules** — "at least three meals under 30 minutes", "two pasta nights",
  "something using the halloumi", "at most one curry". A rule is a filter plus a
  count, which is the thing no per-recipe filter can say: asking a filter for
  under 30 minutes gives you a week of stir-fries. They reach the planner as a
  very expensive term in the objective rather than as a hard constraint, so an
  impossible rule yields a week with one rule unmet — named on the week screen —
  instead of no week. Set in Settings; every Regenerate and every shuffle honours
  them.
- **Regional seasonality** — BC, Ontario and Las Vegas ship; the picker is in
  Settings. The desert table inverts the Canadian one: winter greens, and a gap in
  high summer.
- **Allergies.** Group-level (tree nuts, milk, wheat…) rather than per ingredient,
  with name inference as a backstop for imported data. Removed from plans and the
  shopping list, and flagged loudly wherever a recipe could still slip through.
- **Cooking.** The week's meals ready to cook, plus "what can I make from what I
  already have" — which counts anything ticked off the shopping list, not just the
  pantry. Mark a meal cooked and the portions you don't eat become tracked
  leftovers with a use-by date.
- **A meal log** of what actually got eaten each day, split by cooked, leftovers
  and eaten out.
- **Weekly staples** always on the list.
- **A pantry with two dials**, because "how much is left" and "how much that
  matters" are different questions, and only both together decide whether running
  out is worth a trip. Stock — in, low, out — is reviewed on the week's page
  before a shop, which shows only what the cupboard is sending to this week's
  list and keeps the rest behind a button, a page at a time, one line each.
  Anything in stock is free to the planner. Necessity —
  must-have, nice-to-have, alright-without — is set once in Settings and decides
  how empty a thing has to get before it is bought without being asked. Anything
  can be put on the list by hand regardless, and taken off again; that choice
  stands until you have the thing.
- **Four grab bags** — produce, bread, pasta and cheese — of random items added
  each week as the antidote to cooking the same eight things forever. Each one
  switches on and off on its own and has its own size, each redraws without
  touching the meals or the other bags, and the produce bag splits into separate
  fruit and vegetable draws so a week never comes back with no fruit in it. The
  draw is weighted toward what is in season and on sale, and never offers
  something your allergies or diets rule out. The library carries 32 breads, 31
  pastas and 35 cheeses, because a bag that suggests "bread" is not a suggestion.
- **A treat bag** underneath it: herbal teas and other small good things, nothing
  over $10 and deliberately not all food — a long bath, flowers on the table and
  an hour with a crossword sit in there alongside the dark chocolate. It draws a
  tea, a thing to eat and a thing that is not, in that rotation, so it can never
  quietly become a snack list. Allergies and diets rule a treat out of the draw
  entirely rather than flagging it once it is in the bag.
- **A switch for every section of the week**, all nine of them together in
  Settings: the four grab bags, the treat bag, the summary, the meals and the
  pantry review. Switching a bag off stops it being drawn at all — nothing from
  that shelf reaches the plan or the shopping list, and the size it had is kept
  for when it comes back. Switching the summary, the meals or the pantry review
  off only takes them off the screen. The week screen itself carries no settings:
  it is the week, and the knobs that shape it live in one place.
- **Settings is an index.** Every section folds, every section ships folded, and
  each one says on its heading what it is currently set to — "Region · British
  Columbia", "Week shape · 5 full · 2 light · 3 snacks". The screen you land on
  is therefore a one-line summary of the entire app that happens to open, rather
  than thirty controls laid end to end with the one you came for somewhere in
  the middle. Related sections sit under a band label; the bands are captions and
  not a second layer of folding, because burying Allergies two taps deep to save
  a line of screen is not a trade worth making.
- **Metric and imperial**, toggled at display time.
- **Import a recipe** from a link, a photo or a block of text. All three become
  the same editable draft, reviewed line by line before anything is saved.
- **Bulk import** with a prose-line parser, and export as backup.
- **Sync** between devices, last-write-wins over hybrid logical clocks.
- **Spending tracker.** Price items at the shelf with a running total, record what
  the till actually said, log meals out, and track a monthly goal. Barcode
  scanning where the browser supports it. All money is integer cents.

- **Works cited** in Settings — plain English on how each system decides things
  and where its numbers came from, including which ones are unverified estimates.

## Layout

```
src/domain/        pure logic — no React, no database, all testable
  units.ts         everything normalises to grams
  waste.ts         the objective function the planner minimises
  budget.ts        spending, months, and integer-cent money
  allergens.ts     allergen groups, detection, and its own limits
  cooking.ts       cooking, leftovers, keeping times, the meal log
  grabbag.ts       the four grab bags: which shelf is which, and how big
  taxonomy.ts      what kind of dish a recipe is, and where it is from
  weekRules.ts     "three meals under 30 minutes" — filters that count
  weekSections.ts  what the week screen is made of, and which switch is which
  produce.ts       the fruit/veg split, as a shopper means it not a botanist
  nameWords.ts     whole-word matching over ingredient names, shared by both
  treats.ts        the treat catalogue and its draw — not ingredients, and why
  pantry.ts        stock, necessity, and what puts a cupboard item on the list
  planner/         scoring and week generation
  import/          format, validator, prose parser, stub generator
                   capture from links, photos and text; near-miss matching
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
npm run ocr-assets     # stage the on-device OCR runtime (also runs on install)
npm run sync-server    # reference sync server — see server/README.md
```

## Adding recipes

**One at a time**, from the Recipes tab: paste a page, photograph a cookbook, or
paste the text. Most recipe sites publish schema.org data, which is read as data
rather than guessed at from the page. Photos are read on-device with Tesseract.

Whichever route, you land on the same review screen, where each ingredient line
is marked resolved or not and the guesses the parser made are listed. Nothing is
written until you say so. Where a line names something the library does not have,
the near match is offered first — "salmon fillets" suggests the existing *Salmon
fillet* rather than creating a second record, because a duplicate splits one food
into two the planner will never overlap.

**In bulk**, from a file: see [docs/import-format.md](docs/import-format.md). The
short version: recipe lines can be written as prose (`"2 cloves garlic, minced"`),
the importer rejects anything it cannot fully resolve rather than importing it
with holes, and `npm run import stub` generates the ingredient dictionary for
whatever is missing.

Both routes go through the same importer. There is no laxer path into the
library.

## Notes

- Requires Node 18.18+. Two of workbox's transitive dependencies assume Node 20+
  and are pinned in `overrides`; delete that block once the toolchain moves.
- The sync server has no authentication — the pairing code is the only credential.
  Read `server/README.md` before exposing it to the internet.
- Seed prices are BC estimates, fine for tuning and wrong for budgeting.
- Photo import needs an OCR runtime — wasm cores copied out of `node_modules`
  plus a 2 MB language model — staged into `public/tesseract/` by `postinstall`.
  It is gitignored and excluded from the service worker's precache, so nobody
  pays 22 MB for a feature they never open. If you install offline, run
  `npm run ocr-assets` later; until then the model is fetched from the Tesseract
  project's CDN on first use, and the app says so on screen.
