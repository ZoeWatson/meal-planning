/**
 * The grab bags on the plan screen: one section per bag, each with its own
 * redraw and its own contents.
 *
 * Lifted out of `PlanScreen` when there were four of them rather than one. The
 * screen had a `useMemo` grouping wildcards by fruit and vegetable, a redraw
 * button and a list, all of which are per-bag — four copies of that inline is
 * unreadable, and one loop over `GRAB_BAGS` is not.
 *
 * A bag that is switched off renders nothing at all — not a heading, not an
 * explanation of how to switch it back on. Its switch is one of the nine in
 * Settings under This week screen, and the point of switching a section off is
 * that the screen is shorter afterwards; a stub saying "this is off" is the
 * clutter the switch was meant to remove.
 *
 * The contents of each bag are worked out from the ingredients themselves rather
 * than from draw order, because promoting and removing items edit the list in
 * place, and a plan drawn before a bag existed has no order to rely on in the
 * first place.
 */

import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { redrawWildcards } from '../state/useAppState';
import { removeWildcard, setWildcardPromoted } from '../db/repository';
import { type BagLane, type GrabBagId, GRAB_BAGS, lanesOf } from '../domain/grabbag';
import { seasonStatus } from '../domain/seasonality';
import { formatQuantity } from '../domain/units';
import type { Ingredient, WildcardItem } from '../domain/types';
import { ShuffleIcon } from '../components/icons';
import { CollapsibleSection } from '../components/CollapsibleSection';

export function GrabBagSections({ state }: { state: AppState }): JSX.Element {
  const [redrawing, setRedrawing] = useState<GrabBagId | null>(null);

  // Filtered here rather than inside each section so that "first" means the first
  // bag actually on screen. The sentence about promoting and redrawing is written
  // once, under whichever bag that turns out to be — hanging it on the produce bag
  // would lose it entirely for anyone who has switched the produce bag off.
  const shown = GRAB_BAGS.filter((bag) => state.settings[bag.enabledKey]);

  return (
    <>
      {shown.map((bag, i) => (
        <BagSection
          key={bag.id}
          state={state}
          bag={bag.id}
          first={i === 0}
          redrawing={redrawing === bag.id}
          onRedraw={async () => {
            if (!state.ctx || !state.plan) return;
            setRedrawing(bag.id);
            try {
              await redrawWildcards(state.ctx, state.plan, bag.id);
            } finally {
              setRedrawing(null);
            }
          }}
        />
      ))}
    </>
  );
}

function BagSection({
  state,
  bag: bagId,
  first,
  redrawing,
  onRedraw,
}: {
  state: AppState;
  bag: GrabBagId;
  /** First bag on screen, which is where the shared instructions go. */
  first: boolean;
  redrawing: boolean;
  onRedraw: () => Promise<void>;
}): JSX.Element {
  const { plan, ctx, ingredients, settings } = state;
  const bag = GRAB_BAGS.find((b) => b.id === bagId)!;
  const lanes = lanesOf(bag, settings);

  /** This bag's items, split across its lanes. One lane for everything but a split produce bag. */
  const groups = useMemo(
    () =>
      lanes.map((lane) => ({
        lane,
        items: (plan?.wildcards ?? []).filter((w) => {
          const ing = ingredients.get(w.ingredientId);
          return ing !== undefined && lane.holds(ing);
        }),
      })),
    // `lanes` is rebuilt on every render, so the settings it is derived from are
    // the honest dependency.
    [plan?.wildcards, ingredients, settings],
  );

  /** What the bag holds across all its lanes, for the heading while it is folded. */
  const drawn = groups.reduce((n, group) => n + group.items.length, 0);

  return (
    <CollapsibleSection
      id={bag.id}
      title={bag.title}
      closedNote={drawn === 0 ? 'empty' : `${drawn} drawn`}
      actions={
        <button className="btn small" disabled={redrawing || !ctx} onClick={() => void onRedraw()}>
          <span className="row" style={{ gap: 6 }}>
            <ShuffleIcon size={15} />
            {redrawing ? 'Drawing…' : 'Redraw'}
          </span>
        </button>
      }
    >
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        {bag.blurb}
        {/*
          How promoting and redrawing work is said once, under the first bag,
          rather than four times down the screen. It is the same sentence for all
          of them, and by the cheese bag nobody is reading it.
        */}
        {first &&
          " Promote one to build next week's plan around it, or redraw a bag" +
            ' without touching the meals or the other bags.'}
      </p>

      {groups.map(({ lane, items }) => (
        <div key={lane.key}>
          {/* A sub-heading only earns its place when a bag has more than one lane. */}
          {groups.length > 1 && <h3 className="sub-title">{lane.label}</h3>}
          {items.length === 0 && (
            <p className="tiny faint" style={{ margin: '6px 0 10px' }}>
              {emptyBagReason(lane, groups.length > 1 ? lane.label.toLowerCase() : bag.noun)}
            </p>
          )}
          {items.map((w) => (
            <BagRow
              key={w.ingredientId}
              item={w}
              ingredient={ingredients.get(w.ingredientId)}
              state={state}
            />
          ))}
        </div>
      ))}
    </CollapsibleSection>
  );
}

function BagRow({
  item,
  ingredient,
  state,
}: {
  item: WildcardItem;
  ingredient: Ingredient | undefined;
  state: AppState;
}): JSX.Element | null {
  const { plan, ctx, settings } = state;
  if (!ingredient || !plan) return null;

  // Only produce gets a season badge. `seasonStatus` answers "peak" for anything
  // that is not produce — a scoring convenience, so that a box of pasta never
  // costs a plan a seasonality penalty — and reading that as a fact about the
  // world puts a PEAK badge on a focaccia.
  const peak =
    ingredient.category === 'produce' &&
    ctx !== null &&
    seasonStatus(ingredient, ctx.month, ctx.region) === 'peak';

  return (
    <div className="card tight row between">
      <div className="grow">
        <div className="row" style={{ gap: 6 }}>
          <span className="strong">{ingredient.name}</span>
          {peak && <span className="badge accent">peak</span>}
        </div>
        <div className="tiny dim">
          {formatQuantity(item.grams, ingredient, settings.unitSystem).text}
        </div>
      </div>
      <button
        className="btn small"
        aria-pressed={item.promoted}
        style={item.promoted ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
        onClick={() => void setWildcardPromoted(plan.id, item.ingredientId, !item.promoted)}
      >
        {item.promoted ? 'Promoted' : 'Promote'}
      </button>
      <button
        className="btn small ghost"
        aria-label={`Remove ${ingredient.name}`}
        onClick={() => void removeWildcard(plan.id, item.ingredientId)}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Why a lane came back empty.
 *
 * A zero size is a choice; anything else means the library has nothing left to
 * offer once exclusions are applied, and saying which is the difference between a
 * fixable problem and a screen that looks broken. A bag switched off is not a
 * third case — the whole section is gone before this is reached.
 */
function emptyBagReason(lane: BagLane, noun: string): string {
  if (lane.count === 0) return 'Set to zero.';
  return `No ${noun} left to draw — add more to the library, or check what you have excluded.`;
}
