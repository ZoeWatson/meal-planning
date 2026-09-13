/**
 * How many treats to draw.
 *
 * Settings only, and split from its switch for the same reason `GrabBagControls`
 * is: whether the bag is drawn at all is one of the nine section switches under
 * This week screen, and the week screen itself is left to show the week.
 */

import { useState } from 'react';

import type { AppState } from '../state/useAppState';
import { resizeTreats } from '../state/useAppState';
import { updateSettings } from '../db/repository';
import { MAX_TREAT_CENTS } from '../domain/treats';
import { formatMoneyShort } from '../domain/budget';
import { SizeRow } from './SizeRow';

/** Four of each kind is already more treats than a week has room for. */
const MAX_TREATS = 12;

export function TreatControls({ state }: { state: AppState }): JSX.Element {
  const { settings, plan } = state;
  const [applying, setApplying] = useState(false);

  /** Writes the setting, then brings the bag on screen into line with it. */
  async function apply(count: number): Promise<void> {
    setApplying(true);
    try {
      await updateSettings({ treatCount: count });
      if (plan) await resizeTreats(plan);
    } finally {
      setApplying(false);
    }
  }

  if (!settings.treatBagEnabled) {
    return (
      <div className="card">
        <div className="hint">
          Switched off, so no treats are drawn. The size it had is waiting for it
          under This week screen, above.
        </div>
      </div>
    );
  }

  // The rules the bag draws by, on the card's tooltip rather than under the
  // stepper as standing copy. They are worth reading once and then never again,
  // and as body text they are three lines of explanation in the way of the thing
  // being explained. The long version is in Works cited.
  const rules =
    'A tea, a thing to eat and a thing that is not food, in that rotation, so ' +
    'the bag never quietly becomes a snack list. Nothing in it costs more than ' +
    `${formatMoneyShort(MAX_TREAT_CENTS, settings.currency)}.`;

  return (
    <div className="card" title={rules}>
      <SizeRow
        label="Treats"
        value={settings.treatCount}
        max={MAX_TREATS}
        disabled={applying}
        onChange={(n) => void apply(n)}
      />
    </div>
  );
}
