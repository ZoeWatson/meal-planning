/**
 * Reads a recipe out of a block of unstructured text.
 *
 * This is what stands behind "paste it" and "photograph it". Both hand over a
 * wall of text with no markup at all, and the job is to work out which lines are
 * ingredients, which are method, and which are the title and the serving count.
 *
 * The stance is the same as `parseLine.ts`, one level up: guess at STRUCTURE,
 * never at QUANTITY. Putting a line in the wrong section is a mistake the user
 * sees immediately on the review screen and fixes by dragging a line across;
 * misreading "1½" is a mistake nobody sees until the shopping is wrong. So this
 * file is allowed to be heuristic about layout, and every ingredient line it
 * finds is still handed to the conservative parser afterwards, unchanged.
 *
 * Nothing here writes to the library. The output is a draft for review.
 */

import { parseIngredientLine } from './parseLine';
import {
  type RecipeDraft, type DraftOrigin,
  guessMealType, parseDuration, parseServings,
} from './draft';

/** Headings that mark the start of the ingredient list. */
const INGREDIENT_HEADING =
  /^\s*(?:ingredients?|you(?:'ll| will)? need|what you(?:'ll| will)? need|shopping list)\s*:?\s*$/i;

/** Headings that mark the start of the method. */
const METHOD_HEADING =
  /^\s*(?:method|directions?|instructions?|steps?|preparation|how to make(?: it)?|to make|procedure)\s*:?\s*$/i;

/**
 * Headings after which nothing belongs to the recipe.
 *
 * Recipe pages put a great deal after the method — nutrition panels, author
 * notes, comment threads — and sweeping that into `steps` turns a clean import
 * into a wall of unrelated prose.
 */
const TRAILING_HEADING =
  /^\s*(?:notes?|nutrition(?: information| facts)?|tips?|variations?|storage|equipment|comments?|reviews?|you might also like|related recipes?)\s*:?\s*$/i;

/** Lines carrying a stated time or yield, wherever they appear. */
const META_PATTERNS: ReadonlyArray<readonly [RegExp, 'prep' | 'cook' | 'total' | 'servings']> = [
  [/^\s*prep(?:aration)?(?:\s*time)?\s*[:–—-]?\s*(.+)$/i, 'prep'],
  [/^\s*cook(?:ing)?(?:\s*time)?\s*[:–—-]?\s*(.+)$/i, 'cook'],
  [/^\s*(?:bake|baking)(?:\s*time)?\s*[:–—-]?\s*(.+)$/i, 'cook'],
  [/^\s*total(?:\s*time)?\s*[:–—-]?\s*(.+)$/i, 'total'],
  [/^\s*(?:serves|servings?|yields?|makes|portions?)\s*[:–—-]?\s*(.+)$/i, 'servings'],
];

/**
 * Verbs that open an instruction.
 *
 * The discriminator that matters most. "2 tbsp butter" and "2 minutes, then add
 * the butter" both begin with a number and both parse as an ingredient line; only
 * the verb tells them apart.
 */
const STEP_VERBS =
  /^(?:pre-?heat|heat|warm|add|stir|mix|combine|whisk|beat|fold|pour|place|put|set|bring|simmer|boil|fry|sauté|saute|sear|roast|bake|grill|broil|cook|season|taste|serve|garnish|remove|transfer|drain|rinse|cover|uncover|reduce|return|repeat|continue|meanwhile|once|when|while|leave|rest|chill|freeze|refrigerate|divide|spread|top|arrange|assemble|blend|purée|puree|mash|knead|roll|shape|cut|slice|chop|dice|spoon|scatter|sprinkle|drizzle|toss|flip|turn|check|allow|let|using|in a|to a|for the)\b/i;

/** A leading enumerator on a method step: "1.", "2)", "Step 3:". */
const STEP_NUMBER = /^\s*(?:step\s*)?\d{1,2}\s*[.):]\s+/i;

/**
 * Nouns of time, which no recipe buys.
 *
 * "2 minutes, then add the tomatoes" parses as a perfectly well-formed
 * ingredient line — a quantity, a unit-less noun — and is the single most common
 * false positive when a method paragraph gets split at its commas. Catching it on
 * the noun is more reliable than catching it on the verb, which by then is
 * several words away.
 */
const TIME_NOUNS = /^(?:seconds?|minutes?|mins?|hours?|hrs?|days?|nights?|weeks?)\b/i;

interface Classified {
  readonly text: string;
  readonly kind: 'ingredient' | 'step' | 'unknown';
}

/**
 * Decides what one line probably is, on the line's own evidence.
 *
 * Deliberately ignorant of its neighbours — `segment` handles context. Keeping
 * the two apart is what makes this testable one line at a time.
 */
export function classifyLine(line: string): 'ingredient' | 'step' | 'unknown' {
  const text = line.trim();
  if (text === '') return 'unknown';

  // An enumerator is close to conclusive: ingredient lists are not numbered
  // "1." "2." in any source worth importing from, and method steps very often are.
  if (STEP_NUMBER.test(text)) return 'step';

  const withoutBullet = text.replace(/^[-*•·–—]\s*/, '');
  const words = withoutBullet.split(/\s+/).filter(Boolean);

  // Length is the other strong signal. An ingredient line is a noun phrase; a
  // step is a sentence, usually several.
  if (words.length > 14 || withoutBullet.length > 110) return 'step';
  if (/[.!?]\s+\S/.test(withoutBullet)) return 'step';

  const parsed = parseIngredientLine(withoutBullet);

  // The verb test is applied only where the line is ambiguous. "Season to taste"
  // parses as an ingredient AND opens with a step verb — and in an ingredient
  // list under an "Ingredients" heading it is genuinely an ingredient, which is
  // why `segment` gets to override this when a heading told it where it is.
  if (STEP_VERBS.test(withoutBullet)) return parsed.ok ? 'unknown' : 'step';

  // "…, then add the tomatoes" is a second instruction, not preparation. Only
  // "then" is treated this way: ingredient lines are full of past participles
  // after the comma ("cut into wedges", "drained and rinsed"), and testing those
  // against the verb list would throw away real ingredients to catch a rare
  // false positive — the wrong trade in a file whose whole job is not to drop
  // ingredients.
  if (/,\s*(?:and\s+)?then\b/i.test(withoutBullet)) return 'step';

  if (parsed.ok && TIME_NOUNS.test(parsed.value.item)) return 'step';

  return parsed.ok ? 'ingredient' : 'unknown';
}

interface Segments {
  title: string | null;
  ingredients: string[];
  steps: string[];
  notes: string[];
  /** True when explicit headings did the work, rather than line classification. */
  fromHeadings: boolean;
}

function segment(lines: readonly string[]): Segments {
  const notes: string[] = [];
  const ingredientStart = lines.findIndex((l) => INGREDIENT_HEADING.test(l));
  const methodStart = lines.findIndex((l) => METHOD_HEADING.test(l));

  if (ingredientStart !== -1) {
    // Headings present. Trust them completely — a source that labelled its own
    // sections knows better than any classifier here, including for the lines
    // that would otherwise look like steps ("Salt and pepper to taste").
    const endOfIngredients =
      methodStart > ingredientStart
        ? methodStart
        : lines.findIndex((l, i) => i > ingredientStart && TRAILING_HEADING.test(l));

    const ingredients = lines
      .slice(ingredientStart + 1, endOfIngredients === -1 ? lines.length : endOfIngredients)
      .filter((l) => l.trim() !== '' && !METHOD_HEADING.test(l));

    let steps: string[] = [];
    if (methodStart !== -1) {
      const trailing = lines.findIndex((l, i) => i > methodStart && TRAILING_HEADING.test(l));
      steps = lines
        .slice(methodStart + 1, trailing === -1 ? lines.length : trailing)
        .filter((l) => l.trim() !== '');
      if (trailing !== -1) {
        notes.push(`Stopped at "${lines[trailing].trim()}" — everything after it was left out.`);
      }
    } else {
      notes.push('No method heading found, so no steps were taken from the text.');
    }

    const title = lines.slice(0, ingredientStart).map((l) => l.trim()).find((l) => l !== '') ?? null;
    return { title, ingredients, steps, notes, fromHeadings: true };
  }

  // No headings. Fall back to classifying each line, then take the longest run of
  // ingredient-looking lines as the list.
  //
  // A run rather than "every ingredient-looking line anywhere" because recipe
  // sources put the list in one block, and scattered matches in the middle of the
  // method ("2 minutes") are exactly the false positives that need excluding.
  const classified: Classified[] = lines
    .filter((l) => l.trim() !== '')
    .map((text) => ({ text, kind: classifyLine(text) }));

  let bestStart = -1;
  let bestEnd = -1;
  let bestScore = 0;
  let runStart = -1;
  let runScore = 0;
  let gap = 0;

  for (let i = 0; i < classified.length; i++) {
    const kind = classified[i].kind;
    if (kind === 'ingredient') {
      if (runStart === -1) runStart = i;
      runScore += 1;
      gap = 0;
      if (runScore > bestScore) {
        bestScore = runScore;
        bestStart = runStart;
        bestEnd = i;
      }
    } else if (kind === 'unknown' && runStart !== -1 && gap === 0) {
      // One unreadable line inside the list does not end it — that is what a
      // torn OCR line or a sub-heading like "For the sauce" looks like.
      gap = 1;
    } else {
      runStart = -1;
      runScore = 0;
      gap = 0;
    }
  }

  if (bestStart === -1) {
    return {
      title: classified[0]?.text.trim() ?? null,
      ingredients: [],
      steps: [],
      notes: ['No ingredient list could be identified in this text.'],
      fromHeadings: false,
    };
  }

  const ingredients = classified.slice(bestStart, bestEnd + 1)
    .filter((c) => c.kind === 'ingredient')
    .map((c) => c.text);
  const steps = classified.slice(bestEnd + 1)
    .filter((c) => c.kind !== 'ingredient')
    .map((c) => c.text);
  const title = bestStart > 0 ? classified[0].text.trim() : null;

  notes.push(
    'This text had no "Ingredients" or "Method" headings, so the sections were ' +
    'worked out from the shape of each line. Check that nothing landed in the wrong place.',
  );

  return { title, ingredients, steps, notes, fromHeadings: false };
}

/**
 * Parses a block of recipe text into a draft.
 *
 * `fallbackTitle` is used when the text carries no obvious title of its own —
 * a page's `<title>`, or the photo's filename.
 */
export function parseRecipeText(
  input: string,
  options: { origin?: DraftOrigin; fallbackTitle?: string; sourceUrl?: string } = {},
): RecipeDraft {
  const origin = options.origin ?? 'text';
  const notes: string[] = [];

  const rawLines = input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim());

  // Metadata can sit anywhere — above the title, between the sections, in a
  // sidebar that flattened into the middle of the list — so it is pulled out
  // before segmentation rather than looked for in a fixed place.
  let prepMinutes: number | null = null;
  let cookMinutes: number | null = null;
  let totalMinutes: number | null = null;
  let servings: number | null = null;

  const body: string[] = [];
  for (const line of rawLines) {
    let consumed = false;
    for (const [pattern, field] of META_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const value = match[1];
      if (field === 'servings') {
        const parsed = parseServings(value);
        if (parsed !== null && servings === null) { servings = parsed; consumed = true; }
      } else {
        const parsed = parseDuration(value);
        if (parsed === null) continue;
        if (field === 'prep' && prepMinutes === null) { prepMinutes = parsed; consumed = true; }
        if (field === 'cook' && cookMinutes === null) { cookMinutes = parsed; consumed = true; }
        if (field === 'total' && totalMinutes === null) { totalMinutes = parsed; consumed = true; }
      }
      if (consumed) break;
    }
    if (!consumed) body.push(line);
  }

  const seg = segment(body);
  notes.push(...seg.notes);

  // A total time with no breakdown goes entirely to cooking. The weekly time
  // budget only ever sums the two, so this is exact for planning purposes; it is
  // only the display of "15 prep / 35 cook" that loses detail.
  if (totalMinutes !== null && prepMinutes === null && cookMinutes === null) {
    cookMinutes = totalMinutes;
    notes.push(`Only a total time (${totalMinutes} min) was given; it is recorded as cooking time.`);
  } else if (totalMinutes !== null && prepMinutes !== null && cookMinutes === null) {
    cookMinutes = Math.max(0, totalMinutes - prepMinutes);
  }

  const name = (seg.title ?? options.fallbackTitle ?? '').trim();
  if (name === '') notes.push('No title was found — give it one before importing.');

  if (servings === null) {
    notes.push('No serving count was stated. Four is assumed — correct it if the recipe says otherwise.');
  }

  const draft: RecipeDraft = {
    name,
    mealType: guessMealType(name),
    baseServings: servings ?? 4,
    prepMinutes: prepMinutes ?? 0,
    cookMinutes: cookMinutes ?? 0,
    ingredientLines: seg.ingredients.map(stripBullet),
    steps: seg.steps.map((s) => s.replace(STEP_NUMBER, '').trim()).filter(Boolean),
    tags: [],
    source: options.sourceUrl ? { url: options.sourceUrl, title: name || undefined } : undefined,
    notes,
    origin,
  };

  return draft;
}

function stripBullet(line: string): string {
  return line.replace(/^[-*•·–—]\s*/, '').trim();
}
