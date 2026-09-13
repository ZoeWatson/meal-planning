import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { addRecipeToPlan } from '../db/repository';
import {
  DEFAULT_SORT_ID, FILTER_GROUPS, FILTER_PRESETS, RECIPE_SORTS, explainFilter, presetLabel,
  sortRecipes, type RecipeFilter,
} from '../domain/filters';
import { recipeNutrition } from '../domain/nutrition';
import { checkRecipe, describeMatches } from '../domain/allergens';
import {
  CUISINE_REGIONS, DISH_TYPES, DISH_TYPE_LABELS, TAXONOMY_TAGS, cuisineLabel,
  cuisineOf, primaryDishType, regionOf,
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
};

const MEAL_FILTERS: ReadonlyArray<{ id: MealType | 'any'; label: string }> = [
  { id: 'any', label: 'Any' },
  { id: 'full', label: 'Full' },
  { id: 'light', label: 'Light' },
  { id: 'snack', label: 'Snacks' },
];

/**
 * Which way the library is sorted into groups.
 *
 * Two axes rather than one nesting, because they answer different moods. "I want
 * pasta" and "I want something Japanese" are both common; "I want Japanese
 * pasta" is not, and building the screen around it would cost every other
 * browse a second tap.
 */
type BrowseAxis = 'type' | 'region';

/**
 * The recipe library.
 *
 * BROWSING AND FILTERING ARE DIFFERENT JOBS and the screen now says so. Browsing
 * — which kind of dish, where it is from — is why you opened the tab, so it sits
 * in the open above the list and its groups are wrapped rather than scrolled
 * sideways: fourteen kinds of dish you can see is a menu, and fourteen you have
 * to flick through is a rumour.
 *
 * Filtering is narrowing something down, which you do second and less often, so
 * it folds. It ships folded and says on its own heading what is currently
 * switched on — the one thing a folded filter panel absolutely must do, since a
 * hidden filter quietly removing half the library is how a good screen becomes a
 * bug report.
 *
 * The filters inside it are in three labelled rows rather than one strip of
 * seven chips. "I am vegetarian", "I have twenty minutes" and "I want something
 * worth eating" are separate decisions, and a single row makes you read all
 * seven to find the one you are making.
 */
export function RecipesScreen({ state }: { state: AppState }): JSX.Element {
  const { recipes, ingredients, ctx, settings } = state;
  const [active, setActive] = useState<Set<string>>(new Set());
  const [mealType, setMealType] = useState<MealType | 'any'>('any');
  const [sortId, setSortId] = useState<string>(DEFAULT_SORT_ID);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Recipe | null>(null);
  const [showAvoided, setShowAvoided] = useState(false);
  const [adding, setAdding] = useState(false);
  const [axis, setAxis] = useState<BrowseAxis>('type');
  /** The group being browsed, or null for the whole library. */
  const [group, setGroup] = useState<string | null>(null);

  const filter = useMemo<RecipeFilter>(() => {
    const merged: RecipeFilter[] = FILTER_PRESETS
      .filter((p) => active.has(p.id))
      .map((p) => p.filter);

    return {
      search: search.trim() || undefined,
      mealTypes: mealType === 'any' ? undefined : [mealType],
      diets: merged.flatMap((f) => f.diets ?? []),
      maxTotalMinutes: minDefined(merged.map((f) => f.maxTotalMinutes)),
      maxIngredientCount: minDefined(merged.map((f) => f.maxIngredientCount)),
      highProteinOnly: merged.some((f) => f.highProteinOnly),
      seasonalOnly: merged.some((f) => f.seasonalOnly),
    };
  }, [active, mealType, search]);

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
   * The groups on offer, counted over what the search and chips have already
   * left — so the counts say what tapping will actually give you rather than
   * what the untouched library holds. Empty groups are dropped: a chip reading
   * "Africa 0" is a chip whose only function is to disappoint.
   */
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const recipe of safe) {
      const key = axis === 'type'
        ? primaryDishType(recipe, ingredients)
        : regionOf(recipe);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const order = axis === 'type'
      ? DISH_TYPES.map((t) => ({ id: t.id as string, label: t.label }))
      : CUISINE_REGIONS.map((r) => ({ id: r.id as string, label: r.label }));
    return order
      // The one being browsed stays even at zero. A search that empties the
      // group you are standing in would otherwise take its chip off the screen,
      // leaving no selected chip, no results, and nothing to press to get back.
      .filter((g) => (counts.get(g.id) ?? 0) > 0 || g.id === group)
      .map((g) => ({ ...g, count: counts.get(g.id) ?? 0 }));
  }, [safe, axis, ingredients, group]);

  /**
   * Grouped AFTER filtering rather than through the filter, because the counts
   * above have to come from the same pass. `RecipeFilter` can do this — the week
   * rules use `dishTypes` and `regions` — but doing it here would mean running
   * the filter twice to find out what each chip is worth.
   */
  const shown = useMemo(() => {
    const inGroup = group === null
      ? safe
      : safe.filter((r) =>
        (axis === 'type' ? primaryDishType(r, ingredients) : regionOf(r)) === group);
    return sortRecipes(inGroup, sortId, ingredients);
  }, [safe, group, axis, ingredients, sortId]);

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
    for (const preset of FILTER_PRESETS) {
      if (active.has(preset.id)) parts.push(presetLabel(preset.id));
    }
    if (sortId !== DEFAULT_SORT_ID) {
      parts.push(RECIPE_SORTS.find((s) => s.id === sortId)!.label.toLowerCase());
    }
    if (parts.length === 0) return 'none';
    if (parts.length <= 3) return parts.join(' · ');
    return `${parts.slice(0, 2).join(' · ')} +${parts.length - 2} more`;
  }, [active, mealType, sortId]);

  const anyFilter = active.size > 0 || mealType !== 'any' || sortId !== DEFAULT_SORT_ID;

  /** Switching axis abandons the group, which belonged to the other one. */
  function browseBy(next: BrowseAxis): void {
    setAxis(next);
    setGroup(null);
  }

  function toggle(id: string): void {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
    setActive(new Set());
    setMealType('any');
    setSortId(DEFAULT_SORT_ID);
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

      {/* --- Browsing ----------------------------------------------------- */}
      {/* In the open, and above the filters, because it is what the tab is for.
          The filters narrow a library; these two chip rows are how you walk
          around it. */}
      <div className="segmented" style={{ marginTop: 10 }}>
        <button aria-pressed={axis === 'type'} onClick={() => browseBy('type')}>
          By type
        </button>
        <button aria-pressed={axis === 'region'} onClick={() => browseBy('region')}>
          By region
        </button>
      </div>

      <div className="chips wrap" style={{ marginTop: 8 }}>
        <button
          className="chip"
          aria-pressed={group === null}
          onClick={() => setGroup(null)}
        >
          All
        </button>
        {groups.map((g) => (
          <button
            key={g.id}
            className="chip"
            aria-pressed={group === g.id}
            // The visible label is a word and a number, and the number means
            // nothing to anyone reading by ear.
            aria-label={`${g.label}, ${g.count} recipes`}
            onClick={() => setGroup(group === g.id ? null : g.id)}
          >
            {g.label} <span className="faint">{g.count}</span>
          </button>
        ))}
      </div>

      {/* --- Filters ------------------------------------------------------ */}
      <CollapsibleSection
        id="recipes:filters"
        title="Filter & sort"
        defaultOpen={false}
        closedNote={filterNote}
        noteTone={anyFilter ? 'active' : 'quiet'}
      >
        <h3 className="sub-title">Meal</h3>
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

        {FILTER_GROUPS.map((fg) => (
          <div key={fg.id}>
            <h3 className="sub-title">{fg.label}</h3>
            <div className="chips wrap">
              {FILTER_PRESETS.filter((p) => p.group === fg.id).map((preset) => (
                <button
                  key={preset.id}
                  className="chip"
                  aria-pressed={active.has(preset.id)}
                  onClick={() => toggle(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        ))}

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

function minDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}
