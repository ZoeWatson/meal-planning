import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { addRecipeToPlan } from '../db/repository';
import {
  DEFAULT_SORT_ID, FILTER_SECTIONS, RECIPE_SORTS, composeChipFilter, explainFilter,
  sortRecipes, type ChipState, type MatchMode,
} from '../domain/filters';
import { recipeNutrition } from '../domain/nutrition';
import { checkRecipe, describeMatches } from '../domain/allergens';
import {
  DISH_TYPE_LABELS, TAXONOMY_TAGS, cuisineLabel, cuisineOf, dishTypesOf,
  primaryDishType, regionOf,
} from '../domain/taxonomy';
import type { MealType, Recipe } from '../domain/types';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { RecipeDetail } from '../components/RecipeDetail';
import { Sheet } from '../components/Sheet';
import { AddRecipeSheet } from './AddRecipeSheet';

const REJECTION_LABELS: Record<string, string> = {
  'meal-type': 'meal type',
  diet: 'diet',
  'missing-ingredient': 'missing ingredient',
  'excluded-ingredient': 'excluded ingredient',
  'too-slow': 'cooking time',
  protein: 'protein',
  calories: 'calories',
  fibre: 'fibre',
  tags: 'tags',
  'dish-type': 'kind of dish',
  region: 'region',
  season: 'season',
  search: 'search',
  'too-many-ingredients': 'ingredient count',
  origin: 'source',
  excluded: 'something you ruled out',
  'no-match': 'none of the chips you included',
};

const MEAL_FILTERS: ReadonlyArray<{ id: MealType | 'any'; label: string }> = [
  { id: 'any', label: 'Any' },
  { id: 'full', label: 'Full' },
  { id: 'light', label: 'Light' },
  { id: 'snack', label: 'Snacks' },
];

/**
 * The recipe library.
 *
 * EVERY WAY OF NARROWING THE LIBRARY IS IN ONE PANEL. Kind of dish and region
 * used to be a browse strip above the list, on the argument that browsing and
 * filtering are different jobs. They are, but they are not different CONTROLS:
 * the strip could only ever hold one group at a time on one axis, so "pasta or
 * rice", "Italian but not a salad" and "a curry that is also vegetarian" were
 * all unaskable, and those are the ordinary shapes of narrowing a library down.
 * In the panel they compose with the diet and effort chips and with each other,
 * which is worth more than the tap it costs to open the panel.
 *
 * The panel ships folded and says on its own heading what is currently switched
 * on — the one thing a folded filter panel absolutely must do, since a hidden
 * filter quietly removing half the library is how a good screen becomes a bug
 * report. That matters more now that it holds the browse axes too.
 *
 * The chips inside it are in five labelled sections rather than one strip.
 * "I want a curry", "I want something Greek", "I am vegetarian" and "I have
 * twenty minutes" are separate decisions, and one long row makes you read all
 * thirty to find the one you are making.
 *
 * EACH CHIP HAS THREE STATES, not two: tap to include, tap again to exclude, tap
 * again to clear. Excluding is not a nicety — "anything but a salad" is how
 * people actually say what they want at six in the evening, and expressing it
 * with include-chips means selecting the other thirteen.
 */
export function RecipesScreen({ state }: { state: AppState }): JSX.Element {
  const { recipes, ingredients, ctx, settings } = state;
  /** Only the switched chips are in here; absent means off. */
  const [chips, setChips] = useState<ReadonlyMap<string, ChipState>>(new Map());
  const [mode, setMode] = useState<MatchMode>('all');
  const [mealType, setMealType] = useState<MealType | 'any'>('any');
  const [sortId, setSortId] = useState<string>(DEFAULT_SORT_ID);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Recipe | null>(null);
  const [showAvoided, setShowAvoided] = useState(false);
  const [adding, setAdding] = useState(false);

  const filter = useMemo(() => composeChipFilter(chips, mode, {
    search: search.trim() || undefined,
    mealTypes: mealType === 'any' ? undefined : [mealType],
  }), [chips, mode, mealType, search]);

  const { matched, rejections } = useMemo(() => {
    if (!ctx) return { matched: [] as Recipe[], rejections: new Map<string, number>() };
    return explainFilter(recipes.values(), filter, {
      ingredients, region: ctx.region, month: ctx.month,
    });
  }, [recipes, filter, ingredients, ctx]);

  /**
   * Splits matches into what is safe to cook and what is not.
   *
   * Hidden by default — this is the "never want to see" list — but revealable,
   * because someone managing an allergy is entitled to check the app's reasoning
   * rather than take a silent omission on faith.
   */
  const { safe, avoided } = useMemo(() => {
    if (settings.allergens.length === 0) return { safe: matched, avoided: [] as typeof matched };
    const safeList: Recipe[] = [];
    const avoidList: Recipe[] = [];
    for (const recipe of matched) {
      (checkRecipe(recipe, ingredients, settings.allergens).hasMatch ? avoidList : safeList)
        .push(recipe);
    }
    return { safe: safeList, avoided: avoidList };
  }, [matched, ingredients, settings.allergens]);

  /**
   * The type and region chips the library can actually deliver on, by chip id.
   *
   * A chip for a kind of dish nobody has a recipe for is a chip whose only
   * function is to disappoint, and there are twenty-five of these against seven
   * hand-picked presets — a library with no African recipes and no dips would
   * otherwise show both.
   *
   * Counted over the WHOLE library rather than over what is currently showing,
   * which is the deliberate half of it. As a browse strip these carried live
   * counts, because there you were standing inside one group and the number said
   * what the next tap would give you. As chips among chips there is no one
   * "rest of the filter" to count against — in `any` mode a chip ADDS recipes
   * rather than removing them — and a number that means something different
   * depending on a toggle is worse than no number. What survives is the durable
   * claim: your library has none of these at all.
   */
  const stocked = useMemo(() => {
    const ids = new Set<string>();
    for (const recipe of recipes.values()) {
      // Every type it is, not the one it files under, because that is what the
      // `dishTypes` filter behind the chip matches on.
      for (const type of dishTypesOf(recipe, ingredients)) ids.add(`type:${type}`);
      ids.add(`region:${regionOf(recipe)}`);
    }
    return ids;
  }, [recipes, ingredients]);

  const shown = useMemo(
    () => sortRecipes(safe, sortId, ingredients),
    [safe, sortId, ingredients],
  );

  /**
   * What the filter panel is doing, for its own folded heading.
   *
   * Named rather than counted. "3 filters" tells you something is on and leaves
   * you to open the panel to find out what; "Vegetarian · Under 30 min" is the
   * answer itself, and it is what stops a folded panel from being a place
   * results go missing.
   *
   * Named only while naming fits. Past three it becomes two names and a count,
   * because a heading is one line: the alternative is a list the CSS has to cut
   * off mid-word, and "Vegetarian · Vegan · Gluten fr…" hides the fact that
   * there are four more behind it.
   */
  const filterNote = useMemo(() => {
    const parts: string[] = [];
    if (mealType !== 'any') {
      parts.push(MEAL_FILTERS.find((m) => m.id === mealType)!.label);
    }

    // Drawn in panel order rather than the order they were tapped, so the same
    // set of chips always reads the same way round.
    let included = 0;
    const excludedParts: string[] = [];
    for (const section of FILTER_SECTIONS) {
      for (const chip of section.chips) {
        const chipState = chips.get(chip.id);
        if (chipState === 'include') {
          parts.push(chip.label);
          included++;
        } else if (chipState === 'exclude') {
          // "not Italy", not "no italy". Half these labels are proper nouns and
          // the other half are noun phrases the article would have to agree
          // with — "not Under 30 min" is at worst terse, where "no under 30 min"
          // is wrong twice over.
          excludedParts.push(`not ${chip.label}`);
        }
      }
    }
    // After the includes, because "Soups · no fish" is the shape of the thought
    // and "no fish · Soups" is not.
    parts.push(...excludedParts);

    if (sortId !== DEFAULT_SORT_ID) {
      parts.push(RECIPE_SORTS.find((s) => s.id === sortId)!.label.toLowerCase());
    }
    if (parts.length === 0) return 'none';

    const joined = parts.length <= 3
      ? parts.join(' · ')
      : `${parts.slice(0, 2).join(' · ')} +${parts.length - 2} more`;

    // Only worth saying when it changes the meaning. One included chip matches
    // the same recipes either way round.
    return mode === 'any' && included > 1 ? `any of ${joined}` : joined;
  }, [chips, mode, mealType, sortId]);

  const anyFilter = chips.size > 0 || mealType !== 'any' || sortId !== DEFAULT_SORT_ID;

  /**
   * Include → exclude → off.
   *
   * Three states on one tap target rather than a chip with a second little
   * minus button on it. The chips are 38px tall in a wrapped grid of thirty;
   * splitting each one into two targets makes both of them too small to hit and
   * the grid twice as busy to read.
   *
   * The cost is that exclude is not discoverable by looking, which the line of
   * help text above the sections pays for.
   */
  function cycle(id: string): void {
    setChips((prev) => {
      const next = new Map(prev);
      const here = next.get(id);
      if (here === undefined) next.set(id, 'include');
      else if (here === 'include') next.set(id, 'exclude');
      else next.delete(id);
      return next;
    });
  }

  /**
   * Leaves the search box and the browse group alone on purpose. Both are
   * visible whatever this panel is doing, so clearing them from inside it would
   * be a button reaching outside its own section to change something you can
   * see.
   */
  function clearFilters(): void {
    setChips(new Map());
    setMealType('any');
    setSortId(DEFAULT_SORT_ID);
    // Leaves the all/any toggle where it is on purpose. With no chips switched
    // on it filters nothing, so resetting it would change no result and forget a
    // preference the user set deliberately.
  }

  return (
    <main className="screen">
      <div className="header">
        <h1>Recipes</h1>
        <div className="sub">
          {shown.length} of {recipes.size}
          {avoided.length > 0 && ` · ${avoided.length} hidden by your allergies`}
        </div>
      </div>

      {/* Adding a recipe belongs on the screen full of recipes, not buried in
          Settings next to the bulk JSON importer — those are different jobs done
          by different people on different days. */}
      <button className="btn primary block" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>
        Add a recipe
      </button>

      <input
        type="text"
        placeholder="Search recipes"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginTop: 10 }}
      />

      {/* --- Filters ------------------------------------------------------ */}
      <CollapsibleSection
        id="recipes:filters"
        title="Filter & sort"
        defaultOpen={false}
        closedNote={filterNote}
        noteTone={anyFilter ? 'active' : 'quiet'}
      >
        {/* At the top, because it changes what every chip below it means. Read
            after making the selection, it is a control that silently rewrote
            what you just asked for. */}
        <h3 className="sub-title" style={{ marginTop: 0 }}>Match</h3>
        <div className="segmented">
          <button aria-pressed={mode === 'all'} onClick={() => setMode('all')}>
            All of them
          </button>
          <button aria-pressed={mode === 'any'} onClick={() => setMode('any')}>
            Any of them
          </button>
        </div>
        <p className="tiny faint" style={{ marginTop: 6, marginBottom: 0 }}>
          {mode === 'all'
            ? 'A recipe has to match every chip you switch on.'
            : 'A recipe only has to match one of the chips you switch on.'}
          {' '}Tap a chip once to include it, again to rule it out, again to clear
          it. Anything ruled out stays out either way.
        </p>

        <h3 className="sub-title">Meal</h3>
        {/* Still one at a time, and still outside the all/any question. It is a
            different kind of thing — which sitting you are cooking for, not what
            you fancy — and a week of "full meals OR snacks" is every recipe
            there is. */}
        <div className="segmented">
          {MEAL_FILTERS.map((m) => (
            <button
              key={m.id}
              aria-pressed={mealType === m.id}
              onClick={() => setMealType(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {FILTER_SECTIONS.map((section) => {
          // A chip the library cannot deliver on is dropped, unless it is
          // switched on: a section whose chips vanished while they were doing
          // something would leave results narrowed with nothing on screen to
          // widen them again.
          //
          // Only the two derived sections are gated this way. `stocked` is built
          // from the taxonomy, and the presets — vegetarian, under 30 min — are
          // seven curated chips rather than twenty-five generated ones.
          const derived = section.id === 'type' || section.id === 'region';
          const offered = derived
            ? section.chips.filter((c) => stocked.has(c.id) || chips.has(c.id))
            : section.chips;
          if (offered.length === 0) return null;

          return (
            <div key={section.id}>
              <h3 className="sub-title">{section.label}</h3>
              <div className="chips wrap">
                {offered.map((chip) => {
                  const chipState = chips.get(chip.id);
                  return (
                    <button
                      key={chip.id}
                      className={`chip${chipState === 'exclude' ? ' excluded' : ''}`}
                      aria-pressed={chipState === 'include'}
                      // Three states and `aria-pressed` only carries two, so the
                      // third is said out loud. Read by ear, a struck-through
                      // chip is otherwise indistinguishable from an untouched one.
                      aria-label={
                        chipState === 'exclude' ? `${chip.label}, ruled out` : chip.label
                      }
                      onClick={() => cycle(chip.id)}
                    >
                      {chip.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        <h3 className="sub-title">Order</h3>
        <div className="field" style={{ marginBottom: 0 }}>
          <select
            aria-label="Sort recipes"
            value={sortId}
            onChange={(e) => setSortId(e.target.value)}
          >
            {RECIPE_SORTS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>

        {anyFilter && (
          <button className="btn block" style={{ marginTop: 10 }} onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </CollapsibleSection>

      {/* Only when there is nothing to add to. Every Add button below is dead in
          that state, and a row of greyed-out buttons with no reason given is the
          kind of thing people take for a broken app. */}
      {!state.plan && (
        <p className="tiny faint" style={{ marginTop: 10 }}>
          No week to add to yet — plan one on This week, and Add will put a meal
          straight into it.
        </p>
      )}

      {avoided.length > 0 && (
        <button
          className="btn block"
          style={{ marginTop: 4, borderColor: 'var(--danger)', color: 'var(--danger)' }}
          aria-pressed={showAvoided}
          onClick={() => setShowAvoided((v) => !v)}
        >
          {showAvoided
            ? 'Hide the ones you avoid'
            : `Show ${avoided.length} hidden by your allergies`}
        </button>
      )}

      {showAvoided && avoided.map((recipe) => {
        const report = checkRecipe(recipe, ingredients, settings.allergens);
        return (
          <div className="card" key={recipe.id} style={{ borderColor: 'var(--danger)' }}>
            <div className="row between">
              <span className="strong">{recipe.name}</span>
              <span className="badge" style={{ background: 'var(--danger)', color: '#fff' }}>
                avoid
              </span>
            </div>
            <div className="tiny" style={{ color: 'var(--danger)', marginTop: 4 }}>
              {describeMatches(report.matches)}
            </div>
            {report.matches.some((m) => m.confidence === 'inferred') && (
              <div className="tiny faint" style={{ marginTop: 4 }}>
                Some of these were matched on the ingredient name rather than
                checked data — worth confirming yourself.
              </div>
            )}
          </div>
        );
      })}

      {shown.length === 0 && (
        <div className="empty">
          <h2>Nothing matches</h2>
          {/* A bare "no results" is a dead end; naming the binding constraint
              tells the user which control to loosen. */}
          <p>
            {rejections.size === 0
              ? 'Try a different search.'
              : `Ruled out by: ${[...rejections.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, n]) => `${REJECTION_LABELS[reason] ?? reason} (${n})`)
                  .join(', ')}.`}
          </p>
          {/* The filter panel is folded by default, so the controls doing this
              may well be off screen and out of mind. A way back that does not
              require finding them first. */}
          {anyFilter && (
            <button className="btn" onClick={clearFilters}>Clear filters</button>
          )}
        </div>
      )}

      {/* A row rather than one big button, because the card now holds a control
          of its own and a button inside a button is not a thing. The text block
          keeps the whole tap target it had. */}
      {shown.map((recipe) => {
        const n = recipeNutrition(recipe, ingredients);
        const cuisine = cuisineOf(recipe);
        // What the taxonomy has not already said. The type and the region are
        // printed in full above them, and repeating `italian` and `pasta` in the
        // tag line is the screen saying the same thing twice.
        const rest = recipe.tags.filter((t) => !TAXONOMY_TAGS.has(t));
        return (
          <div className="card row between" key={recipe.id} style={{ alignItems: 'flex-start' }}>
            <button
              className="grow"
              style={{ background: 'none', border: 0, padding: 0, textAlign: 'left' }}
              onClick={() => setOpen(recipe)}
            >
              <div className="strong">{recipe.name}</div>
              {/* Named, because the list is flat and two members of a family
                  otherwise read as the library having duplicated itself. */}
              {recipe.variantOf && (
                <div className="tiny faint" style={{ marginTop: 2 }}>
                  a variant of {recipes.get(recipe.variantOf)?.name ?? recipe.variantOf}
                </div>
              )}
              <div className="tiny dim" style={{ marginTop: 3 }}>
                {DISH_TYPE_LABELS[primaryDishType(recipe, ingredients)]}
                {cuisine !== null && ` · ${cuisineLabel(cuisine)}`}
              </div>
              <div className="tiny dim" style={{ marginTop: 3 }}>
                {recipe.mealType} · {recipe.prepMinutes + recipe.cookMinutes} min ·{' '}
                {recipe.ingredients.length} ingredients
                {n.coverage > 0.7 && ` · ${Math.round(n.proteinG)} g protein`}
              </div>
              {rest.length > 0 && (
                <div className="tiny faint" style={{ marginTop: 4 }}>
                  {rest.join(' · ')}
                </div>
              )}
            </button>

            <AddToWeek recipe={recipe} state={state} />
          </div>
        );
      })}

      {open && (
        <Sheet title={open.name} onClose={() => setOpen(null)}>
          <RecipeDetail recipe={open} state={state} unitSystem={settings.unitSystem} />
        </Sheet>
      )}

      {adding && <AddRecipeSheet state={state} onClose={() => setAdding(false)} />}
    </main>
  );
}

/**
 * Puts one recipe into this week, from the list.
 *
 * Its own component so each row owns its in-flight state rather than the screen
 * holding a set of ids mid-write, and so a list of two hundred recipes re-renders
 * one row when one row changes.
 *
 * Portions come from the week's own shape rather than from the recipe: a meal
 * joining a week where every full meal is four portions should be four, and the
 * stepper on This week is right there for the exception.
 *
 * Once it is in the week the button becomes a badge. There is nothing left to
 * press — a plan holds a recipe once — and a disabled button that says "Added"
 * invites the press anyway.
 */
function AddToWeek({ recipe, state }: { recipe: Recipe; state: AppState }): JSX.Element {
  const [saving, setSaving] = useState(false);
  const { plan, settings } = state;

  if (plan?.slots.some((s) => s.recipeId === recipe.id)) {
    return <span className="badge accent" style={{ marginTop: 2 }}>planned</span>;
  }

  async function add(): Promise<void> {
    if (!plan) return;
    setSaving(true);
    try {
      await addRecipeToPlan(
        plan.id,
        recipe,
        settings.spec.servingsPerMeal[recipe.mealType] ?? recipe.baseServings,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      className="btn small"
      style={{ flex: '0 0 auto' }}
      disabled={!plan || saving}
      // The visible label is one word in a list of hundreds, which is no use to
      // anyone reading by ear.
      aria-label={`Add ${recipe.name} to this week`}
      onClick={() => void add()}
    >
      {saving ? '…' : 'Add'}
    </button>
  );
}
