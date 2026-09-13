/**
 * The size controls for one grab bag.
 *
 * Settings only. The switch that decides whether the bag is drawn at all used to
 * be the first thing in this card and is now upstairs with the other eight, under
 * This week screen: a bag's size is a detail of that bag, but "do I want a bread
 * bag at all" is the same question as "do I want a pantry review", and the two
 * were being answered in different places — one of them the week screen, which
 * should be the week.
 *
 * Everything here goes through `resizeWildcards`, so the bag on this week's plan
 * matches the setting as soon as the stepper moves rather than next Monday.
 *
 * One component for all four bags. Produce has two extra controls nothing else
 * has — the fruit/veg split and its two sizes — and that is a real difference
 * rather than a tidiness problem, so it is handled here in the open instead of
 * being smoothed into a config table that would have to describe it anyway.
 */

import { useState } from 'react';

import type { AppState } from '../state/useAppState';
import { resizeWildcards } from '../state/useAppState';
import { updateSettings } from '../db/repository';
import { type GrabBagId, getGrabBag } from '../domain/grabbag';
import { SizeRow } from './SizeRow';

/** Nobody needs fifty apples, and a stepper with no ceiling invites a typo. */
const MAX_PER_BAG = 20;

export function GrabBagControls({
  state,
  bag: bagId,
}: {
  state: AppState;
  bag: GrabBagId;
}): JSX.Element {
  const { settings, plan, ctx } = state;
  const [applying, setApplying] = useState(false);
  const bag = getGrabBag(bagId);
  const on = settings[bag.enabledKey];

  /**
   * Writes the setting, then brings the current bags into line with it.
   *
   * Sequential because `resizeWildcards` re-reads settings — running them
   * together would race and resize against the old numbers half the time.
   */
  async function apply(patch: Parameters<typeof updateSettings>[0]): Promise<void> {
    setApplying(true);
    try {
      await updateSettings(patch);
      if (plan && ctx) await resizeWildcards(ctx, plan);
    } finally {
      setApplying(false);
    }
  }

  /*
    A bag that is off shows the sentence and no steppers, rather than steppers
    that are disabled or that quietly do nothing. The size it had is still in
    settings and comes back untouched when it is switched on again, which is the
    whole reason the switch is a separate thing from a size of zero.
  */
  if (!on) {
    return (
      <div className="card">
        <div className="hint">
          Switched off, so nothing from this shelf is drawn. The size it had is
          waiting for it under This week screen, above.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      {bagId === 'produce' && (
        <div className="segmented">
          <button
            aria-pressed={!settings.wildcardSplit}
            disabled={applying}
            onClick={() => void apply({ wildcardSplit: false })}
          >
            One bag
          </button>
          <button
            aria-pressed={settings.wildcardSplit}
            disabled={applying}
            onClick={() => void apply({ wildcardSplit: true })}
          >
            Fruit &amp; veg
          </button>
        </div>
      )}

      {bagId === 'produce' && settings.wildcardSplit ? (
        <>
          <SizeRow
            label="Fruit"
            value={settings.wildcardFruitCount}
            max={MAX_PER_BAG}
            disabled={applying}
            onChange={(n) => void apply({ wildcardFruitCount: n })}
          />
          <SizeRow
            label="Vegetables"
            value={settings.wildcardVegCount}
            max={MAX_PER_BAG}
            disabled={applying}
            onChange={(n) => void apply({ wildcardVegCount: n })}
          />
        </>
      ) : (
        <SizeRow
          label="Items"
          value={settings[bag.countKey]}
          max={MAX_PER_BAG}
          disabled={applying}
          onChange={(n) => void apply({ [bag.countKey]: n })}
        />
      )}

      <div className="hint" style={{ marginTop: 8 }}>
        {bagId === 'produce'
          ? settings.wildcardSplit
            ? 'Two draws with their own sizes, so a week never comes back with no fruit in it.'
            : 'One draw across the whole produce shelf, weighted by season and sale price.'
          : `One draw across the ${bag.noun} in your library, weighted by what is on sale.`}
      </div>
    </div>
  );
}
