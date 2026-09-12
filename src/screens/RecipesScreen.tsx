import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { FILTER_PRESETS, explainFilter, type RecipeFilter } from '../domain/filters';
import { recipeNutrition } from '../domain/nutrition';
import { checkRecipe, describeMatches } from '../domain/allergens';
import { formatQuantity } from '../domain/units';
import { scaledGrams, type Recipe } from '../domain/types';
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
  season: 'season',
  search: 'search',
  'too-many-ingredients': 'ingredient count',
  origin: 'source',
};

export function RecipesScreen({ state }: { state: AppState }): JSX.Element {
  const { recipes, ingredients, ctx, settings } = state;
  const [active, setActive] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Recipe | null>(null);
  const [showAvoided, setShowAvoided] = useState(false);
  const [adding, setAdding] = useState(false);

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
          {safe.length} of {recipes.size}
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

      {safe.length === 0 && (
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

      {safe.map((recipe) => {
        const n = recipeNutrition(recipe, ingredients);
        return (
          <button
            key={recipe.id}
            className="card"
            style={{ display: 'block', width: '100%', textAlign: 'left' }}
            onClick={() => setOpen(recipe)}
          >
            <div className="strong">{recipe.name}</div>
            <div className="tiny dim" style={{ marginTop: 3 }}>
              {recipe.mealType} · {recipe.prepMinutes + recipe.cookMinutes} min ·{' '}
              {recipe.ingredients.length} ingredients
              {n.coverage > 0.7 && ` · ${Math.round(n.proteinG)} g protein`}
            </div>
            {recipe.tags.length > 0 && (
              <div className="tiny faint" style={{ marginTop: 4 }}>
                {recipe.tags.join(' · ')}
              </div>
            )}
          </button>
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

function RecipeDetail({
  recipe,
  state,
  unitSystem,
}: {
  recipe: Recipe;
  state: AppState;
  unitSystem: 'metric' | 'imperial';
}): JSX.Element {
  const [servings, setServings] = useState(recipe.baseServings);
  const nutrition = recipeNutrition(recipe, state.ingredients, servings);

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="stepper">
          <button aria-label="Fewer" onClick={() => setServings((s) => Math.max(1, s - 1))}>−</button>
          <span className="val">{servings}</span>
          <button aria-label="More" onClick={() => setServings((s) => s + 1)}>+</button>
          <span className="tiny faint" style={{ marginLeft: 6 }}>portions</span>
        </div>
        <span className="small dim">{recipe.prepMinutes + recipe.cookMinutes} min</span>
      </div>

      {nutrition.coverage > 0.7 && (
        <div className="stat-grid" style={{ marginBottom: 14 }}>
          <div className="stat">
            <div className="v">{Math.round(nutrition.kcal)}</div>
            <div className="k">kcal / serving</div>
          </div>
          <div className="stat">
            <div className="v">{Math.round(nutrition.proteinG)} g</div>
            <div className="k">protein</div>
          </div>
          <div className="stat">
            <div className="v">{Math.round(nutrition.fibreG ?? 0)} g</div>
            <div className="k">fibre</div>
          </div>
        </div>
      )}

      <h3 className="section-title" style={{ marginTop: 0 }}>Ingredients</h3>
      {recipe.ingredients.map((ri, i) => {
        const ing = state.ingredients.get(ri.ingredientId);
        if (!ing) return null;
        const grams = scaledGrams(ri, servings, recipe.baseServings);
        return (
          <div className="row between card tight" key={`${ri.ingredientId}-${i}`}>
            <span className="grow">
              {ing.name}
              {ri.prep && <span className="dim">, {ri.prep}</span>}
              {ri.optional && <span className="badge" style={{ marginLeft: 6 }}>optional</span>}
            </span>
            <span className="small strong">{formatQuantity(grams, ing, unitSystem).text}</span>
          </div>
        );
      })}

      {recipe.steps.length > 0 && (
        <>
          <h3 className="section-title">Method</h3>
          <ol style={{ paddingLeft: 20, margin: 0 }}>
            {recipe.steps.map((step, i) => (
              <li key={i} style={{ marginBottom: 10 }}>{step}</li>
            ))}
          </ol>
        </>
      )}

      {recipe.diets.length > 0 && (
        <p className="tiny faint" style={{ marginTop: 16 }}>
          {recipe.diets.join(' · ')}
        </p>
      )}
    </>
  );
}

function minDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}
