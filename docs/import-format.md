# Bulk import format

This is the contract for getting recipes into the app in bulk. Whatever pipeline
you build later — scraping, an LLM extraction pass, hand-authoring, converting an
existing collection — its job is to emit **this** shape. Everything downstream
assumes the data has already been through here.

## Why it is strict

The planner treats `grams` as ground truth. It uses those numbers to decide what
overlaps, what gets wasted, and what ends up on your grocery list. A recipe with a
silently-dropped ingredient does not degrade gracefully; it confidently tells you
to buy the wrong food.

So the importer rejects any recipe it cannot fully resolve, and reports why.
A rejected recipe is a five-second fix. A silently mangled one is a wasted trip.

## Two files

Import is a single JSON object with either or both keys:

```json
{
  "ingredients": [ /* RawIngredient */ ],
  "recipes":     [ /* RawRecipe */ ]
}
```

Ingredients must exist before the recipes that reference them — either in the same
bundle, or already on the device. **Import ingredients first**, then recipes.

## Ingredients

The ingredient dictionary is the backbone. Recipes reference ingredients *by name*;
the importer resolves names to ids. Getting this file right is most of the work of
a 500-recipe library, and it is worth doing carefully once.

```json
{
  "id": "garlic",
  "name": "Garlic",
  "aliases": ["garlic cloves", "fresh garlic"],
  "category": "produce",

  "countUnits": { "clove": 3, "head": 45 },
  "displayAs": "count",
  "countUnit": "clove",

  "purchase": {
    "unit": "head",
    "gramsPerPack": 45,
    "divisible": false,
    "costPerKg": 8.00
  },

  "shelfLifeDays": 60,
  "seasonMonths": [7, 8, 9, 10]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Stable, lowercase, kebab-case. Never reuse or renumber — plans reference these. |
| `name` | yes | Display name. |
| `aliases` | no | Every other way a recipe might spell it. **This is where you absorb messy source data.** |
| `category` | yes | Drives aisle ordering and season logic. See list below. |
| `gramsPerMl` | conditional | **Required if any recipe measures this by volume** (cup, tbsp, ml…). |
| `countUnits` | conditional | **Required if any recipe measures this by count** (clove, bunch, each…). Grams per one. |
| `displayAs` | no | `mass` \| `volume` \| `count`. Defaults to `mass`. |
| `countUnit` | no | Which count unit to display. Defaults to the first in `countUnits`. |
| `purchase.unit` | yes | Shopping-facing noun: `head`, `bunch`, `can`, `carton`, `bag`. |
| `purchase.gramsPerPack` | yes | Smallest amount you can actually buy. |
| `purchase.divisible` | yes | `true` for loose produce, deli, bulk bins. `false` for sealed fixed sizes. |
| `purchase.costPerKg` | yes | Approximate. Drives the waste objective — order of magnitude is enough. |
| `shelfLifeDays` | yes | Realistic days until unusable. `365` for shelf-stable. |
| `carryOver` | no | `pantry` \| `freezer` \| `fresh` — where surplus goes at week's end. Defaults from `category`. |
| `backgroundUseGramsPerWeek` | no | Grams eaten with no recipe calling for it. Defaults to `0`. |
| `wasteRisk` | no | `0..1` override of the computed spoil risk. Rarely needed. |
| `seasonMonths` | no | Months `1-12`. Omit for year-round. |
| `excludesDiets` | no | Diets this violates, e.g. `["vegetarian"]`. |

Categories: `produce`, `meat`, `seafood`, `dairy`, `bakery`, `grain`, `legume`,
`canned`, `frozen`, `spice`, `condiment`, `oil`, `baking`, `beverage`, `other`.

### The two fields people get wrong

**`divisible`** is the single most important field for waste accuracy. It is the
difference between "I need 30 g of tomato paste" costing you 30 g and costing you a
whole 156 g can with 126 g destined for the back of the fridge. Get this right and
the optimizer will start finding second uses for opened packages on its own.

**`gramsPerPack`** should be the *smallest* real purchase size, not the one you
usually buy. If rice comes in 1 kg and 5 kg bags, put 1000.

### The waste fields

`carryOver` and `backgroundUseGramsPerWeek` exist because "surplus" and "waste"
are not the same thing, and conflating them wrecks the plans.

**`carryOver`** — where surplus goes when the week ends. The category default is
usually right, so set it only for exceptions: bread and cheese are `freezer`
rather than the `bakery`/`dairy` default, because you actually freeze them.

**`backgroundUseGramsPerWeek`** — how much of this a household gets through with
no recipe calling for it. Yogurt by the spoonful, bread as toast, fruit off the
counter, milk in coffee. Surplus up to this much is *eaten*, so it is spend but
not waste.

Set it to `0` — the default — for anything nobody consumes spontaneously. Nobody
snacks on parsley, and pretending otherwise makes the planner blind to the single
most commonly binned item in a kitchen.

Getting these two wrong is the most expensive data error available in this
format. An ingredient wrongly marked `pantry`, or given a generous background
figure, becomes invisible to the optimizer and its waste stops being designed
away. See `src/domain/waste.ts` for the full model.

## Recipes

```json
{
  "id": "lemon-garlic-chicken",
  "name": "Lemon Garlic Chicken",
  "mealType": "full",
  "baseServings": 4,

  "ingredients": [
    { "item": "chicken thighs", "quantity": 800, "unit": "g" },
    { "item": "garlic",         "quantity": 4,   "unit": "clove", "prep": "minced" },
    { "item": "lemon",          "quantity": 1,   "unit": "each" },
    { "item": "olive oil",      "quantity": 2,   "unit": "tbsp", "scaling": "sublinear" },
    { "item": "fresh parsley",  "quantity": 10,  "unit": "g", "optional": true }
  ],

  "steps": ["Preheat oven to 200°C.", "..."],
  "prepMinutes": 15,
  "cookMinutes": 35,
  "tags": ["mediterranean", "roast", "weeknight"],
  "primaryProtein": "chicken thighs",
  "diets": ["gluten-free", "dairy-free"]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Stable and unique. |
| `name` | yes | |
| `mealType` | yes | `full` \| `light` \| `snack`. Determines which slots it can fill. |
| `baseServings` | yes | Servings the written quantities produce. All scaling is relative to this. |
| `ingredients[].raw` | — | A whole written line, parsed into the three fields below. See **Prose lines**. |
| `ingredients[].item` | yes* | Ingredient **name, alias, or id**. Case- and whitespace-insensitive. |
| `ingredients[].quantity` | yes* | Number > 0. |
| `ingredients[].unit` | yes* | A measure unit, or one of that ingredient's `countUnits`. |
| `ingredients[].prep` | no | `"minced"`, `"diced"` — display only, never affects quantity. |
| `ingredients[].optional` | no | Optional ingredients are excluded from the grocery list and from waste. |
| `ingredients[].scaling` | no | `linear` (default) \| `sublinear` \| `fixed`. Spices and oils default to `sublinear`. |
| `steps` | no | |
| `prepMinutes` / `cookMinutes` | no | Default `0`. Feeds the weekly time budget. |
| `tags` | no | Cuisine/technique. Used for variety scoring — repeated tags get penalized. |
| `primaryProtein` | no | **Set this on anything with a main protein.** Without it the optimizer will happily plan chicken seven nights running, because chicken overlaps beautifully with itself. |
| `diets` | no | Diets this recipe *satisfies*. |
| `source` | no | `{ title, author, url }`. |

\* Required *unless* the line uses `raw`.

### Prose lines

Almost every recipe source writes ingredients as prose, and splitting 5,000 lines
by hand is what stops a large library from ever getting finished. So a line can be
given whole:

```json
{ "raw": "2 cloves garlic, minced" }
```

which parses to `item: "garlic"`, `quantity: 2`, `unit: "clove"`, `prep: "minced"`.

Handled: fractions (`1/2`, `1½`, `2 ¼`), ranges (`2-3`, `2 to 4` — averaged and
flagged), parentheticals (`1 (400 g) can chickpeas`), preparation after a comma,
noise words (`2 large ripe tomatoes` → tomatoes), leading bullets, `juice of 1
lemon`, and optional markers (`to taste`, `optional`, `plus more`).

**The parser is deliberately conservative.** A line it cannot read with confidence
is rejected rather than guessed at, because a silently mis-parsed quantity
corrupts the grocery list in a way nobody notices until they are in a shop with
the wrong food. A rejected line costs thirty seconds; a mis-parsed one costs a
meal.

Explicit fields override the parse, so you can correct a single line while keeping
its original text:

```json
{ "raw": "a good glug of olive oil", "quantity": 2, "unit": "tbsp", "item": "olive oil" }
```

### `scaling`

Doubling a stew doubles the beef but not the bay leaves. Three rules:

- `linear` — scales with servings. Almost everything.
- `sublinear` — scales as `ratio^0.7`. Spices, oil, aromatics.
- `fixed` — never scales. "1 bay leaf", "a splash of vinegar".

Getting this wrong on spices inflates the grocery list on every large-portion plan.

## Units

Measure units and their aliases (see `src/domain/units.ts`):

- **Mass** — `g`, `kg`, `mg`, `oz`, `lb`
- **Volume** — `ml`, `l`, `dl`, `tsp`, `tbsp`, `cup`, `fl oz`, `pint`, `quart`

Spoon and cup units use cooking-metric values (`tsp` 5 ml, `tbsp` 15 ml, `cup`
240 ml) rather than US customary exact values. The difference is under 2%, well
below the noise floor of "one medium onion", and it displays far better.

Anything else — `clove`, `bunch`, `head`, `each`, `slice`, `can` — is a **count
unit** and must be declared in that ingredient's `countUnits`. Count units are
resolved per-ingredient and take priority, so `clove` can mean something for garlic
and nothing for flour.

## Errors

`importBundle()` returns:

```ts
{
  ingredients, recipes,   // everything that imported cleanly
  issues,                 // { severity, path, message, unresolvedItem? }
  rejected,               // [{ id, name, reasons[] }]
  ok                      // true only if nothing was rejected and no errors
}
```

`summarizeUnresolved()` groups missing ingredient names by frequency. Across 500
recipes the same twenty missing ingredients cause most of the failures, so working
that list top-down clears the backlog fastest.

### Common rejections

| Message | Fix |
|---|---|
| `"X" does not match any ingredient name, id, or alias` | Add the ingredient, or add `"X"` to an existing ingredient's `aliases`. |
| `X is measured by volume but has no gramsPerMl` | Add a density to the ingredient. |
| `"X" is not a known measure unit and is not a count unit of Y` | Add it to `Y.countUnits` with grams per one. |
| `requires purchase.gramsPerPack > 0` | Waste cannot be computed without a pack size. |

## The tooling

```bash
npm run import check <file>             # validate, report what is wrong
npm run import stub  <file> -o out.json # skeletons for every missing ingredient
npm run import merge <a> <b> -o out.json
npm run import export -o library.json
```

`check` reports three separate things, because they need three different fixes:

- **Missing ingredients** — ranked by how many recipes want each. Add the
  ingredient, or add the spelling as an alias.
- **Unconvertible units** — the ingredient *exists*, it just has no `clove` or
  `can`. Add a `countUnits` entry. Do **not** create a second ingredient.
- **Other errors** — malformed lines, with the file path and line index.

`stub` writes a filled-in skeleton for every missing ingredient: category guessed
from the name, plausible pack size and shelf life, and the count units that
category usually needs. Everything is marked `TODO` and ordered by demand, so you
work down from whatever is blocking the most recipes.

By default everything resolves against the built-in library as well as the file's
own ingredients. Pass `--standalone` to check a bundle in isolation.

There is also an **Import & export** button in the app's Settings, which runs the
same validation and shows the same three reports before writing anything. Use the
CLI for bulk authoring and the app for bringing a finished file onto your phone.

## Authoring a large library

Suggested order, because each step makes the next cheaper:

1. **Get the recipes into the format**, using `raw` lines. Do not hand-split them.
2. **`npm run import check`** — expect a lot of missing ingredients. This is normal.
3. **`npm run import stub`** to generate the dictionary, then fill it in from the
   top down. Check `purchase.divisible` and `purchase.gramsPerPack` on every one;
   they drive the entire waste model. The rest can be approximate.
4. **`merge` and `check` again.** Repeat until clean.
5. **Backfill `primaryProtein` and `scaling`.** Neither blocks import, but plans
   get noticeably better once they are set — without `primaryProtein` the
   optimizer will happily plan chicken seven nights running.

Export early and often: until sync exists, an export file is the only backup.
