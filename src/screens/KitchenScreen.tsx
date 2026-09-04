import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import {
  cyclePantryStatus, removePantryItem, removeStaple, setCarryOver,
  upsertPantryItem, upsertStaple,
} from '../db/repository';
import { db } from '../db/database';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatQuantity } from '../domain/units';
import type { Id, Ingredient, PantryItem } from '../domain/types';
import { Sheet } from '../components/Sheet';

const STATUS_LABEL: Record<PantryItem['status'], string> = {
  stocked: 'Stocked',
  low: 'Running low',
  out: 'Out',
};

/**
 * Staples, pantry and leftovers — the three things that change what gets bought
 * without changing what gets cooked.
 */
export function KitchenScreen({ state }: { state: AppState }): JSX.Element {
  const { ingredients, staples, pantry, settings } = state;
  const [picking, setPicking] = useState<'staple' | 'pantry' | null>(null);

  const carryOver = useLiveQuery(() => db.carryOver.toArray(), [], []);

  const stapleRows = useMemo(
    () => staples.map((s) => ({ s, ing: ingredients.get(s.ingredientId) })).filter((r) => r.ing),
    [staples, ingredients],
  );
  const pantryRows = useMemo(
    () => pantry.map((p) => ({ p, ing: ingredients.get(p.ingredientId) })).filter((r) => r.ing),
    [pantry, ingredients],
  );

  return (
    <main className="screen">
      <div className="header"><h1>Kitchen</h1></div>

      {/* --- Staples ------------------------------------------------------ */}
      <h2 className="section-title">Weekly staples</h2>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        Bought every week no matter what is cooked. These never influence which
        meals get planned — they just always land on the list.
      </p>

      {stapleRows.length === 0 && (
        <div className="card small dim">Nothing yet. Milk, bread, coffee — that sort of thing.</div>
      )}

      {stapleRows.map(({ s, ing }) => (
        <div className="card tight row between" key={s.ingredientId}>
          <div className="grow">
            <div className="strong">{ing!.name}</div>
            <div className="tiny dim">{formatQuantity(s.grams, ing!, settings.unitSystem).text}</div>
          </div>
          <button
            className="btn small"
            aria-pressed={s.active}
            onClick={() => void upsertStaple({ ...s, active: !s.active })}
          >
            {s.active ? 'On' : 'Paused'}
          </button>
          <button className="btn small ghost" onClick={() => void removeStaple(s.ingredientId)}>✕</button>
        </div>
      ))}

      <button className="btn block" style={{ marginTop: 8 }} onClick={() => setPicking('staple')}>
        Add a staple
      </button>

      {/* --- Pantry ------------------------------------------------------- */}
      <h2 className="section-title">Pantry</h2>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        Things kept in stock rather than bought weekly. Anything marked stocked is
        treated as free — recipes using it cost nothing extra, which quietly steers
        plans toward what you can already mostly cook. Tap to change status.
      </p>

      {pantryRows.length === 0 && (
        <div className="card small dim">Nothing yet. Salt, oil, spices, flour.</div>
      )}

      {pantryRows.map(({ p, ing }) => (
        <div className="card tight row between" key={p.ingredientId}>
          <button
            className="grow row"
            style={{ background: 'none', border: 0, padding: 0, textAlign: 'left' }}
            onClick={() => void cyclePantryStatus(p.ingredientId)}
          >
            <span className="grow">
              <span className="strong">{ing!.name}</span>
              <span className="gmeta" style={{ display: 'block' }}>
                <span className={`badge${p.status === 'stocked' ? ' accent' : ' warn'}`}>
                  {STATUS_LABEL[p.status]}
                </span>
                {p.status !== 'stocked' && 'will be added to the list'}
                {p.status === 'stocked' && p.usesSincePurchase >= 5 &&
                  `used in ${p.usesSincePurchase} plans since you bought it — probably low?`}
              </span>
            </span>
          </button>
          <button className="btn small ghost" onClick={() => void removePantryItem(p.ingredientId)}>✕</button>
        </div>
      ))}

      <button className="btn block" style={{ marginTop: 8 }} onClick={() => setPicking('pantry')}>
        Add a pantry item
      </button>

      {/* --- Carry-over --------------------------------------------------- */}
      {carryOver.length > 0 && (
        <>
          <h2 className="section-title">Left from previous weeks</h2>
          <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
            Shelf-stable surplus banked when you finished a shop. It is subtracted
            from what needs buying, so the big bag of rice stops being charged as
            waste every week.
          </p>
          {carryOver.map((c) => {
            const ing = ingredients.get(c.ingredientId);
            if (!ing) return null;
            return (
              <div className="card tight row between" key={c.ingredientId}>
                <div className="grow">
                  <div className="strong">{ing.name}</div>
                  <div className="tiny dim">
                    {formatQuantity(c.grams, ing, settings.unitSystem).text} in the cupboard
                  </div>
                </div>
                <button className="btn small ghost" onClick={() => void setCarryOver(c.ingredientId, 0)}>
                  Used up
                </button>
              </div>
            );
          })}
        </>
      )}

      {picking && (
        <IngredientPicker
          title={picking === 'staple' ? 'Add a staple' : 'Add a pantry item'}
          ingredients={ingredients}
          exclude={new Set(
            picking === 'staple'
              ? staples.map((s) => s.ingredientId)
              : pantry.map((p) => p.ingredientId),
          )}
          onClose={() => setPicking(null)}
          onPick={(ing) => {
            if (picking === 'staple') {
              void upsertStaple({
                ingredientId: ing.id,
                grams: ing.purchase.gramsPerPack,
                active: true,
              });
            } else {
              void upsertPantryItem({
                ingredientId: ing.id,
                status: 'stocked',
                usesSincePurchase: 0,
                lastPurchasedISO: new Date().toISOString(),
              });
            }
            setPicking(null);
          }}
        />
      )}
    </main>
  );
}

function IngredientPicker({
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
      .slice(0, 60);
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
