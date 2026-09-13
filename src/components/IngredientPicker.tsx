/**
 * Search the library and pick one ingredient.
 *
 * Shared by every list you can add something to — staples, the pantry — rather
 * than reimplemented beside each of them, because the fiddly parts (search
 * aliases too, hide what is already on the list, cap the results so a phone does
 * not render six hundred rows) are the same fiddly parts every time.
 */

import { useMemo, useState } from 'react';

import type { Id, Ingredient } from '../domain/types';
import { Sheet } from './Sheet';

/** Enough to scroll through, few enough to render instantly on a phone. */
const MAX_RESULTS = 60;

export function IngredientPicker({
  title,
  ingredients,
  exclude,
  onPick,
  onClose,
}: {
  title: string;
  ingredients: ReadonlyMap<Id, Ingredient>;
  exclude: ReadonlySet<Id>;
  onPick: (ing: Ingredient) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...ingredients.values()]
      .filter((i) => !exclude.has(i.id))
      .filter((i) => !needle || i.name.toLowerCase().includes(needle) ||
        i.aliases.some((a) => a.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_RESULTS);
  }, [ingredients, exclude, query]);

  return (
    <Sheet title={title} onClose={onClose}>
      <input
        type="text"
        placeholder="Search ingredients"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 10 }}
      />
      {results.map((ing) => (
        <button
          key={ing.id}
          className="card tight row between"
          style={{ width: '100%', textAlign: 'left' }}
          onClick={() => onPick(ing)}
        >
          <span className="grow">{ing.name}</span>
          <span className="tiny faint">{ing.category}</span>
        </button>
      ))}
      {results.length === 0 && <p className="dim small">No matches.</p>}
    </Sheet>
  );
}
