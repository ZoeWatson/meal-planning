/**
 * The pantry, in its two places.
 *
 * `PantrySettings` is the slow half: what lives in the cupboard and how much
 * each thing matters. That changes a few times a year.
 *
 * `PantryReview` is the fast half: what is left of each, and what to pick up
 * this week. That changes every shop, which is why it sits on the plan screen
 * next to everything else you are about to buy rather than three taps into
 * settings where nobody would ever look at it.
 *
 * One file because they are one subject and share the same rules; two exports
 * because they answer questions asked days apart.
 */

import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import {
  removePantryItem, setPantryNecessity, setPantryRestock, setPantryStock, upsertPantryItem,
} from '../db/repository';
import {
  DEFAULT_NECESSITY, NECESSITIES, NECESSITY_HINTS, NECESSITY_LABELS, PANTRY_STOCKS,
  STOCK_LABELS, describeItem, isOnList, nameOrder, necessityOf, reviewOrder,
} from '../domain/pantry';
import type { PantryItem, PantryNecessity, PantryStock } from '../domain/types';
import { IngredientPicker } from '../components/IngredientPicker';
import { Sheet } from '../components/Sheet';

/** Roughly a month of cooking with something before "is that still full?" is fair. */
const NUDGE_AFTER_USES = 5;

/** Fits beside a name where the full labels do not. */
const STOCK_SHORT: Record<PantryStock, string> = { stocked: 'In', low: 'Low', out: 'Out' };

/**
 * Rows per page in the full list.
 *
 * Sized against the sheet rather than picked round: eight rows and the pager
 * land inside a bottom sheet on a small phone, where ten put the pager under
 * the fold on anything shorter than a large one. A pager you have to go looking
 * for is a pager nobody presses, and then the list is just as long as it was.
 */
const PAGE_SIZE = 8;

// ---------------------------------------------------------------------------
// Settings: what is in the pantry, and how much each thing matters
// ---------------------------------------------------------------------------

export function PantrySettings({ state }: { state: AppState }): JSX.Element {
  const { ingredients, pantry } = state;
  const [picking, setPicking] = useState(false);

  const rows = useMemo(() => nameOrder(pantry, ingredients), [pantry, ingredients]);

  return (
    <>
      {rows.length === 0 && (
        <div className="card small dim">Nothing yet. Salt, oil, spices, flour.</div>
      )}

      {rows.map(({ item, ingredient }) => {
        const necessity = necessityOf(item);
        return (
          <div className="card tight" key={item.ingredientId}>
            <div className="row between">
              <div className="grow">
                <div className="strong">{ingredient.name}</div>
                <div className="tiny dim">{NECESSITY_HINTS[necessity]}</div>
              </div>
              <button
                className="btn small ghost"
                aria-label={`Remove ${ingredient.name} from the pantry`}
                onClick={() => void removePantryItem(item.ingredientId)}
              >
                ✕
              </button>
            </div>

            <select
              aria-label={`How much ${ingredient.name} matters`}
              value={necessity}
              style={{ marginTop: 8 }}
              onChange={(e) => void setPantryNecessity(
                item.ingredientId,
                e.target.value as PantryNecessity,
              )}
            >
              {NECESSITIES.map((n) => (
                <option key={n} value={n}>{NECESSITY_LABELS[n]}</option>
              ))}
            </select>
          </div>
        );
      })}

      <button className="btn block" style={{ marginTop: 8 }} onClick={() => setPicking(true)}>
        Add a pantry item
      </button>

      {picking && (
        <IngredientPicker
          title="Add a pantry item"
          ingredients={ingredients}
          exclude={new Set(pantry.map((p) => p.ingredientId))}
          onClose={() => setPicking(false)}
          onPick={(ing) => {
            void upsertPantryItem({
              ingredientId: ing.id,
              status: 'stocked',
              necessity: DEFAULT_NECESSITY,
              usesSincePurchase: 0,
              lastPurchasedISO: new Date().toISOString(),
            });
            setPicking(false);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// This week: what is left, and what to buy
// ---------------------------------------------------------------------------

/**
 * What the plan screen shows without being asked: the pantry items this week's
 * shop is picking up, and a way in to the rest.
 *
 * Not the whole cupboard. Thirty rows of things you already have is not a
 * review, it is a wall, and it would push the grab bag and the treats off the
 * bottom of a screen that is already long. What is on the list is the part that
 * changes what you do today; everything else is one tap away.
 */
export function PantryReview({ state }: { state: AppState }): JSX.Element {
  const { ingredients, pantry } = state;
  const [browsing, setBrowsing] = useState(false);

  const onList = useMemo(
    () => reviewOrder(pantry.filter(isOnList), ingredients),
    [pantry, ingredients],
  );

  if (pantry.length === 0) {
    return (
      <div className="card small dim">
        Nothing in the pantry yet. Add salt, oil, spices and flour in Settings and
        they turn up here to be checked before a shop.
      </div>
    );
  }

  return (
    <>
      {onList.length === 0 ? (
        <p className="tiny faint" style={{ margin: '0 0 8px' }}>
          Nothing from the pantry this week. Anything you are low on that matters
          enough lands here on its own; add the rest yourself.
        </p>
      ) : (
        onList.map(({ item, ingredient }) => (
          <PantryRow key={item.ingredientId} item={item} name={ingredient.name} />
        ))
      )}

      <button className="btn block" style={{ marginTop: 8 }} onClick={() => setBrowsing(true)}>
        Review all {pantry.length} pantry items
      </button>

      {browsing && <PantrySheet state={state} onClose={() => setBrowsing(false)} />}
    </>
  );
}

/**
 * The whole cupboard, a page at a time.
 *
 * Alphabetical rather than in review order, which is the opposite of the short
 * list outside: paging only works if a row stays where you left it, and sorting
 * by "needs attention" means every tick you make jumps the row you just ticked
 * onto some other page. With thirty items the question here is "where is the
 * salt", and that wants the same answer every time.
 */
function PantrySheet({ state, onClose }: { state: AppState; onClose: () => void }): JSX.Element {
  const { ingredients, pantry } = state;
  const [page, setPage] = useState(0);

  const rows = useMemo(() => nameOrder(pantry, ingredients), [pantry, ingredients]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // Derived rather than corrected in an effect: removing the last item on the
  // last page would otherwise strand you on an empty one.
  const current = Math.min(page, pageCount - 1);
  const from = current * PAGE_SIZE;
  const shown = rows.slice(from, from + PAGE_SIZE);

  return (
    <Sheet title="Pantry" onClose={onClose}>
      <p className="tiny faint" style={{ margin: '0 0 10px' }}>
        Say what is left of each. The tick adds one to the shopping list whatever
        its necessity says, or takes it off.
      </p>

      {shown.map(({ item, ingredient }) => (
        <PantryRow key={item.ingredientId} item={item} name={ingredient.name} />
      ))}

      {pageCount > 1 && (
        <div className="pager" style={{ marginTop: 12 }}>
          <button
            aria-label="Previous page"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            ‹
          </button>
          <span className="grow tiny faint" style={{ textAlign: 'center' }}>
            {from + 1}–{from + shown.length} of {rows.length}
          </span>
          <button
            aria-label="Next page"
            disabled={current >= pageCount - 1}
            onClick={() => setPage(current + 1)}
          >
            ›
          </button>
        </div>
      )}
    </Sheet>
  );
}

/**
 * One item, one line: name, stock, and on-the-list.
 *
 * Necessity and the reason a thing is or is not on the list do not fit, so they
 * are carried by the row's tooltip and the tick's label rather than dropped — a
 * list you cannot interrogate is one you stop trusting, and "why is there flour
 * on here, I have flour" still deserves an answer.
 */
function PantryRow({ item, name }: { item: PantryItem; name: string }): JSX.Element {
  const onList = isOnList(item);

  // The one thing the pantry can tell you that you did not tell it first: you
  // said this was stocked, and the plans since have called for it repeatedly.
  const nudge = item.status === 'stocked' && item.usesSincePurchase >= NUDGE_AFTER_USES;

  const why = nudge
    ? `${describeItem(item)}, but used in ${item.usesSincePurchase} plans since you bought it`
    : describeItem(item);

  return (
    <div className="prow" title={why}>
      <span className="pname">{name}</span>

      {nudge && <span className="badge warn" style={{ marginRight: 0 }}>low?</span>}

      <div className="segmented mini">
        {PANTRY_STOCKS.map((stock) => (
          <button
            key={stock}
            aria-pressed={item.status === stock}
            aria-label={`${name}: ${STOCK_LABELS[stock].toLowerCase()}`}
            onClick={() => void setPantryStock(item.ingredientId, stock)}
          >
            {STOCK_SHORT[stock]}
          </button>
        ))}
      </div>

      <button
        className="ptick"
        aria-pressed={onList}
        aria-label={onList
          ? `Take ${name} off the shopping list (${why})`
          : `Add ${name} to the shopping list (${why})`}
        onClick={() => void setPantryRestock(item.ingredientId, !onList)}
      >
        {onList ? '✓' : '+'}
      </button>
    </div>
  );
}
