import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { updateSettings } from '../db/repository';
import { ALLERGEN_GROUPS, checkRecipe } from '../domain/allergens';
import type { Id, Ingredient } from '../domain/types';
import { Sheet } from '../components/Sheet';

/**
 * Allergies.
 *
 * Half of a pair that behaves differently on purpose, and is two components for
 * that reason rather than one with a divider down the middle. Allergens are
 * safety-critical: they rule out whole groups, and anything matching gets a
 * visible warning wherever it could still appear. `DislikeSettings` below is a
 * preference and filters quietly, because nobody needs a red banner about
 * mushrooms.
 *
 * Neither writes its own heading. Settings folds them as separate sections, and
 * a component that prints a heading cannot be put behind one.
 */
export function AllergySettings({ state }: { state: AppState }): JSX.Element {
  const { settings, ingredients, recipes } = state;

  const active = settings.allergens;

  /**
   * How much of the library each choice removes.
   *
   * Shown because "no recipes match" three screens later is a mystery, whereas
   * "tree nuts rules out 4 recipes" at the moment of choosing is information.
   */
  const impact = useMemo(() => {
    if (active.length === 0) return null;
    let blocked = 0;
    let unverifiable = 0;
    for (const recipe of recipes.values()) {
      const report = checkRecipe(recipe, ingredients, active);
      if (report.hasMatch) blocked++;
      else if (report.unverifiable.length > 0) unverifiable++;
    }
    return { blocked, unverifiable, total: recipes.size };
  }, [recipes, ingredients, active]);

  async function toggleAllergen(id: string): Promise<void> {
    await updateSettings({
      allergens: active.includes(id)
        ? active.filter((a) => a !== id)
        : [...active, id],
    });
  }

  return (
    <>
      {ALLERGEN_GROUPS.map((group) => {
        const on = active.includes(group.id);
        return (
          <button
            key={group.id}
            className="card tight row between"
            style={{
              width: '100%', textAlign: 'left',
              ...(on ? { borderColor: 'var(--danger)' } : {}),
            }}
            aria-pressed={on}
            onClick={() => void toggleAllergen(group.id)}
          >
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="strong" style={on ? { color: 'var(--danger)' } : undefined}>
                {group.label}
              </span>
              <span className="gmeta" style={{ display: 'block' }}>{group.covers}</span>
            </span>
            <span
              className={`badge${on ? ' warn' : ''}`}
              style={on ? { background: 'var(--danger)', color: '#fff' } : undefined}
            >
              {on ? 'avoiding' : 'off'}
            </span>
          </button>
        );
      })}

      {impact && (
        <div className="card small dim" style={{ marginTop: 4 }}>
          Rules out <strong>{impact.blocked}</strong> of {impact.total} recipes.
          {impact.unverifiable > 0 && (
            <> {impact.unverifiable} more contain an ingredient this app does not
            recognise, so they cannot be checked either way — those are flagged
            rather than hidden.</>
          )}
        </div>
      )}

      {/* The limits have to be stated where the promise is made, not buried in a
          help page. An allergen filter that quietly implies more certainty than it
          has is worse than no filter at all. */}
      {active.length > 0 && (
        <div
          className="card small"
          style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)' }}
        >
          <strong style={{ color: 'var(--warn)' }}>Still read the labels.</strong>
          <div className="dim" style={{ marginTop: 4 }}>
            This matches the ingredient list in the app. It cannot know about
            processing, shared equipment, "may contain" warnings, or what is inside
            a shop-bought sauce. Treat it as a filter that saves you time, not as a
            safety check.
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Individual ingredients to keep out of plans — dislikes, not allergies.
 *
 * Deliberately plain. Nothing here is red, nothing warns, and nothing is flagged
 * on a recipe later: a quiet filter is the whole promise, and dressing it like
 * the allergen list above would teach people that the red styling means nothing.
 */
export function DislikeSettings({ state }: { state: AppState }): JSX.Element {
  const { settings, ingredients, allergenExclusions } = state;
  const [picking, setPicking] = useState(false);

  async function removeExcluded(ingredientId: Id): Promise<void> {
    await updateSettings({
      excludedIngredients: settings.excludedIngredients.filter((i) => i !== ingredientId),
    });
  }

  return (
    <>
      {settings.excludedIngredients.length === 0 && (
        <div className="card small dim">Nothing excluded.</div>
      )}

      {settings.excludedIngredients.map((id) => {
        const ing = ingredients.get(id);
        return (
          <div className="card tight row between" key={id}>
            <span className="grow truncate">{ing?.name ?? id}</span>
            <button
              className="btn small ghost"
              aria-label={`Stop excluding ${ing?.name ?? id}`}
              onClick={() => void removeExcluded(id)}
            >
              ✕
            </button>
          </div>
        );
      })}

      <button className="btn block" style={{ marginTop: 8 }} onClick={() => setPicking(true)}>
        Add an ingredient
      </button>

      {allergenExclusions.length > 0 && (
        <p className="tiny faint" style={{ marginTop: 8 }}>
          Your allergies already rule out {allergenExclusions.length} further
          ingredient{allergenExclusions.length === 1 ? '' : 's'} automatically.
        </p>
      )}

      {picking && (
        <ExcludePicker
          ingredients={ingredients}
          exclude={new Set(settings.excludedIngredients)}
          onClose={() => setPicking(false)}
          onPick={async (ing) => {
            await updateSettings({
              excludedIngredients: [...settings.excludedIngredients, ing.id],
            });
            setPicking(false);
          }}
        />
      )}
    </>
  );
}

function ExcludePicker({
  ingredients, exclude, onPick, onClose,
}: {
  ingredients: ReadonlyMap<Id, Ingredient>;
  exclude: ReadonlySet<Id>;
  onPick: (ing: Ingredient) => void | Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...ingredients.values()]
      .filter((i) => !exclude.has(i.id))
      .filter((i) => !needle || i.name.toLowerCase().includes(needle)
        || i.aliases.some((a) => a.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 60);
  }, [ingredients, exclude, query]);

  return (
    <Sheet title="Never plan" onClose={onClose}>
      <input
        type="text" placeholder="Search ingredients" value={query} autoFocus
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 10 }}
      />
      {results.map((ing) => (
        <button
          key={ing.id}
          className="card tight row between"
          style={{ width: '100%', textAlign: 'left' }}
          onClick={() => void onPick(ing)}
        >
          <span className="grow">{ing.name}</span>
          <span className="tiny faint">{ing.category}</span>
        </button>
      ))}
      {results.length === 0 && <p className="dim small">No matches.</p>}
    </Sheet>
  );
}
