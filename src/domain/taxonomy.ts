/**
 * What kind of dish a recipe is, and where it comes from.
 *
 * A library of five hundred recipes is a wall. Two questions cut it down the way
 * people actually think about dinner — "what sort of thing is it" and "where is
 * it from" — and both answers are already in the data: the tags say `pasta` and
 * `italian`, and the ingredients say the rest.
 *
 * DERIVED, NEVER STORED. Same call as the fruit/veg split in `produce.ts` and
 * the grab-bag shelves in `grabbag.ts`, for the same reasons. A recipe gains no
 * new field, nothing has to be migrated, and a recipe imported before any of this
 * existed is filed correctly the moment it is read. The cost is that the rules
 * live here and have to be good; the alternative is five hundred rows of
 * hand-typed category that are wrong the first week somebody imports in bulk.
 *
 * TAGS ARE EVIDENCE, NOT AUTHORITY. Half the library's pasta is not tagged
 * `pasta` — `pasta e ceci`, `skillet lasagna` and `mac and cheese` never were —
 * so the ingredients are read as well, through the same pasta shelf the grab bag
 * draws from. One list of what counts as pasta, used by both.
 *
 * "REGION" HERE IS CULINARY, and has nothing to do with `Region` in
 * `seasonality.ts`, which is where you shop and decides what is in season. They
 * are different questions that happen to share an English word, so the type here
 * is `CuisineRegion` and nothing in this file imports that one.
 */

import type { Id, Ingredient, Recipe } from './types';
import { isPasta } from './grabbag';
import { hasWord, vocabulary } from './nameWords';

// ---------------------------------------------------------------------------
// Dish type
// ---------------------------------------------------------------------------

export type DishTypeId =
  | 'soup' | 'salad' | 'curry' | 'stir-fry' | 'pasta' | 'rice' | 'bake'
  | 'roast' | 'handheld' | 'bowl' | 'eggs' | 'dip' | 'sweet' | 'other';

/**
 * Rice, as the shelf means it. Restricted to the `grain` category, which is what
 * keeps "rice vinegar" and "rice paper" out of it — neither is a bowl of rice.
 *
 * Rice noodles are deliberately absent: they are on the pasta shelf in
 * `grabbag.ts`, and a plate of rice vermicelli is a noodle dish by every measure
 * that matters to somebody choosing dinner.
 */
const RICE_WORDS: ReadonlySet<string> = vocabulary([
  'rice', 'arborio', 'basmati', 'jasmine', 'koshihikari', 'bomba', 'calasparra',
]);

function isRice(ing: Ingredient): boolean {
  return (
    ing.category === 'grain' &&
    !isPasta(ing) &&
    hasWord(ing, RICE_WORDS)
  );
}

export interface DishType {
  readonly id: DishTypeId;
  /** Heading form, for a group of them: "Soups". */
  readonly label: string;
  /**
   * Sentence form, for "three meals that are ___".
   *
   * Separate from the label because a heading and a clause want different
   * English: "Rice" is a fine heading and "three meals that are rice" is not a
   * sentence anyone would write.
   */
  readonly phrase: string;
  /** Any of these tags makes the recipe this kind of dish. */
  readonly tags: readonly string[];
  /**
   * Evidence from the ingredients, for the two types a recipe can be without
   * anybody having said so. Only the staples: whether a dish is a soup is not
   * visible in its ingredient list, and whether it contains pasta always is.
   */
  readonly staple?: (ing: Ingredient) => boolean;
}

/**
 * The kinds of dish, IN PRIORITY ORDER — first match wins when a recipe is
 * several of them, which most are.
 *
 * The order is the argument. Soup and salad come first because a soup with
 * noodles in it is a soup, and a pasta salad is a salad; ask anyone holding one.
 * Pasta and rice then outrank the cooking methods below them, because "pasta"
 * tells you more about what you are about to eat than "bake" does — which is why
 * baked rigatoni files under pasta rather than alongside a gratin.
 *
 * Only the primary is ordered. `dishTypesOf` returns every type that applies, so
 * the minestrone that files under soup is still found by a search for pasta, and
 * a rule asking for two pasta meals still counts it. Filing and filtering are
 * different jobs and this is the one place they differ.
 */
export const DISH_TYPES: readonly DishType[] = [
  { id: 'soup', label: 'Soups', phrase: 'soups', tags: ['soup'] },
  { id: 'salad', label: 'Salads', phrase: 'salads', tags: ['salad'] },
  { id: 'curry', label: 'Curries', phrase: 'curries', tags: ['curry'] },
  { id: 'stir-fry', label: 'Stir-fries', phrase: 'stir-fries', tags: ['stir-fry'] },
  { id: 'pasta', label: 'Pasta & noodles', phrase: 'pasta or noodles', tags: ['pasta', 'noodles'], staple: isPasta },
  { id: 'rice', label: 'Rice', phrase: 'rice dishes', tags: ['risotto', 'rice'], staple: isRice },
  { id: 'bake', label: 'Bakes & pizza', phrase: 'bakes', tags: ['bake', 'pizza'] },
  { id: 'roast', label: 'Roasts & traybakes', phrase: 'roasts', tags: ['roast', 'grill'] },
  { id: 'handheld', label: 'Sandwiches & wraps', phrase: 'sandwiches or wraps', tags: ['handheld', 'toast', 'flatbread', 'dumplings'] },
  { id: 'bowl', label: 'Bowls', phrase: 'bowls', tags: ['bowl'] },
  { id: 'eggs', label: 'Eggs', phrase: 'egg dishes', tags: ['eggs'] },
  { id: 'dip', label: 'Dips & sharing', phrase: 'dips', tags: ['dip', 'sharing'] },
  { id: 'sweet', label: 'Sweet things', phrase: 'sweet things', tags: ['sweet', 'fruit'] },
  { id: 'other', label: 'Everything else', phrase: 'anything else', tags: [] },
];

export const DISH_TYPE_LABELS: Readonly<Record<DishTypeId, string>> =
  Object.fromEntries(DISH_TYPES.map((t) => [t.id, t.label])) as Record<DishTypeId, string>;

export const DISH_TYPE_PHRASES: Readonly<Record<DishTypeId, string>> =
  Object.fromEntries(DISH_TYPES.map((t) => [t.id, t.phrase])) as Record<DishTypeId, string>;

/**
 * Every kind of dish this recipe is, in priority order. Never empty — a recipe
 * that matches nothing is `other`, so callers never have to handle a gap.
 */
export function dishTypesOf(
  recipe: Pick<Recipe, 'tags' | 'ingredients'>,
  ingredients: ReadonlyMap<Id, Ingredient>,
): readonly DishTypeId[] {
  const tags = new Set(recipe.tags);
  const out: DishTypeId[] = [];

  for (const type of DISH_TYPES) {
    if (type.id === 'other') continue;
    if (type.tags.some((t) => tags.has(t))) {
      out.push(type.id);
      continue;
    }
    if (type.staple && hasStaple(recipe, ingredients, type.staple)) out.push(type.id);
  }

  return out.length > 0 ? out : ['other'];
}

/** The one kind of dish to file this recipe under. */
export function primaryDishType(
  recipe: Pick<Recipe, 'tags' | 'ingredients'>,
  ingredients: ReadonlyMap<Id, Ingredient>,
): DishTypeId {
  return dishTypesOf(recipe, ingredients)[0];
}

/**
 * Optional ingredients do not count. "Serve with rice if you like" is a
 * suggestion, and filing the dish under rice on the strength of it would put a
 * curry in the wrong place on the word of a line the shopping list ignores.
 */
function hasStaple(
  recipe: Pick<Recipe, 'ingredients'>,
  ingredients: ReadonlyMap<Id, Ingredient>,
  test: (ing: Ingredient) => boolean,
): boolean {
  return recipe.ingredients.some((ri) => {
    if (ri.optional) return false;
    const ing = ingredients.get(ri.ingredientId);
    return ing !== undefined && test(ing);
  });
}

// ---------------------------------------------------------------------------
// Where it is from
// ---------------------------------------------------------------------------

export type CuisineRegionId =
  | 'italy' | 'mediterranean' | 'western-europe' | 'eastern-europe'
  | 'middle-east' | 'africa' | 'south-asia' | 'east-asia' | 'southeast-asia'
  | 'americas' | 'unfiled';

export interface CuisineRegion {
  readonly id: CuisineRegionId;
  readonly label: string;
  /** The cuisine tags that land here. */
  readonly cuisines: readonly string[];
}

/**
 * Culinary regions, and which cuisine tags belong to each.
 *
 * Italy gets a region to itself, which is not geography. It is the largest
 * cuisine in the library by a distance and the one people browse ON PURPOSE —
 * a heading that returns ninety recipes is a heading worth having, and folding
 * it into "Mediterranean" would bury it under everything else.
 *
 * The generic `asian` tag lands in East Asia. It is vague and the dishes
 * carrying it — sesame noodles, ginger stir-fries — are Chinese-adjacent in
 * method, so that is the least wrong shelf for it rather than a right one.
 *
 * A cuisine listed in no region falls to `unfiled`, which is also where recipes
 * with no cuisine tag go. Porridge is not from anywhere.
 */
export const CUISINE_REGIONS: readonly CuisineRegion[] = [
  { id: 'italy', label: 'Italy', cuisines: ['italian'] },
  {
    id: 'mediterranean',
    label: 'Mediterranean',
    cuisines: ['mediterranean', 'greek', 'spanish', 'portuguese'],
  },
  {
    id: 'western-europe',
    label: 'Western & Northern Europe',
    cuisines: ['french', 'british', 'welsh', 'german', 'swiss', 'dutch', 'swedish'],
  },
  {
    id: 'eastern-europe',
    label: 'Central & Eastern Europe',
    cuisines: ['eastern-european', 'russian', 'balkan', 'georgian'],
  },
  {
    id: 'middle-east',
    label: 'Middle East & North Africa',
    cuisines: [
      'middle-eastern', 'lebanese', 'turkish', 'persian', 'moroccan',
      'north-african', 'egyptian',
    ],
  },
  { id: 'africa', label: 'Africa', cuisines: ['african', 'ethiopian', 'nigerian', 'south-african'] },
  { id: 'south-asia', label: 'South Asia', cuisines: ['indian', 'sri-lankan', 'nepali'] },
  { id: 'east-asia', label: 'East Asia', cuisines: ['japanese', 'chinese', 'korean', 'asian'] },
  {
    id: 'southeast-asia',
    label: 'Southeast Asia',
    cuisines: ['southeast-asian', 'thai', 'vietnamese', 'indonesian', 'malaysian', 'filipino'],
  },
  {
    id: 'americas',
    label: 'The Americas',
    cuisines: ['american', 'mexican', 'caribbean', 'brazilian', 'peruvian'],
  },
  { id: 'unfiled', label: 'No particular region', cuisines: [] },
];

export const CUISINE_REGION_LABELS: Readonly<Record<CuisineRegionId, string>> =
  Object.fromEntries(CUISINE_REGIONS.map((r) => [r.id, r.label])) as Record<CuisineRegionId, string>;

const REGION_OF_CUISINE: ReadonlyMap<string, CuisineRegionId> = new Map(
  CUISINE_REGIONS.flatMap((region) => region.cuisines.map((c) => [c, region.id] as const)),
);

/** Every cuisine tag that has a region, for UI that offers them as filters. */
export const CUISINE_TAGS: readonly string[] = [...REGION_OF_CUISINE.keys()];

/**
 * The cuisine this recipe is tagged with, or null.
 *
 * The first recognised tag wins. Tags are authored in the order the author
 * thought of them and the cuisine is almost always first, so a recipe carrying
 * both `mediterranean` and `greek` reads as whichever it was written as.
 */
export function cuisineOf(recipe: Pick<Recipe, 'tags'>): string | null {
  return recipe.tags.find((t) => REGION_OF_CUISINE.has(t)) ?? null;
}

export function regionOf(recipe: Pick<Recipe, 'tags'>): CuisineRegionId {
  const cuisine = cuisineOf(recipe);
  return cuisine === null ? 'unfiled' : REGION_OF_CUISINE.get(cuisine) ?? 'unfiled';
}

/**
 * Every tag this file consumes — the dish-type tags and the cuisine tags.
 *
 * For UI that has already shown the type and the region and wants to list what
 * is left. Printing "Pasta & noodles · Italian · italian · pasta · quick" is how
 * a screen ends up saying the same thing three times.
 */
export const TAXONOMY_TAGS: ReadonlySet<string> = new Set([
  ...DISH_TYPES.flatMap((t) => t.tags),
  ...REGION_OF_CUISINE.keys(),
]);

/** "middle-eastern" → "Middle Eastern". Every cuisine tag reads correctly this way. */
export function cuisineLabel(tag: string): string {
  return tag
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
