/**
 * One switch per section of the This week screen.
 *
 * The switches used to sit on the week screen itself, under the section each one
 * controlled, which put a settings panel between the user and every single thing
 * they had come to that screen to look at. A screen you read every day should be
 * the week, and the knobs that shape it belong here.
 *
 * Two groups rather than one list, because "off" honestly means two different
 * things. A bag that is off is not drawn — it never reaches the plan, the
 * shopping list or the spend. A section that is off is merely not on the screen,
 * and the week is exactly as it was. Both are worth having, and a single
 * undifferentiated list of nine switches would quietly imply they are the same
 * promise.
 */

import { useState } from 'react';

import type { AppState } from '../state/useAppState';
import { resizeTreats, resizeWildcards } from '../state/useAppState';
import { updateSettings } from '../db/repository';
import type { AppSettings } from '../db/database';
import { DISPLAY_SECTIONS, DRAWN_SECTIONS, type WeekSection } from '../domain/weekSections';

export function WeekSectionsSettings({ state }: { state: AppState }): JSX.Element {
  const { settings, plan, ctx } = state;
  const [applying, setApplying] = useState<string | null>(null);

  /**
   * Writes the switch, then brings this week into line with it.
   *
   * Only the bags need the second half, and only their own half of it: a switch
   * that changes what is drawn has to refit the current week, or the change would
   * not show up until next Monday. Sequential, and everything disabled while it
   * runs, because the refit re-reads settings — two switches in flight at once
   * would resize against each other's old numbers.
   */
  async function apply(section: WeekSection, on: boolean): Promise<void> {
    setApplying(section.id);
    try {
      await updateSettings({ [section.enabledKey]: on } as Partial<AppSettings>);
      if (section.effect === 'grab-bag' && plan && ctx) await resizeWildcards(ctx, plan);
      if (section.effect === 'treat-bag' && plan) await resizeTreats(plan);
    } finally {
      setApplying(null);
    }
  }

  return (
    <>
      <h3 className="sub-title">What is drawn</h3>
      <p className="tiny faint" style={{ margin: '-2px 0 8px' }}>
        Switching a bag off empties it: nothing from that shelf reaches the plan or
        the shopping list. The size it had is kept for when you switch it back on,
        and each bag's size is under Grab bags and Treats below.
      </p>
      {DRAWN_SECTIONS.map((section) => (
        <SwitchRow
          key={section.id}
          section={section}
          on={settings[section.enabledKey]}
          busy={applying !== null}
          onToggle={(next) => void apply(section, next)}
        />
      ))}

      <h3 className="sub-title">What is on the screen</h3>
      <p className="tiny faint" style={{ margin: '-2px 0 8px' }}>
        Switching one of these off only takes it off the This week screen. The plan,
        the shopping list and the spend are all exactly as they were.
      </p>
      {DISPLAY_SECTIONS.map((section) => (
        <SwitchRow
          key={section.id}
          section={section}
          on={settings[section.enabledKey]}
          busy={applying !== null}
          onToggle={(next) => void apply(section, next)}
        />
      ))}
    </>
  );
}

/**
 * One labelled Off/On switch.
 *
 * Declared out here rather than inside the screen: a component defined during
 * render is a new component type every render, so React tears the row down and
 * rebuilds it on every press — which loses keyboard focus on the button that was
 * just pressed, on a control whose whole job is to be pressed.
 */
function SwitchRow({
  section,
  on,
  busy,
  onToggle,
}: {
  section: WeekSection;
  on: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  return (
    <div className="card tight">
      <div className="row between">
        <span className="grow strong">{section.title}</span>
        <div className="segmented" style={{ flex: '0 0 128px' }}>
          <button
            aria-pressed={!on}
            aria-label={`${section.title} off`}
            disabled={busy}
            onClick={() => onToggle(false)}
          >
            Off
          </button>
          <button
            aria-pressed={on}
            aria-label={`${section.title} on`}
            disabled={busy}
            onClick={() => onToggle(true)}
          >
            On
          </button>
        </div>
      </div>
      {section.note !== undefined && (
        <div className="tiny faint" style={{ marginTop: 6 }}>{section.note}</div>
      )}
    </div>
  );
}
