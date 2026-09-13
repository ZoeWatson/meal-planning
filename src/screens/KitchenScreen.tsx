import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { removeStaple, setCarryOver, upsertStaple } from '../db/repository';
import { db } from '../db/database';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatQuantity } from '../domain/units';
import { IngredientPicker } from '../components/IngredientPicker';

/**
 * Weekly staples and banked leftovers — the things that change what gets bought
 * without changing what gets cooked.
 *
 * The pantry used to live here too and now has its own section in settings, with
 * the week-to-week half of it on the plan screen: what is in the cupboard is a
 * question you answer a few times a year, and what is left of it is one you
 * answer before every shop. They were never the same screen.
 *
 * `embedded` drops the screen chrome so the same component can live inside a
 * sheet. It moved off the tab bar when Cook arrived — six tabs is the ceiling on a
 * phone, and topping up the staples list is a monthly job while cooking is a
 * daily one.
 */
export function KitchenScreen({
  state, embedded = false,
}: {
  state: AppState;
  embedded?: boolean;
}): JSX.Element {
  const { ingredients, staples, settings } = state;
  const [picking, setPicking] = useState(false);

  const carryOver = useLiveQuery(() => db.carryOver.toArray(), [], []);

  const stapleRows = useMemo(
    () => staples.map((s) => ({ s, ing: ingredients.get(s.ingredientId) })).filter((r) => r.ing),
    [staples, ingredients],
  );

  const body = (
    <>
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

      <button className="btn block" style={{ marginTop: 8 }} onClick={() => setPicking(true)}>
        Add a staple
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
          title="Add a staple"
          ingredients={ingredients}
          exclude={new Set(staples.map((s) => s.ingredientId))}
          onClose={() => setPicking(false)}
          onPick={(ing) => {
            void upsertStaple({
              ingredientId: ing.id,
              grams: ing.purchase.gramsPerPack,
              active: true,
            });
            setPicking(false);
          }}
        />
      )}
    </>
  );

  if (embedded) return body;
  return (
    <main className="screen">
      <div className="header"><h1>Kitchen</h1></div>
      {body}
    </main>
  );
}
