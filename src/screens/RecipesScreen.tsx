import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { addRecipeToPlan } from '../db/repository';
import { FILTER_PRESETS, explainFilter, type RecipeFilter } from '../domain/filters';
import { recipeNutrition } from '../domain/nutrition';
import { checkRecipe, describeMatches } from '../domain/allergens';
import {
  CUISINE_REGIONS, DISH_TYPES, DISH_TYPE_LABELS, TAXONOMY_TAGS, cuisineLabel,
  cuisineOf, primaryDishType, regionOf,
} from '../domain/taxonomy';
import type { Recipe } from '../domain/types';
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

/**
 * Which way the library is sorted into groups.
 *
 * Two axes rather than one nesting, because they answer different moods. "I want
 * pasta" and "I want something Japanese" are both common; "I want Japanese
 * pasta" is not, and building the screen around it would cost every other
 * browse a second tap.
 */
type BrowseAxis = 'type' | 'region';

export function RecipesScreen({ state }: { state: AppState }): JSX.Element {
  const { recipes, ingredients, ctx, settings } = state;
  const [active, setActive] = useState<Set<string>>(new Set());
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
      diets: merged.flatMap((f) => f.diets ?? []),
      maxTotalMinutes: minDefined(merged.map((f) => f.maxTotalMinutes)),
      maxIngredientCount: minDefined(merged.map((f) => f.maxIngredientCount)),
      highProteinOnly: merged.some((f) => f.highProteinOnly),
      seasonalOnly: merged.some((f) => f.seasonalOnly),
    };
  }, [active, search]);

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
    if (group === null) return safe;
    return safe.filter((r) =>
      (axis === 'type' ? primaryDishType(r, ingredients) : regionOf(r)) === group);
  }, [safe, group, axis, ingredients]);

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

      <div className="chips" style={{ marginTop: 10 }}>
        {FILTER_PRESETS.map((preset) => (
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

      {/* --- Browsing ----------------------------------------------------- */}
      <div className="segmented" style={{ marginTop: 10 }}>
        <button aria-pressed={axis === 'type'} onClick={() => browseBy('type')}>
          By type
        </button>
        <button aria-pressed={axis === 'region'} onClick={() => browseBy('region')}>
          By region
        </button>
      </div>

      <div className="chips" style={{ marginTop: 8 }}>
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
