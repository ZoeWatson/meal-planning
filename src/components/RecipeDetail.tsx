import { useState } from 'react';

import type { AppState } from '../state/useAppState';
import { recipeNutrition } from '../domain/nutrition';
import { formatQuantity } from '../domain/units';
import { scaledGrams, type Recipe } from '../domain/types';

/**
 * What is in a recipe and how to cook it, scaled to a number of portions.
 *
 * Shared by the library and by This week, because "what am I actually making"
 * is the same question in both places and answering it twice would be two
 * answers to keep in step.
 *
 * Portions are either this component's business or the caller's, never both.
 * Left alone it starts at the recipe's own base and keeps the number itself,
 * which is what the library wants — browsing is not planning. Handed a
 * `servings`, it shows that and reports every change instead of storing one, so
 * the stepper here and the stepper on a week's meal card are the same control
 * over the same number rather than two that can disagree.
 */
export function RecipeDetail({
  recipe,
  state,
  unitSystem,
  servings,
  onServingsChange,
}: {
  recipe: Recipe;
  state: AppState;
  unitSystem: 'metric' | 'imperial';
  servings?: number;
  onServingsChange?: (servings: number) => void;
}): JSX.Element {
  const [ownServings, setOwnServings] = useState(recipe.baseServings);
  const count = servings ?? ownServings;
  const nutrition = recipeNutrition(recipe, state.ingredients, count);

  function setCount(next: number): void {
    const clamped = Math.max(1, next);
    if (servings === undefined) setOwnServings(clamped);
    onServingsChange?.(clamped);
  }

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="stepper">
          <button aria-label="Fewer" onClick={() => setCount(count - 1)}>−</button>
          <span className="val">{count}</span>
          <button aria-label="More" onClick={() => setCount(count + 1)}>+</button>
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
        const grams = scaledGrams(ri, count, recipe.baseServings);
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
