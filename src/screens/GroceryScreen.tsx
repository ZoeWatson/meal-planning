import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { clearChecks, recordCarryOverFromPlan, setChecked } from '../db/repository';
import { carryOverOf } from '../domain/waste';
import type { DisplayLine } from '../domain/grocery';
import { CheckIcon } from '../components/icons';

const AISLE_LABELS: Record<string, string> = {
  produce: 'Produce',
  bakery: 'Bakery',
  meat: 'Meat',
  seafood: 'Seafood',
  dairy: 'Dairy & eggs',
  frozen: 'Frozen',
  grain: 'Grains & pasta',
  legume: 'Legumes',
  canned: 'Tins & jars',
  condiment: 'Condiments',
  oil: 'Oils',
  spice: 'Spices',
  baking: 'Baking',
  beverage: 'Drinks',
  other: 'Other',
};

export function GroceryScreen({
  state,
  onPlan,
}: {
  state: AppState;
  onPlan: () => void;
}): JSX.Element {
  const { plan, groceryLines, groceryList, ingredients } = state;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(false);

  const done = groceryLines.filter((l) => l.checked).length;
  const total = groceryLines.length;
  const remainingWaste = useMemo(
    () => groceryLines.reduce((sum, l) => sum + l.wasteCost, 0),
    [groceryLines],
  );

  if (!plan || total === 0) {
    return (
      <main className="screen">
        <div className="header"><h1>Shopping list</h1></div>
        <div className="empty" style={{ marginTop: '18vh' }}>
          <h2>Nothing to buy yet</h2>
          <p>Plan a week and the list builds itself.</p>
          <button className="btn primary" onClick={onPlan}>Go to the week</button>
        </div>
      </main>
    );
  }

  const visible = hideDone ? groceryLines.filter((l) => !l.checked) : groceryLines;
  const groups = groupByAisle(visible);
  const planId = plan.id;

  /**
   * Ends the shop: shelf-stable surplus becomes next week's starting stock, so the
   * 1 kg bag of rice you opened for a 320 g recipe stops being charged as waste
   * every week thereafter.
   */
  async function finishShop(): Promise<void> {
    if (!groceryList) return;
    const entries = groceryList.lines.flatMap((line) => {
      const ing = ingredients.get(line.ingredientId);
      if (!ing || carryOverOf(ing) !== 'pantry') return [];
      const leftover = line.purchaseGrams - line.neededGrams;
      return leftover > 0 ? [{ ingredientId: line.ingredientId, grams: leftover }] : [];
    });
    await recordCarryOverFromPlan(entries);
    await clearChecks(planId);
  }

  return (
    <main className="screen">
      <div className="header">
        <div className="row between">
          <h1>Shopping list</h1>
          <span className="small dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {done} / {total}
          </span>
        </div>
        <div className="progress">
          <div style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }} />
        </div>
      </div>

      <div className="chips" style={{ marginTop: 10 }}>
        <button className="chip" aria-pressed={hideDone} onClick={() => setHideDone((v) => !v)}>
          {hideDone ? 'Showing what is left' : 'Hide what is in the basket'}
        </button>
        <button className="chip" onClick={() => void clearChecks(planId)}>Untick all</button>
      </div>

      {groups.map(([category, lines]) => (
        <section key={category}>
          <h2 className="aisle">{AISLE_LABELS[category] ?? category}</h2>
          {lines.map((line) => (
            <button
              key={line.ingredientId}
              className={`gline${line.checked ? ' done' : ''}`}
              onClick={() => void setChecked(planId, line.ingredientId, !line.checked)}
              onContextMenu={(e) => {
                e.preventDefault();
                setExpanded(expanded === line.ingredientId ? null : line.ingredientId);
              }}
            >
              <span className="tickbox"><CheckIcon /></span>

              <span className="grow">
                <span className="gname">{line.name}</span>
                <span className="gmeta">
                  {line.fromStaples && <span className="badge">staple</span>}
                  {line.fromPantry && <span className="badge">pantry</span>}
                  {line.fromWildcard && <span className="badge accent">grab bag</span>}
                  {line.wasteCost > 0.35 && <span className="badge warn">may spoil</span>}
                  {line.needText ? `needs ${line.needText}` : null}
                  {line.usedBy.length > 0 && (
                    <>
                      {line.needText ? ' · ' : ''}
                      {expanded === line.ingredientId
                        ? line.usedBy.join(', ')
                        : `${line.usedBy.length} meal${line.usedBy.length === 1 ? '' : 's'}`}
                    </>
                  )}
                </span>
              </span>

              <span className="gqty">{line.buyText}</span>
            </button>
          ))}
        </section>
      ))}

      <div className="card" style={{ marginTop: 24 }}>
        <div className="small dim">
          Roughly <strong>${remainingWaste.toFixed(2)}</strong> of this shop is surplus
          likely to be thrown away — mostly fresh items sold in packs bigger than the
          week needs. Long-press a line to see which meals want it.
        </div>
      </div>

      <button
        className="btn block"
        style={{ marginTop: 10 }}
        onClick={() => void finishShop()}
        disabled={done === 0}
      >
        Finish shop — bank the leftovers
      </button>
      <p className="tiny faint" style={{ marginTop: 6, textAlign: 'center' }}>
        Records shelf-stable surplus so next week's plan knows you already have it.
      </p>
    </main>
  );
}

function groupByAisle(lines: readonly DisplayLine[]): Array<[string, DisplayLine[]]> {
  const groups = new Map<string, DisplayLine[]>();
  for (const line of lines) {
    const existing = groups.get(line.category);
    if (existing) existing.push(line);
    else groups.set(line.category, [line]);
  }
  return [...groups.entries()];
}
