/**
 * The shape-and-size controls for the produce grab bag.
 *
 * Shared by the plan screen and settings rather than written twice: the numbers
 * live in settings, but the bag itself is on the plan, and a control that changes
 * one without the other is how the two quietly drift apart. Everything here goes
 * through `resizeWildcards`, so wherever the control is pressed the bag on screen
 * matches the setting immediately.
 */

import { useState } from 'react';

import type { AppState } from '../state/useAppState';
import { resizeWildcards } from '../state/useAppState';
import { updateSettings } from '../db/repository';

/** Nobody needs fifty apples, and a stepper with no ceiling invites a typo. */
const MAX_PER_BAG = 20;

export function GrabBagControls({ state }: { state: AppState }): JSX.Element {
  const { settings, plan, ctx } = state;
  const [applying, setApplying] = useState(false);

  /**
   * Writes the setting, then brings the current bag into line with it.
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

  return (
    <div className="card">
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

      {settings.wildcardSplit ? (
        <>
          <SizeRow
            label="Fruit"
            value={settings.wildcardFruitCount}
            disabled={applying}
            onChange={(n) => void apply({ wildcardFruitCount: n })}
          />
          <SizeRow
            label="Vegetables"
            value={settings.wildcardVegCount}
            disabled={applying}
            onChange={(n) => void apply({ wildcardVegCount: n })}
          />
        </>
      ) : (
        <SizeRow
          label="Items"
          value={settings.wildcardCount}
          disabled={applying}
          onChange={(n) => void apply({ wildcardCount: n })}
        />
      )}

      <div className="hint" style={{ marginTop: 8 }}>
        {settings.wildcardSplit
          ? 'Two draws with their own sizes, so a week never comes back with no fruit in it.'
          : 'One draw across the whole produce shelf, weighted by season and sale price.'}
        {' Set a bag to 0 to turn it off.'}
      </div>
    </div>
  );
}

function SizeRow({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
}): JSX.Element {
  return (
    <div className="row between" style={{ marginTop: 10 }}>
      <span className="grow strong">{label}</span>
      <div className="stepper">
        <button
          aria-label={`Fewer ${label.toLowerCase()}`}
          disabled={disabled || value <= 0}
          onClick={() => onChange(Math.max(0, value - 1))}
        >
          −
        </button>
        <span className="val">{value}</span>
        <button
          aria-label={`More ${label.toLowerCase()}`}
          disabled={disabled || value >= MAX_PER_BAG}
          onClick={() => onChange(Math.min(MAX_PER_BAG, value + 1))}
        >
          +
        </button>
      </div>
    </div>
  );
}
