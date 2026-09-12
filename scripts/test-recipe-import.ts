/**
 * Single-recipe capture tests — link, photo and text.
 *
 * These parsers guess at STRUCTURE, which makes them exactly the kind of code
 * that quietly rots: a change that improves one site's layout breaks another's,
 * and nothing fails loudly. So the fixtures here are shaped like the real
 * sources — a JSON-LD blog post, an older microdata page, a photographed
 * cookbook page with OCR damage in it — rather than like tidy input.
 *
 * The end-to-end test at the bottom is the one that matters most: it asserts
 * that a captured recipe goes through the SAME strict importer as a bulk file
 * and comes out with real gram weights. A capture path that quietly relaxed the
 * rules would be worse than no capture path at all.
 *
 * Run with: npm run test:capture
 */

import assert from 'node:assert/strict';

import {
  draftToRawRecipe, guessMealType, parseDuration, parseServings, uniqueRecipeId,
} from '../src/domain/import/draft';
import { classifyLine, parseRecipeText } from '../src/domain/import/parseRecipeText';
import {
  decodeEntities, draftsFromHtml, draftsFromPaste, htmlToText,
} from '../src/domain/import/parseRecipeHtml';
import { buildIngredientIndex, importBundle } from '../src/domain/import/importer';
import { suggestIngredients, withAlias } from '../src/domain/import/suggest';
import { loadSeedData } from '../src/data/seed';

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

// ---------------------------------------------------------------------------

group('Durations');

test('ISO 8601 durations', () => {
  assert.equal(parseDuration('PT25M'), 25);
  assert.equal(parseDuration('PT1H30M'), 90);
  assert.equal(parseDuration('PT2H'), 120);
  assert.equal(parseDuration('P1DT2H'), 1560);
});

test('prose durations', () => {
  assert.equal(parseDuration('45 minutes'), 45);
  assert.equal(parseDuration('1 hr 30 mins'), 90);
  assert.equal(parseDuration('2 hours'), 120);
});

test('no time at all reads as null, not zero', () => {
  // The distinction drives a note on the review screen: "the page gave no times"
  // is a different thing to say than "this recipe takes no time".
  assert.equal(parseDuration('a while'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(undefined), null);
});

group('Servings');

test('reads the stated yield', () => {
  assert.equal(parseServings(4), 4);
  assert.equal(parseServings('4 servings'), 4);
  assert.equal(parseServings('Makes 12 cookies'), 12);
  assert.equal(parseServings(['6 servings']), 6);
});

test('a range takes the low end', () => {
  // Over-scaling buys food that gets thrown away, which is the one thing this
  // app exists to prevent. Under-scaling just leaves someone hungry.
  assert.equal(parseServings('4 to 6'), 4);
  assert.equal(parseServings('Serves 4-6'), 4);
});

test('an unreadable yield is null so the caller can flag the assumption', () => {
  assert.equal(parseServings('a crowd'), null);
  assert.equal(parseServings(null), null);
});

group('Line classification');

test('ingredient lines', () => {
  for (const line of ['2 cloves garlic, minced', '800 g chicken thighs', '1½ cups flour']) {
    assert.equal(classifyLine(line), 'ingredient', line);
  }
});

test('numbered and verb-led lines are steps', () => {
  for (const line of [
    '1. Preheat the oven to 200°C.',
    'Step 2: Brown the beef in batches.',
    'Add the garlic and cook for 2 minutes.',
    'Meanwhile, bring a large pan of salted water to the boil.',
  ]) {
    assert.equal(classifyLine(line), 'step', line);
  }
});

test('long lines are steps even when they open with a quantity', () => {
  // "2 minutes, then add…" parses perfectly well as an ingredient line. Length
  // and the verb are the only things that tell it apart from "2 tbsp butter".
  assert.equal(
    classifyLine('2 minutes, then add the tomatoes and simmer until the sauce has thickened nicely'),
    'step',
  );
});

group('Text with headings');

const HEADED = `
Lemon Garlic Chicken

Serves 4
Prep time: 15 minutes
Cook time: 35 minutes

Ingredients
800 g chicken thighs
4 cloves garlic, minced
1 lemon
2 tbsp olive oil
Salt and pepper to taste

Method
1. Preheat the oven to 200°C.
2. Toss the chicken with the oil, garlic and lemon.
3. Roast for 35 minutes until cooked through.

Notes
This is even better the next day.
`;

test('headings segment the text exactly', () => {
  const draft = parseRecipeText(HEADED);
  assert.equal(draft.name, 'Lemon Garlic Chicken');
  assert.equal(draft.baseServings, 4);
  assert.equal(draft.prepMinutes, 15);
  assert.equal(draft.cookMinutes, 35);
  assert.equal(draft.ingredientLines.length, 5);
  assert.equal(draft.steps.length, 3);
});

test('a headed list keeps verb-led ingredient lines', () => {
  // "Salt and pepper to taste" opens with a noun but "Season to taste" does not,
  // and under an Ingredients heading both are ingredients. Letting the verb test
  // win here would silently drop seasoning from every imported recipe.
  const draft = parseRecipeText(HEADED);
  assert.ok(
    draft.ingredientLines.some((l) => /salt and pepper/i.test(l)),
    'the seasoning line was dropped from the ingredient list',
  );
});

test('trailing sections are cut off', () => {
  const draft = parseRecipeText(HEADED);
  assert.ok(
    !draft.steps.some((s) => /better the next day/i.test(s)),
    'the Notes section leaked into the method',
  );
});

test('step numbering is stripped', () => {
  const draft = parseRecipeText(HEADED);
  assert.ok(draft.steps[0].startsWith('Preheat'), draft.steps[0]);
});

group('Text without headings');

const BARE = `
Tomato and White Bean Stew

1 yellow onion, diced
2 cloves garlic
1 can canned tomatoes
400 g white beans, drained
2 tbsp olive oil

Heat the oil in a large pan over medium heat.
Add the onion and cook until soft, about 8 minutes.
Stir in the garlic, tomatoes and beans and simmer for 20 minutes.
`;

test('the ingredient block is found without headings', () => {
  const draft = parseRecipeText(BARE);
  assert.equal(draft.name, 'Tomato and White Bean Stew');
  assert.equal(draft.ingredientLines.length, 5);
  assert.equal(draft.steps.length, 3);
});

test('the guess is disclosed rather than hidden', () => {
  const draft = parseRecipeText(BARE);
  assert.ok(
    draft.notes.some((n) => /no "Ingredients" or "Method" headings/i.test(n)),
    'the user was not told the sections were guessed at',
  );
});

test('an assumed serving count is always flagged', () => {
  const draft = parseRecipeText(BARE);
  assert.equal(draft.baseServings, 4);
  assert.ok(
    draft.notes.some((n) => /serving count/i.test(n)),
    'four servings was assumed silently — every quantity scales off this',
  );
});

group('HTML entities and tag stripping');

test('fractions survive entity decoding', () => {
  // A recipe page writes "1&frac12; cups"; losing this turns 1.5 into 1.
  assert.equal(decodeEntities('1&frac12; cups'), '1½ cups');
  assert.equal(decodeEntities('200&#176;C'), '200°C');
  assert.equal(decodeEntities('salt &amp; pepper'), 'salt & pepper');
});

test('script and style contents never become page text', () => {
  const text = htmlToText('<p>Real</p><script>var x = "2 cups flour";</script><style>p{}</style>');
  assert.ok(text.includes('Real'));
  assert.ok(!text.includes('2 cups flour'), 'script contents leaked into the page text');
});

group('JSON-LD');

const JSON_LD_PAGE = `<!doctype html>
<html><head><title>Chickpea Curry - Some Food Blog</title>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "name": "Some Food Blog" },
    {
      "@type": ["Recipe", "NewsArticle"],
      "name": "Chickpea Curry",
      "author": { "@type": "Person", "name": "A Cook" },
      "recipeYield": "4 servings",
      "prepTime": "PT10M",
      "cookTime": "PT25M",
      "recipeCategory": "Main",
      "recipeCuisine": "Indian",
      "recipeIngredient": [
        "1 yellow onion, diced",
        "2 cloves garlic",
        "1 tbsp curry powder",
        "400 g chickpeas, drained",
        "400 ml coconut milk"
      ],
      "recipeInstructions": [
        { "@type": "HowToStep", "text": "Fry the onion until soft." },
        { "@type": "HowToStep", "text": "Add the garlic and curry powder." },
        { "@type": "HowToStep", "text": "Pour in the chickpeas and coconut milk and simmer." }
      ]
    }
  ]
}
</script></head><body><p>words</p></body></html>`;

test('a Recipe inside @graph is found', () => {
  const [draft] = draftsFromHtml(JSON_LD_PAGE, 'https://example.com/curry');
  assert.equal(draft.origin, 'json-ld');
  assert.equal(draft.name, 'Chickpea Curry');
  assert.equal(draft.ingredientLines.length, 5);
  assert.equal(draft.steps.length, 3);
});

test('times, yield, author and tags come across', () => {
  const [draft] = draftsFromHtml(JSON_LD_PAGE, 'https://example.com/curry');
  assert.equal(draft.prepMinutes, 10);
  assert.equal(draft.cookMinutes, 25);
  assert.equal(draft.baseServings, 4);
  assert.equal(draft.source?.author, 'A Cook');
  assert.equal(draft.source?.url, 'https://example.com/curry');
  assert.ok(draft.tags.includes('indian'), draft.tags.join(','));
});

test('an @type array containing Recipe still matches', () => {
  // Publishers routinely tag a post as both Recipe and Article. Matching only a
  // bare string @type silently loses those pages.
  assert.equal(draftsFromHtml(JSON_LD_PAGE).length, 1);
});

test('instructions given as one string are split into steps', () => {
  const page = `<script type="application/ld+json">
    {"@type":"Recipe","name":"X","recipeIngredient":["1 lemon"],
     "recipeInstructions":"<p>Squeeze the lemon.</p><p>Drink it.</p>"}
  </script>`;
  const [draft] = draftsFromHtml(page);
  assert.deepEqual(draft.steps, ['Squeeze the lemon.', 'Drink it.']);
});

test('HowToSection steps are flattened', () => {
  const page = `<script type="application/ld+json">
    {"@type":"Recipe","name":"X","recipeIngredient":["1 lemon"],
     "recipeInstructions":[{"@type":"HowToSection","itemListElement":[
       {"@type":"HowToStep","text":"First."},{"@type":"HowToStep","text":"Second."}]}]}
  </script>`;
  const [draft] = draftsFromHtml(page);
  assert.deepEqual(draft.steps, ['First.', 'Second.']);
});

test('a malformed JSON-LD block does not sink a good one', () => {
  const page = `
    <script type="application/ld+json">{ this is not json }</script>
    <script type="application/ld+json">
      {"@type":"Recipe","name":"Survivor","recipeIngredient":["1 lemon"]}
    </script>`;
  const drafts = draftsFromHtml(page);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].name, 'Survivor');
});

test('a Recipe node with no ingredients is not offered', () => {
  // Cross-reference stubs are common and importing one gives an empty recipe.
  const page = `<script type="application/ld+json">
    {"@type":"Recipe","name":"Just a reference","url":"/elsewhere"}</script>`;
  assert.equal(draftsFromHtml(page).length, 0);
});

test('several recipes on one page are all offered', () => {
  const page = `
    <script type="application/ld+json">
      {"@type":"Recipe","name":"One","recipeIngredient":["1 lemon"]}</script>
    <script type="application/ld+json">
      {"@type":"Recipe","name":"Two","recipeIngredient":["2 lemons","1 lime"]}</script>`;
  assert.equal(draftsFromHtml(page).length, 2);
});

group('Microdata and the text fallback');

test('microdata is read when there is no JSON-LD', () => {
  const page = `<div itemscope itemtype="http://schema.org/Recipe">
    <h1 itemprop="name">Old Blog Soup</h1>
    <span itemprop="recipeYield">6 servings</span>
    <ul>
      <li itemprop="recipeIngredient">2 carrots, sliced</li>
      <li itemprop="recipeIngredient">1 yellow onion</li>
    </ul>
  </div>`;
  const [draft] = draftsFromHtml(page);
  assert.equal(draft.origin, 'microdata');
  assert.equal(draft.name, 'Old Blog Soup');
  assert.equal(draft.baseServings, 6);
  assert.equal(draft.ingredientLines.length, 2);
});

test('a page with no markup at all falls back to its text', () => {
  const page = `<html><head><title>Bean Stew | Blog</title></head><body>
    <h1>Bean Stew</h1>
    <ul><li>1 yellow onion, diced</li><li>400 g white beans</li><li>2 tbsp olive oil</li></ul>
    <p>Fry the onion, then add everything else and simmer for twenty minutes or so.</p>
  </body></html>`;
  const [draft] = draftsFromHtml(page);
  assert.equal(draft.origin, 'html-text');
  assert.equal(draft.ingredientLines.length, 3);
  assert.ok(
    draft.notes.some((n) => /published no recipe data/i.test(n)),
    'the user was not warned that this came out of raw page text',
  );
});

test('pasted plain text is not mistaken for a page', () => {
  const drafts = draftsFromPaste(HEADED);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].origin, 'text');
  assert.equal(drafts[0].name, 'Lemon Garlic Chicken');
});

group('Photographed pages');

test('OCR damage costs the damaged line, not the recipe', () => {
  // A photograph of a cookbook page comes back with a few mangled lines. The
  // whole design rests on those failing individually and visibly rather than
  // taking the import down with them.
  const ocr = `
Roast Vegetable Traybake

Ingredients
1 butternut squash, cubed
2 red onions
a hanofuI of fresh parsley
3 tbsp olive oil

Method
Roast everything at 200C for 40 minutes.
`;
  const draft = parseRecipeText(ocr, { origin: 'photo' });
  assert.equal(draft.ingredientLines.length, 4);

  const seed = loadSeedData();
  const result = importBundle(
    { recipes: [draftToRawRecipe(draft, 'traybake')] },
    seed.ingredients,
  );
  // Rejected, and for a reason that names the line a human can go and fix.
  assert.equal(result.recipes.length, 0);
  assert.ok(
    result.rejected[0].reasons.some((r) => /hanofuI|red onions/i.test(r)),
    result.rejected[0].reasons.join(' | '),
  );
});

group('Near-miss ingredient matching');

test('a plural or reworded spelling finds the ingredient you already have', () => {
  const seed = loadSeedData();
  for (const [written, expected] of [
    ['salmon fillets', 'salmon-fillet'],
    ['chicken thighs', 'chicken-thigh'],
    ['garlic cloves', 'garlic'],
    ['fresh parsley', 'parsley'],
    ['yellow onions', 'yellow-onion'],
  ] as const) {
    const [top] = suggestIngredients(written, seed.ingredients);
    assert.ok(top, `"${written}" suggested nothing`);
    assert.equal(top.ingredient.id, expected, `"${written}" suggested ${top?.ingredient.id}`);
  }
});

test('different foods sharing a word are not suggested for each other', () => {
  // The damaging direction. Aliasing "peanut butter" onto "butter" merges two
  // foods with different pack sizes, prices and allergens into one, and the
  // planner would then treat buying one as buying the other.
  const seed = loadSeedData();
  for (const written of ['peanut butter', 'olive oil', 'coconut milk']) {
    for (const suggestion of suggestIngredients(written, seed.ingredients)) {
      assert.ok(
        tokenCount(suggestion.ingredient.name) > 1 || tokenCount(written) === 1,
        `"${written}" was matched to the broader "${suggestion.ingredient.name}"`,
      );
    }
  }
});

test('something genuinely absent suggests nothing', () => {
  const seed = loadSeedData();
  assert.equal(suggestIngredients('unobtainium', seed.ingredients).length, 0);
  assert.equal(suggestIngredients('gochujang', seed.ingredients).length, 0);
});

test('adding an alias is idempotent and case-insensitive', () => {
  const seed = loadSeedData();
  const salmon = seed.ingredients.find((i) => i.id === 'salmon-fillet')!;
  const once = withAlias(salmon, 'Salmon Fillets');
  assert.ok(once.aliases.includes('salmon fillets'));
  assert.equal(withAlias(once, 'salmon fillets').aliases.length, once.aliases.length);
  // The alias has to actually resolve, which is the only thing that matters.
  assert.ok(buildIngredientIndex([once]).has('salmon fillets'));
});

function tokenCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

group('End to end, through the real importer');

test('a captured draft imports with real gram weights', () => {
  const seed = loadSeedData();
  const [draft] = draftsFromHtml(JSON_LD_PAGE, 'https://example.com/curry');
  const result = importBundle(
    { recipes: [draftToRawRecipe(draft, 'chickpea-curry-imported')] },
    seed.ingredients,
  );

  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
  assert.equal(result.recipes.length, 1);

  const recipe = result.recipes[0];
  assert.equal(recipe.ingredients.length, 5);
  for (const line of recipe.ingredients) {
    assert.ok(line.grams > 0, `${line.ingredientId} resolved to ${line.grams} g`);
  }
  assert.equal(recipe.builtIn, false, 'a captured recipe must not claim to be library data');
  assert.equal(recipe.source?.url, 'https://example.com/curry');
});

test('"1 can X" reports a missing unit, not a missing ingredient', () => {
  // The most common snag when capturing from the web, and the two failures need
  // opposite fixes: this one wants a `can` weight added to an ingredient that
  // already exists, NOT a second "canned coconut milk" record. The review screen
  // reads `unconvertible` to tell the user which of the two they are looking at,
  // so the distinction has to survive the capture path.
  const seed = loadSeedData();
  const draft = parseRecipeText(`
Quick Curry

Ingredients
1 can coconut milk
1 tbsp curry powder

Method
Simmer.
`);
  const result = importBundle({ recipes: [draftToRawRecipe(draft, 'quick-curry')] }, seed.ingredients);

  assert.equal(result.recipes.length, 0);
  const unconvertible = result.issues.find((i) => i.unconvertible);
  assert.ok(unconvertible, 'the unit failure was not reported as unconvertible');
  assert.equal(unconvertible.unconvertible?.ingredientId, 'coconut-milk');
  assert.equal(unconvertible.unconvertible?.unit, 'can');
  assert.ok(
    !result.issues.some((i) => i.unresolvedItem === 'coconut milk'),
    'a known ingredient was reported as missing, which sends the user off creating a duplicate',
  );
});

test('capture is held to the same standard as a bulk import', () => {
  // The point of the whole design: there is no second, laxer way into the
  // library. An unresolvable ingredient rejects the recipe here exactly as it
  // would in a bundle, rather than importing it with a hole in it.
  const seed = loadSeedData();
  const draft = parseRecipeText(`
Mystery Dish

Ingredients
200 g unobtainium
1 yellow onion

Method
Cook it.
`);
  const result = importBundle(
    { recipes: [draftToRawRecipe(draft, 'mystery')] },
    seed.ingredients,
  );
  assert.equal(result.recipes.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.ok(result.rejected[0].reasons.some((r) => /unobtainium/i.test(r)));
  assert.ok(result.issues.some((i) => i.unresolvedItem === 'unobtainium'));
});

test('meal type is guessed from the name', () => {
  assert.equal(guessMealType('Chocolate Chip Cookies'), 'snack');
  assert.equal(guessMealType('Tomato and Basil Salad'), 'light');
  assert.equal(guessMealType('Beef Bourguignon'), 'full');
});

test('importing the same recipe twice does not overwrite the first', () => {
  // Recipe ids are referenced by plans and the meal log, so a collision has to
  // become a second recipe rather than a silent replacement of a corrected one.
  const taken = new Set(['chickpea-curry']);
  assert.equal(uniqueRecipeId('Chickpea Curry', taken), 'chickpea-curry-2');
  assert.equal(uniqueRecipeId('Chickpea Curry', new Set()), 'chickpea-curry');
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
