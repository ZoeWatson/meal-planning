import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import type { AppState } from '../state/useAppState';
import { db } from '../db/database';
import {
  discardLeftover, eatLeftover, logMealOut, recordCooked, removeMealLogEntry,
} from '../db/repository';
import {
  addDays, availableIngredients, estimateKeeping, freshness, isActive, localDate,
  matchFromPantry, summariseWeek, weekStart,
  type Leftover, type MealLogEntry, type PantryMatch, type StorageKind,
} from '../domain/cooking';
import { checkRecipe, describeMatches } from '../domain/allergens';
import { parseMoney } from '../domain/budget';
import type { MealType, PlanSlot, Recipe } from '../domain/types';
import { Sheet } from '../components/Sheet';

const MEAL_LABELS: Record<MealType | 'other', string> = {
  full: 'Full meal', light: 'Light meal', snack: 'Snack', other: 'Other',
};

type Section = 'week' | 'pantry' | 'fridge' | 'log';

export function CookScreen({ state }: { state: AppState }): JSX.Element {
  const { plan, recipes, ingredients, staples, pantry, settings } = state;
  const [section, setSection] = useState<Section>('week');
  const [cooking, setCooking] = useState<{ recipe: Recipe; slot?: PlanSlot } | null>(null);
  const [eating, setEating] = useState<Leftover | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const leftovers = useLiveQuery(() => db.leftovers.toArray(), []) ?? [];
  const cookedMeals = useLiveQuery(() => db.cookedMeals.toArray(), []) ?? [];
  const logEntries = useLiveQuery(() => db.mealLog.toArray(), []) ?? [];
  const checks = useLiveQuery(() => db.checks.toArray(), []) ?? [];
  const carryOver = useLiveQuery(() => db.carryOver.toArray(), []) ?? [];

  const activeLeftovers = useMemo(
    () => leftovers.filter(isActive)
      .sort((a, b) => a.useByISO.localeCompare(b.useByISO)),
    [leftovers],
  );

  /** Slots already cooked, so the week list can show progress rather than repeat itself. */
  const cookedSlotIds = useMemo(
    () => new Set(cookedMeals.map((c) => c.slotId).filter(Boolean) as string[]),
    [cookedMeals],
  );

  const available = useMemo(() => availableIngredients({
    pantryStocked: pantry.filter((p) => p.status === 'stocked').map((p) => p.ingredientId),
    carriedOver: carryOver.map((c) => c.ingredientId),
    purchased: checks.filter((c) => c.checked).map((c) => c.ingredientId),
    staples: staples.filter((s) => s.active).map((s) => s.ingredientId),
  }), [pantry, carryOver, checks, staples]);

  const pantryMatches = useMemo(() => {
    const safe = [...recipes.values()].filter(
      (r) => !checkRecipe(r, ingredients, settings.allergens).hasMatch,
    );
    return matchFromPantry(safe, available, { maxMissing: 3 });
  }, [recipes, ingredients, settings.allergens, available]);

  const week = useMemo(
    () => summariseWeek(logEntries, weekStart()),
    [logEntries],
  );

  const expiringSoon = activeLeftovers.filter(
    (l) => freshness(l.useByISO).daysLeft <= 1,
  ).length;

  return (
    <main className="screen">
      <div className="header">
        <h1>Cook</h1>
        <div className="sub">
          {activeLeftovers.length > 0
            ? `${activeLeftovers.length} in the fridge` +
              (expiringSoon > 0 ? ` · ${expiringSoon} to use now` : '')
            : 'Nothing in the fridge'}
        </div>
      </div>

      <div className="chips" style={{ marginTop: 10 }}>
        {([
          ['week', 'This week'],
          ['pantry', 'From what you have'],
          ['fridge', `Fridge${activeLeftovers.length ? ` (${activeLeftovers.length})` : ''}`],
          ['log', 'Eaten'],
        ] as const).map(([id, label]) => (
          <button
            key={id} className="chip" aria-pressed={section === id}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* --- the week's meals -------------------------------------------- */}
      {section === 'week' && (
        plan === null ? (
          <div className="empty">
            <h2>No plan yet</h2>
            <p>Plan a week and its meals show up here to cook.</p>
          </div>
        ) : (
          <>
            <p className="tiny faint" style={{ marginTop: 6 }}>
              Tap a meal when you have made it. Anything you do not eat becomes
              leftovers with a use-by date.
            </p>
            {plan.slots.filter((s) => s.recipeId).map((slot) => {
              const recipe = recipes.get(slot.recipeId!)!;
              const done = cookedSlotIds.has(slot.id);
              return (
                <button
                  key={slot.id}
                  className="card"
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    ...(done ? { opacity: 0.55 } : {}),
                  }}
                  onClick={() => setCooking({ recipe, slot })}
                >
                  <div className="row between">
                    <span className="strong">{recipe.name}</span>
                    {done && <span className="badge accent">cooked</span>}
                  </div>
                  <div className="tiny dim" style={{ marginTop: 3 }}>
                    {MEAL_LABELS[recipe.mealType]} · {slot.servings} portions ·{' '}
                    {recipe.prepMinutes + recipe.cookMinutes} min
                  </div>
                </button>
              );
            })}
          </>
        )
      )}

      {/* --- cook from what you have -------------------------------------- */}
      {section === 'pantry' && (
        <PantrySection
          matches={pantryMatches}
          state={state}
          onCook={(recipe) => setCooking({ recipe })}
        />
      )}

      {/* --- the fridge ---------------------------------------------------- */}
      {section === 'fridge' && (
        <FridgeSection
          leftovers={activeLeftovers}
          onEat={setEating}
        />
      )}

      {/* --- what you ate -------------------------------------------------- */}
      {section === 'log' && (
        <LogSection week={week} onAdd={() => setLoggingOut(true)} />
      )}

      {cooking && (
        <CookSheet
          recipe={cooking.recipe}
          slot={cooking.slot}
          state={state}
          onClose={() => setCooking(null)}
        />
      )}
      {eating && <EatSheet leftover={eating} onClose={() => setEating(null)} />}
      {loggingOut && <LogMealSheet currency={settings.currency} onClose={() => setLoggingOut(false)} />}
    </main>
  );
}

// ---------------------------------------------------------------------------

function PantrySection({
  matches, state, onCook,
}: {
  matches: readonly PantryMatch[];
  state: AppState;
  onCook: (recipe: Recipe) => void;
}): JSX.Element {
  const [showPartial, setShowPartial] = useState(false);
  const complete = matches.filter((m) => m.missingIds.length === 0);
  const partial = matches.filter((m) => m.missingIds.length > 0);

  return (
    <>
      <p className="tiny faint" style={{ marginTop: 6 }}>
        Based on your stocked pantry, banked leftovers from previous weeks, and
        anything already ticked off this week's shopping list.
      </p>

      {complete.length === 0 && partial.length === 0 && (
        <div className="empty">
          <h2>Nothing matches yet</h2>
          <p>
            Tick items off your shopping list, or mark pantry items as stocked, and
            recipes you can make will appear here.
          </p>
        </div>
      )}

      {complete.length > 0 && (
        <>
          <h2 className="section-title">You have everything for these</h2>
          {complete.map((match) => (
            <button
              key={match.recipe.id}
              className="card"
              style={{ display: 'block', width: '100%', textAlign: 'left' }}
              onClick={() => onCook(match.recipe)}
            >
              <div className="row between">
                <span className="strong">{match.recipe.name}</span>
                <span className="badge accent">ready</span>
              </div>
              <div className="tiny dim" style={{ marginTop: 3 }}>
                {match.recipe.prepMinutes + match.recipe.cookMinutes} min ·{' '}
                {match.haveIds.length} ingredients
              </div>
            </button>
          ))}
        </>
      )}

      {partial.length > 0 && (
        <>
          <h2 className="section-title">Nearly</h2>
          {(showPartial ? partial : partial.slice(0, 5)).map((match) => (
            <button
              key={match.recipe.id}
              className="card"
              style={{ display: 'block', width: '100%', textAlign: 'left' }}
              onClick={() => onCook(match.recipe)}
            >
              <div className="strong">{match.recipe.name}</div>
              <div className="tiny" style={{ marginTop: 3, color: 'var(--warn)' }}>
                Missing {match.missingIds
                  .map((id) => state.ingredients.get(id)?.name ?? id)
                  .join(', ')}
              </div>
            </button>
          ))}
          {!showPartial && partial.length > 5 && (
            <button className="btn block" onClick={() => setShowPartial(true)}>
              Show {partial.length - 5} more
            </button>
          )}
        </>
      )}
    </>
  );
}

function FridgeSection({
  leftovers, onEat,
}: {
  leftovers: readonly Leftover[];
  onEat: (l: Leftover) => void;
}): JSX.Element {
  if (leftovers.length === 0) {
    return (
      <div className="empty">
        <h2>Fridge is empty</h2>
        <p>Mark a meal as cooked and whatever you do not eat is tracked here.</p>
      </div>
    );
  }

  return (
    <>
      <p className="tiny faint" style={{ marginTop: 6 }}>
        Soonest first. Dates are general food-safety guidance — they cannot know
        how quickly something cooled or how cold your fridge runs, so treat them as
        a prompt and trust your senses.
      </p>

      {leftovers.map((leftover) => {
        const state = freshness(leftover.useByISO);
        const tone = state.state === 'past' ? 'var(--danger)'
          : state.state === 'today' || state.state === 'use-soon' ? 'var(--warn)'
          : undefined;

        return (
          <div className="card" key={leftover.id} style={tone ? { borderColor: tone } : undefined}>
            <div className="row between">
              <span className="grow">
                <span className="strong">{leftover.label}</span>
                <span className="gmeta" style={{ display: 'block' }}>
                  {leftover.servingsRemaining} portion
                  {leftover.servingsRemaining === 1 ? '' : 's'}
                  {' · '}
                  {leftover.storage === 'freezer' ? 'freezer' : 'fridge'}
                </span>
              </span>
              <span
                className="small strong"
                style={{ color: tone ?? 'var(--text-dim)', textAlign: 'right' }}
              >
                {state.label}
              </span>
            </div>

            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <button className="btn small grow" onClick={() => onEat(leftover)}>Eat some</button>
              <button
                className="btn small ghost"
                onClick={() => void discardLeftover(leftover.id)}
              >
                Threw it out
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

function LogSection({
  week, onAdd,
}: {
  week: ReturnType<typeof summariseWeek>;
  onAdd: () => void;
}): JSX.Element {
  const today = localDate();

  return (
    <>
      <div className="stat-grid" style={{ marginTop: 10 }}>
        <div className="stat">
          <div className="v">{week.totalEntries}</div>
          <div className="k">meals logged</div>
        </div>
        <div className="stat">
          <div className="v">{Math.round(week.homeCookedShare * 100)}%</div>
          <div className="k">from your kitchen</div>
        </div>
        <div className="stat">
          <div className="v">{week.bySource.out}</div>
          <div className="k">eaten out</div>
        </div>
      </div>

      {week.days.map((day) => {
        const isToday = day.dateISO === today;
        const isFuture = day.dateISO > today;
        return (
          <section key={day.dateISO}>
            <h2 className="section-title" style={isToday ? { color: 'var(--accent)' } : undefined}>
              {new Date(`${day.dateISO}T12:00:00`).toLocaleDateString(undefined, {
                weekday: 'long', day: 'numeric', month: 'short',
              })}
              {isToday && ' · today'}
            </h2>

            {day.entries.length === 0 ? (
              <div className="card tight small faint">
                {isFuture ? 'Not yet' : 'Nothing logged'}
              </div>
            ) : (
              day.entries.map((entry) => <LogRow entry={entry} key={entry.id} />)
            )}
          </section>
        );
      })}

      <button className="btn primary block" style={{ marginTop: 16 }} onClick={onAdd}>
        Log something you ate
      </button>
    </>
  );
}

function LogRow({ entry }: { entry: MealLogEntry }): JSX.Element {
  const SOURCE_LABEL: Record<MealLogEntry['source'], string> = {
    cooked: 'cooked', leftover: 'leftovers', out: 'eaten out', other: '',
  };
  return (
    <div className="card tight row between">
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="strong truncate">{entry.label}</span>
        <span className="gmeta" style={{ display: 'block' }}>
          {SOURCE_LABEL[entry.source] && (
            <span className={`badge${entry.source === 'out' ? ' warn' : ''}`}>
              {SOURCE_LABEL[entry.source]}
            </span>
          )}
          {MEAL_LABELS[entry.mealType]} · {entry.servings} portion
          {entry.servings === 1 ? '' : 's'}
        </span>
      </span>
      <button
        className="btn small ghost"
        aria-label={`Remove ${entry.label}`}
        onClick={() => void removeMealLogEntry(entry.id)}
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CookSheet({
  recipe, slot, state, onClose,
}: {
  recipe: Recipe;
  slot?: PlanSlot;
  state: AppState;
  onClose: () => void;
}): JSX.Element {
  const [made, setMade] = useState(slot?.servings ?? recipe.baseServings);
  const [eaten, setEaten] = useState(Math.min(2, slot?.servings ?? recipe.baseServings));
  const [storage, setStorage] = useState<StorageKind>('fridge');
  const [busy, setBusy] = useState(false);

  const leftoverServings = Math.max(0, made - eaten);
  const keeping = estimateKeeping(recipe, state.ingredients, storage);
  const useBy = addDays(localDate(), keeping.days);
  const allergens = checkRecipe(recipe, state.ingredients, state.settings.allergens);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await recordCooked({
        recipe,
        ingredients: state.ingredients,
        servingsMade: made,
        servingsEaten: eaten,
        storage,
        slotId: slot?.id,
        planId: state.plan?.id,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={recipe.name} onClose={onClose}>
      {allergens.hasMatch && (
        <div className="card" style={{ borderColor: 'var(--danger)' }} role="alert">
          <span className="strong" style={{ color: 'var(--danger)' }}>
            Contains something you avoid
          </span>
          <div className="tiny dim" style={{ marginTop: 4 }}>
            {describeMatches(allergens.matches)}
          </div>
        </div>
      )}

      <div className="card tight row between">
        <span className="grow strong">Portions made</span>
        <div className="stepper">
          <button aria-label="Fewer made" onClick={() => setMade((n) => Math.max(1, n - 1))}>−</button>
          <span className="val">{made}</span>
          <button aria-label="More made" onClick={() => setMade((n) => n + 1)}>+</button>
        </div>
      </div>

      <div className="card tight row between">
        <span className="grow strong">Eaten now</span>
        <div className="stepper">
          <button aria-label="Fewer eaten" onClick={() => setEaten((n) => Math.max(0, n - 1))}>−</button>
          <span className="val">{eaten}</span>
          <button aria-label="More eaten" onClick={() => setEaten((n) => Math.min(made, n + 1))}>+</button>
        </div>
      </div>

      {leftoverServings > 0 ? (
        <>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Where the other {leftoverServings} go</label>
            <div className="segmented">
              <button aria-pressed={storage === 'fridge'} onClick={() => setStorage('fridge')}>
                Fridge
              </button>
              <button aria-pressed={storage === 'freezer'} onClick={() => setStorage('freezer')}>
                Freezer
              </button>
            </div>
          </div>

          {/* The reason travels with the number: "1 day" on a rice dish looks like
              a bug until you know it is the rice. */}
          <div className="card small dim">
            Use by <strong>{new Date(`${useBy}T12:00:00`).toLocaleDateString(undefined,
              { weekday: 'long', day: 'numeric', month: 'short' })}</strong>
            {' '}— {keeping.reason}. General guidance, not a guarantee.
          </div>
        </>
      ) : (
        <p className="tiny faint" style={{ marginTop: 10 }}>
          Nothing left over.
        </p>
      )}

      <button className="btn primary block" style={{ marginTop: 12 }} disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : leftoverServings > 0
          ? `Cooked — keep ${leftoverServings}`
          : 'Cooked'}
      </button>
    </Sheet>
  );
}

function EatSheet({ leftover, onClose }: { leftover: Leftover; onClose: () => void }): JSX.Element {
  const [servings, setServings] = useState(1);
  const [mealType, setMealType] = useState<MealType | 'other'>('full');

  return (
    <Sheet title={leftover.label} onClose={onClose}>
      <div className="card tight row between">
        <span className="grow strong">Portions eaten</span>
        <div className="stepper">
          <button aria-label="Fewer" onClick={() => setServings((n) => Math.max(1, n - 1))}>−</button>
          <span className="val">{servings}</span>
          <button
            aria-label="More"
            onClick={() => setServings((n) => Math.min(leftover.servingsRemaining, n + 1))}
          >
            +
          </button>
        </div>
      </div>
      <p className="tiny faint">{leftover.servingsRemaining} in the fridge.</p>

      <div className="field" style={{ marginTop: 10 }}>
        <label>As what</label>
        <div className="segmented">
          {(['full', 'light', 'snack'] as const).map((t) => (
            <button key={t} aria-pressed={mealType === t} onClick={() => setMealType(t)}>
              {MEAL_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <button
        className="btn primary block"
        style={{ marginTop: 12 }}
        onClick={() => { void eatLeftover(leftover.id, servings, mealType); onClose(); }}
      >
        {servings === leftover.servingsRemaining ? 'Finished it' : `Ate ${servings}`}
      </button>
    </Sheet>
  );
}

function LogMealSheet({
  currency, onClose,
}: {
  currency: string;
  onClose: () => void;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [servings, setServings] = useState(1);
  const [mealType, setMealType] = useState<MealType | 'other'>('full');
  const [out, setOut] = useState(true);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => localDate());

  const cents = parseMoney(amount);

  async function save(): Promise<void> {
    if (label.trim() === '') return;
    await logMealOut({
      label: label.trim(),
      servings,
      mealType,
      dateISO: date,
      source: out ? 'out' : 'other',
      amountCents: out && cents !== null && cents > 0 ? cents : undefined,
    });
    onClose();
  }

  return (
    <Sheet title="Log a meal" onClose={onClose}>
      <div className="field">
        <label htmlFor="meal-label">What did you eat?</label>
        <input
          id="meal-label" type="text" value={label} autoFocus
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Ramen at the place on Main"
        />
      </div>

      <div className="field">
        <label>Where</label>
        <div className="segmented">
          <button aria-pressed={out} onClick={() => setOut(true)}>Out</button>
          <button aria-pressed={!out} onClick={() => setOut(false)}>At home</button>
        </div>
      </div>

      <div className="field">
        <label>As what</label>
        <div className="segmented">
          {(['full', 'light', 'snack'] as const).map((t) => (
            <button key={t} aria-pressed={mealType === t} onClick={() => setMealType(t)}>
              {MEAL_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="card tight row between">
        <span className="grow strong">Portions</span>
        <div className="stepper">
          <button aria-label="Fewer" onClick={() => setServings((n) => Math.max(1, n - 1))}>−</button>
          <span className="val">{servings}</span>
          <button aria-label="More" onClick={() => setServings((n) => n + 1)}>+</button>
        </div>
      </div>

      {out && (
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="meal-cost">What it cost (optional)</label>
          <input
            id="meal-cost" type="text" inputMode="decimal" value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
          <div className="hint">
            Adds it to this month's spending too, so the budget stays honest
            without a second trip through the app.
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="meal-date">When</label>
        <input id="meal-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <button
        className="btn primary block"
        disabled={label.trim() === ''}
        onClick={() => void save()}
      >
        {out && cents !== null && cents > 0
          ? `Log and record ${new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)}`
          : 'Log it'}
      </button>
    </Sheet>
  );
}
