import { useState } from 'react';

import type { AppState } from '../state/useAppState';
import { resetAll, updateSettings } from '../db/repository';
import { REGIONS } from '../domain/seasonality';
import { DERIVABLE_DIETS } from '../domain/nutrition';
import { AllergySection } from './AllergySection';
import { KitchenScreen } from './KitchenScreen';
import { PantrySettings } from './PantrySection';
import { GrabBagControls } from '../components/GrabBagControls';
import { GRAB_BAGS } from '../domain/grabbag';
import { WeekRulesSettings } from './WeekRulesSettings';
import { TreatControls } from '../components/TreatControls';
import { Sheet } from '../components/Sheet';
import { ImportSheet } from './ImportSheet';
import { SyncSheet } from './SyncSheet';
import { WorksCitedSheet } from './WorksCitedSheet';
import type { MealType } from '../domain/types';

const MEAL_LABELS: Record<MealType, string> = {
  full: 'Full meals',
  light: 'Light meals',
  snack: 'Snacks',
};

export function SettingsScreen({ state }: { state: AppState }): JSX.Element {
  const { settings } = state;
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [kitchen, setKitchen] = useState(false);
  const [cited, setCited] = useState(false);

  const region = REGIONS.find((r) => r.id === settings.regionId) ?? REGIONS[0];

  return (
    <main className="screen">
      <div className="header"><h1>Settings</h1></div>

      {/* --- Region ------------------------------------------------------- */}
      <h2 className="section-title">Region</h2>
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

      {/* --- Units -------------------------------------------------------- */}
      <h2 className="section-title">Units</h2>
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

      {/* --- Week shape --------------------------------------------------- */}
      <h2 className="section-title">Week shape</h2>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
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

      {/* --- Week rules --------------------------------------------------- */}
      <h2 className="section-title">Week rules</h2>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
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

      {/* --- Diets -------------------------------------------------------- */}
      <h2 className="section-title">Diet</h2>
      <div className="chips">
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

      <AllergySection state={state} />

      {/* --- Shopping ----------------------------------------------------- */}
      <h2 className="section-title">Shopping</h2>
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
            produce stops being risky; shop less often and the planner works harder
            to avoid it.
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
          <div className="hint">A soft cap. Going over costs the plan a little, it is not forbidden.</div>
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

      {/* --- Grab bags ---------------------------------------------------- */}
      <h2 className="section-title">Grab bags</h2>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        A few things added to the week because they are worth having in, not
        because a recipe asked for them. How much of each you want; whether you
        want it at all is above, under This week screen. Changes apply to this
        week's bags straight away; redraw them from the This week screen.
      </p>
      {GRAB_BAGS.map((bag) => (
        <div key={bag.id}>
          <h3 className="sub-title">{bag.title}</h3>
          <p className="tiny faint" style={{ margin: '-2px 0 8px' }}>{bag.blurb}</p>
          <GrabBagControls state={state} bag={bag.id} />
        </div>
      ))}

      {/* --- Treats ------------------------------------------------------- */}
      <h2 className="section-title">Treats</h2>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        Herbal teas and other small, cheap good things — and not all of them
        food. Anything you are allergic to, or that your diets rule out, is never
        drawn. How many; whether at all is above, under This week screen.
      </p>
      <TreatControls state={state} />

      {/* --- Pantry ------------------------------------------------------- */}
      <h2 className="section-title">Pantry</h2>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        Things kept in stock rather than bought weekly. Anything you have in is
        treated as free, which quietly steers plans toward what you can already
        mostly cook.
      </p>
      <p className="tiny faint" style={{ margin: '0 0 8px' }}>
        Set how much each one matters here; say what is left of it on the This week
        screen, where it can go on the shopping list.
      </p>
      <PantrySettings state={state} />

      {/* --- Kitchen ------------------------------------------------------ */}
      <h2 className="section-title">Kitchen</h2>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        Weekly staples, and shelf-stable leftovers banked from previous shops.
      </p>
      <button className="btn block" style={{ marginBottom: 10 }} onClick={() => setKitchen(true)}>
        Staples &amp; leftovers
      </button>

      {/* --- Sync --------------------------------------------------------- */}
      <h2 className="section-title">Sync</h2>
      <div className="card small dim">
        Everything works offline first and lives on this device. Link a second
        device to keep plans and shopping lists in step — generate a list on the
        laptop, tick it off in the shop with no signal, and it catches up when you
        reconnect.
      </div>
      <button className="btn block" style={{ marginBottom: 10 }} onClick={() => setSyncing(true)}>
        Sync settings
      </button>

      {/* --- Data --------------------------------------------------------- */}
      <h2 className="section-title">Data</h2>
      <button className="btn block" style={{ marginBottom: 10 }} onClick={() => setImporting(true)}>
        Import &amp; export recipes
      </button>

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

      {/* --- Works cited -------------------------------------------------- */}
      <h2 className="section-title">Works cited</h2>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        Plain English on how each part of the app decides things, where its numbers
        came from, and how much to trust them.
      </p>
      <button className="btn block" onClick={() => setCited(true)}>
        How this app works &amp; where its data comes from
      </button>

      <p className="tiny faint" style={{ textAlign: 'center', marginTop: 24 }}>
        {state.recipes.size} recipes · {state.ingredients.size} ingredients
      </p>

      {importing && <ImportSheet onClose={() => setImporting(false)} />}
      {syncing && <SyncSheet onClose={() => setSyncing(false)} />}
      {cited && <WorksCitedSheet onClose={() => setCited(false)} />}
      {kitchen && (
        <Sheet title="Staples & pantry" onClose={() => setKitchen(false)}>
          <KitchenScreen state={state} embedded />
        </Sheet>
      )}
    </main>
  );
}
