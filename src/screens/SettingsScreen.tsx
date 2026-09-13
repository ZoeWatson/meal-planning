/**
 * Settings.
 *
 * THE SCREEN IS AN INDEX FIRST AND A CONTROL PANEL SECOND. It had grown to
 * fifteen headings and some thirty controls laid end to end, which meant that
 * changing the thing you came for involved scrolling past everything you did
 * not. Every section now folds, every section ships folded, and each one says
 * what it is currently set to on its own heading — so the screen you land on is
 * a one-line summary of the whole app that happens to open.
 *
 * The folded notes are the reason this is worth doing. "Region — British
 * Columbia" and "Week shape — 5 full · 2 light · 3 snacks" answer the question
 * most visits are actually asking, which is not "let me change this" but "what
 * is this set to".
 *
 * THE BANDS FOLD TOO, and they ship open. A band gathers a run of related
 * sections — "Your week", "Shopping & pantry" — and its caret takes the whole run
 * away at once. Open by default because the bands are there to make thirteen
 * headings scannable, not to hide them, and burying "Allergies" two taps deep by
 * default would cost more than it saves; folding one is a choice you make on the
 * bands you never open, and it is remembered per device like every other fold.
 *
 * ORDER IS BY WHAT IT AFFECTS, not by what it is called. The week comes first
 * because it is what the app is for; region and units are near the bottom
 * because they are set once and never again. What was a run of four
 * one-button headings at the end — kitchen, sync, data, works cited — is now
 * buttons rather than headings, since a heading whose entire contents is one
 * button is a heading that earns nothing. Staples and leftovers sits with
 * shopping and pantry, where the rest of "what gets bought" lives; sync, data
 * and works cited make up the band at the end.
 */

import { useState } from 'react';

import type { AppState } from '../state/useAppState';
import { resetAll, updateSettings } from '../db/repository';
import { REGIONS } from '../domain/seasonality';
import { DERIVABLE_DIETS } from '../domain/nutrition';
import { AllergySettings, DislikeSettings } from './AllergySection';
import { KitchenScreen } from './KitchenScreen';
import { PantrySettings } from './PantrySection';
import { GrabBagControls } from '../components/GrabBagControls';
import { GRAB_BAGS } from '../domain/grabbag';
import { WEEK_SECTIONS } from '../domain/weekSections';
import { WeekSectionsSettings } from './WeekSectionsSettings';
import { WeekRulesSettings } from './WeekRulesSettings';
import { TreatControls } from '../components/TreatControls';
import { CollapsibleSection, useFold } from '../components/CollapsibleSection';
import { CaretIcon } from '../components/icons';
import { Sheet } from '../components/Sheet';
import { ImportSheet } from './ImportSheet';
import { SyncSheet } from './SyncSheet';
import { TransferSheet } from './TransferSheet';
import { WorksCitedSheet } from './WorksCitedSheet';
import type { MealType } from '../domain/types';

const MEAL_LABELS: Record<MealType, string> = {
  full: 'Full meals',
  light: 'Light meals',
  snack: 'Snacks',
};

/** Shorter forms, for the one-line summary on a folded heading. */
const MEAL_SHORT: Record<MealType, string> = {
  full: 'full',
  light: 'light',
  snack: 'snacks',
};

export function SettingsScreen({ state }: { state: AppState }): JSX.Element {
  const { settings, pantry } = state;
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [kitchen, setKitchen] = useState(false);
  const [cited, setCited] = useState(false);

  const region = REGIONS.find((r) => r.id === settings.regionId) ?? REGIONS[0];
  const sectionsOff = WEEK_SECTIONS.filter((s) => !settings[s.enabledKey]).length;
  const bagsOn = GRAB_BAGS.filter((bag) => settings[bag.enabledKey]).length;

  return (
    <main className="screen">
      <div className="header">
        <h1>Settings</h1>
        <div className="sub">Tap a heading to open it.</div>
      </div>

      {/* ============================================================ week */}
      <SettingsBand id="week" label="Your week">
        <CollapsibleSection
          id="settings:week-shape"
          title="Week shape"
          defaultOpen={false}
          headingLevel={3}
          closedNote={
            (['full', 'light', 'snack'] as const)
              .map((t) => `${settings.spec[t]} ${MEAL_SHORT[t]}`)
              .join(' · ')
          }
        >
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            How many of each, and how many portions. Light meals and snacks are what
            the planner uses to finish off whatever the full meals leave behind, so
            cutting them to zero makes overlap harder to find.
          </p>

          {(['full', 'light', 'snack'] as const).map((type) => (
            <div className="card tight row between" key={type}>
              <span className="grow strong">{MEAL_LABELS[type]}</span>

              <div className="stepper">
                <button
                  aria-label={`Fewer ${type} meals`}
                  onClick={() => void updateSettings({
                    spec: { ...settings.spec, [type]: Math.max(0, settings.spec[type] - 1) },
                  })}
                >
                  −
                </button>
                <span className="val">{settings.spec[type]}</span>
                <button
                  aria-label={`More ${type} meals`}
                  onClick={() => void updateSettings({
                    spec: { ...settings.spec, [type]: settings.spec[type] + 1 },
                  })}
                >
                  +
                </button>
              </div>

              <div className="stepper" style={{ marginLeft: 8 }}>
                <button
                  aria-label={`Fewer portions per ${type} meal`}
                  onClick={() => void updateSettings({
                    spec: {
                      ...settings.spec,
                      servingsPerMeal: {
                        ...settings.spec.servingsPerMeal,
                        [type]: Math.max(1, settings.spec.servingsPerMeal[type] - 1),
                      },
                    },
                  })}
                >
                  −
                </button>
                <span className="val">{settings.spec.servingsPerMeal[type]}</span>
                <button
                  aria-label={`More portions per ${type} meal`}
                  onClick={() => void updateSettings({
                    spec: {
                      ...settings.spec,
                      servingsPerMeal: {
                        ...settings.spec.servingsPerMeal,
                        [type]: settings.spec.servingsPerMeal[type] + 1,
                      },
                    },
                  })}
                >
                  +
                </button>
              </div>
            </div>
          ))}
          <p className="tiny faint" style={{ marginTop: 4 }}>
            Left: how many meals. Right: portions each.
          </p>
        </CollapsibleSection>

        <CollapsibleSection
          id="settings:week-rules"
          title="Week rules"
          defaultOpen={false}
          headingLevel={3}
          closedNote={
            settings.weekRules.length === 0
              ? 'none'
              : `${settings.weekRules.length} rule${settings.weekRules.length === 1 ? '' : 's'}`
          }
        >
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            What a week has to contain, whatever else it does — three meals under 30
            minutes, two pasta nights, something using the halloumi. Each rule is a
            count rather than a filter, so "three quick meals" gives you three quick
            meals and four you can take your time over, instead of a week of
            stir-fries.
          </p>
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            Regenerate and every shuffle honour these. The This week screen says
            whether the week you have met them.
          </p>
          <WeekRulesSettings state={state} />
        </CollapsibleSection>

        <CollapsibleSection
          id="settings:week-sections"
          title="This week screen"
          defaultOpen={false}
          headingLevel={3}
          closedNote={sectionsOff === 0 ? 'all on' : `${sectionsOff} off`}
        >
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            Which parts of the week you actually want. Everything ships switched on;
            turn off what you do not use and the screen gets shorter.
          </p>
          <WeekSectionsSettings state={state} />
        </CollapsibleSection>
      </SettingsBand>

      {/* ============================================================== eat */}
      <SettingsBand id="eat" label="What you eat">
        <CollapsibleSection
          id="settings:diet"
          title="Diet"
          defaultOpen={false}
          headingLevel={3}
          closedNote={settings.diets.length === 0 ? 'anything' : settings.diets.join(', ')}
        >
          <div className="chips wrap">
            {DERIVABLE_DIETS.map((diet) => {
              const on = settings.diets.includes(diet);
              return (
                <button
                  key={diet}
                  className="chip"
                  aria-pressed={on}
                  onClick={() => void updateSettings({
                    diets: on
                      ? settings.diets.filter((d) => d !== diet)
                      : [...settings.diets, diet],
                  })}
                >
                  {diet}
                </button>
              );
            })}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          id="settings:allergies"
          title="Allergies"
          defaultOpen={false}
          headingLevel={3}
          closedNote={
            settings.allergens.length === 0 ? 'none' : `${settings.allergens.length} avoided`
          }
        >
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            Anything selected here is removed from plans, the shopping list and the
            grab bags — and flagged wherever a recipe could still slip through.
          </p>
          <AllergySettings state={state} />
        </CollapsibleSection>

        <CollapsibleSection
          id="settings:dislikes"
          title="Never plan these"
          defaultOpen={false}
          headingLevel={3}
          closedNote={
            settings.excludedIngredients.length === 0
              ? 'none'
              : `${settings.excludedIngredients.length} excluded`
          }
        >
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            Individual ingredients you would rather not see. Filtered quietly — this
            is for dislikes, not allergies.
          </p>
          <DislikeSettings state={state} />
        </CollapsibleSection>
      </SettingsBand>

      {/* =========================================================== extras */}
      <SettingsBand id="extras" label="Extras in the bag">
        <CollapsibleSection
          id="settings:grab-bags"
          title="Grab bags"
          defaultOpen={false}
          headingLevel={3}
          closedNote={bagsOn === 0 ? 'all off' : `${bagsOn} of ${GRAB_BAGS.length} on`}
        >
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            A few things added to the week because they are worth having in, not
            because a recipe asked for them. How much of each you want; whether you
            want it at all is under This week screen, above. Changes apply to this
            week's bags straight away; redraw them from the This week screen.
          </p>
          {GRAB_BAGS.map((bag) => (
            <div key={bag.id}>
              <h3 className="sub-title">{bag.title}</h3>
              <p className="tiny faint" style={{ margin: '-2px 0 8px' }}>{bag.blurb}</p>
              <GrabBagControls state={state} bag={bag.id} />
            </div>
          ))}
        </CollapsibleSection>

        <CollapsibleSection
          id="settings:treats"
          title="Treats"
          defaultOpen={false}
          headingLevel={3}
          closedNote={settings.treatBagEnabled ? `${settings.treatCount} a week` : 'off'}
        >
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            Herbal teas and other small, cheap good things — and not all of them
            food. Anything you are allergic to, or that your diets rule out, is never
            drawn. How many; whether at all is under This week screen, above.
          </p>
          <TreatControls state={state} />
        </CollapsibleSection>
      </SettingsBand>

      {/* ========================================================= shopping */}
      <SettingsBand id="shopping" label="Shopping & pantry">
        <CollapsibleSection
          id="settings:region"
          title="Region"
          defaultOpen={false}
          headingLevel={3}
          closedNote={region.name}
        >
          <div className="card">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="region">Where you shop</label>
              <select
                id="region"
                value={settings.regionId}
                onChange={(e) => void updateSettings({ regionId: e.target.value })}
              >
                {REGIONS.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              <div className="hint">{region.description}</div>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          id="settings:shopping"
          title="Shopping"
          defaultOpen={false}
          headingLevel={3}
          closedNote={`every ${settings.cycleDays} day${settings.cycleDays === 1 ? '' : 's'}`}
        >
          <div className="card">
            <div className="field">
              <label htmlFor="cycle">Days between shops</label>
              <input
                id="cycle"
                type="number"
                min={1}
                max={30}
                value={settings.cycleDays}
                onChange={(e) => void updateSettings({ cycleDays: Number(e.target.value) || 7 })}
              />
              <div className="hint">
                The horizon surplus has to survive. Shop more often and short-life
                produce stops being risky; shop less often and the planner works
                harder to avoid it.
              </div>
            </div>

            <div className="field">
              <label htmlFor="budget">Weekly cooking budget (minutes)</label>
              <input
                id="budget"
                type="number"
                min={0}
                step={30}
                value={settings.weeklyTimeBudgetMinutes}
                onChange={(e) => void updateSettings({
                  weeklyTimeBudgetMinutes: Number(e.target.value) || 0,
                })}
              />
              <div className="hint">
                A soft cap. Going over costs the plan a little, it is not forbidden.
              </div>
            </div>

            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="repeat">Do not repeat recipes for (weeks)</label>
              <input
                id="repeat"
                type="number"
                min={0}
                max={12}
                value={settings.repeatWindowWeeks}
                onChange={(e) => void updateSettings({ repeatWindowWeeks: Number(e.target.value) || 0 })}
              />
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          id="settings:pantry"
          title="Pantry"
          defaultOpen={false}
          headingLevel={3}
          closedNote={pantry.length === 0 ? 'empty' : `${pantry.length} items`}
        >
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            Things kept in stock rather than bought weekly. Anything you have in is
            treated as free, which quietly steers plans toward what you can already
            mostly cook.
          </p>
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            Set how much each one matters here; say what is left of it on the This
            week screen, where it can go on the shopping list.
          </p>
          <PantrySettings state={state} />
        </CollapsibleSection>

        {/* A button, not a fold: the staples list and the leftovers bank are a
            screen of their own, and there is nothing to summarise on a heading
            whose whole contents is "open this". It belongs here rather than with
            sync and data because both lists are about what gets bought. */}
        <button className="btn block" style={{ marginBottom: 8 }} onClick={() => setKitchen(true)}>
          Staples &amp; leftovers
        </button>
        <p className="tiny faint" style={{ margin: '-4px 0 0' }}>
          Bought every week whatever is cooked, and shelf-stable surplus banked from
          previous shops.
        </p>
      </SettingsBand>

      {/* ========================================================== display */}
      <SettingsBand id="display" label="Display">
        <CollapsibleSection
          id="settings:units"
          title="Units"
          defaultOpen={false}
          headingLevel={3}
          closedNote={settings.unitSystem === 'metric' ? 'Metric' : 'Imperial'}
        >
          <div className="segmented">
            <button
              aria-pressed={settings.unitSystem === 'metric'}
              onClick={() => void updateSettings({ unitSystem: 'metric' })}
            >
              Metric
            </button>
            <button
              aria-pressed={settings.unitSystem === 'imperial'}
              onClick={() => void updateSettings({ unitSystem: 'imperial' })}
            >
              Imperial
            </button>
          </div>
          <p className="tiny faint" style={{ marginTop: 6 }}>
            Converted when it is shown. Everything is stored in grams either way, so
            switching back and forth loses nothing.
          </p>
        </CollapsibleSection>
      </SettingsBand>

      {/* ============================================================== app */}
      {/* Buttons rather than folds. There is nothing to summarise on a heading
          whose whole contents is "open this", and four one-button sections was
          four headings pretending to be settings. */}
      <SettingsBand id="app" label="Sync & data">
        {/* The file first, deliberately. It needs nothing but the two devices,
            where the one below it needs a server somebody has to run. */}
        <button className="btn block" style={{ marginBottom: 8 }} onClick={() => setTransferring(true)}>
          Move data between devices
        </button>
        <p className="tiny faint" style={{ margin: '-4px 0 12px' }}>
          Export a file, open it on your phone or laptop, and the two catch up.
          Each record keeps whichever version was written last, so it is safe to
          carry in both directions.
        </p>

        <button className="btn block" style={{ marginBottom: 8 }} onClick={() => setSyncing(true)}>
          Sync settings
        </button>
        <p className="tiny faint" style={{ margin: '-4px 0 12px' }}>
          Everything works offline first and lives on this device. The same catching
          up, done over the network instead of by hand — it needs a sync server you
          run yourself.
        </p>

        <button className="btn block" style={{ marginBottom: 8 }} onClick={() => setImporting(true)}>
          Import &amp; export recipes
        </button>
        <p className="tiny faint" style={{ margin: '-4px 0 12px' }}>
          Bulk import from a file, and export the library as a backup. One recipe at
          a time is quicker from the Recipes tab.
        </p>

        <button className="btn block" style={{ marginBottom: 8 }} onClick={() => setCited(true)}>
          How this app works &amp; where its data comes from
        </button>
        <p className="tiny faint" style={{ margin: '-4px 0 14px' }}>
          Plain English on how each part decides things, where its numbers came from,
          and how much to trust them.
        </p>

        {!confirmingReset ? (
          <button className="btn block danger" onClick={() => setConfirmingReset(true)}>
            Reset everything
          </button>
        ) : (
          <div className="card">
            <p className="small" style={{ marginTop: 0 }}>
              This deletes your plans, staples, pantry and any recipes you imported,
              then reloads the built-in library. It cannot be undone.
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn grow" onClick={() => setConfirmingReset(false)}>Cancel</button>
              <button className="btn danger grow" onClick={() => void resetAll()}>
                Delete everything
              </button>
            </div>
          </div>
        )}
      </SettingsBand>

      <p className="tiny faint" style={{ textAlign: 'center', marginTop: 24 }}>
        {state.recipes.size} recipes · {state.ingredients.size} ingredients
      </p>

      {importing && <ImportSheet onClose={() => setImporting(false)} />}
      {syncing && <SyncSheet onClose={() => setSyncing(false)} />}
      {transferring && <TransferSheet onClose={() => setTransferring(false)} />}
      {cited && <WorksCitedSheet onClose={() => setCited(false)} />}
      {kitchen && (
        <Sheet title="Staples & leftovers" onClose={() => setKitchen(false)}>
          <KitchenScreen state={state} embedded />
        </Sheet>
      )}
    </main>
  );
}

/**
 * A run of related sections, under a label that folds the whole run away.
 *
 * A CONTAINER NOW, AND IT USED TO BE A CAPTION. The argument against folding it
 * was that "Allergies" should not cost two taps to reach, and that argument is
 * answered by the default rather than by refusing the fold: a band ships OPEN,
 * so nothing moves further away than it already was, and the second level is
 * there for whoever wants it. Fold "Shopping & pantry" once and its four
 * headings stop scrolling past you forever after — which is the same trade the
 * sections themselves make, one level up.
 *
 * No `closedNote`, unlike a folded section. A section's note exists because a
 * section can be empty and you cannot tell from outside; a band is a fixed run
 * of headings that is never empty, and "Your week" already says what is in
 * there. A count of sections would be furniture.
 *
 * The band is the `h2` and its sections are `h3`s, which is what the nesting has
 * actually been since the bands were drawn — it is only now that the markup says
 * so.
 */
function SettingsBand({
  id,
  label,
  children,
}: {
  /** Stable: the key the fold is remembered under. Namespaced on use. */
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  const [open, toggle] = useFold(`settings:band:${id}`, true);
  const bodyId = `settings-band-${id}`;

  return (
    <section>
      <h2 className="band-label folds">
        <button
          type="button"
          className="section-toggle band-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <CaretIcon />
          <span className="grow">{label}</span>
        </button>
      </h2>
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
