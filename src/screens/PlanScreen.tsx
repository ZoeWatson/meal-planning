import { useEffect, useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import {
  generateAndSave, redrawTreats, regenerateMealSection, regenerateSlot,
} from '../state/useAppState';
import {
  removeTreat, setSlotPinned, setSlotRecipe, setSlotServings, setTreatPinned,
} from '../db/repository';
import { scorePlan } from '../domain/planner/scoring';
import { applyFilter } from '../domain/filters';
import { recipeNutrition } from '../domain/nutrition';
import {
  MAX_TREAT_CENTS, TREAT_KIND_LABELS, eligibleTreats, formatTreatPrice, getTreat,
} from '../domain/treats';
import { formatMoneyShort } from '../domain/budget';
import { checkRecipe, describeMatches } from '../domain/allergens';
import { isOnList } from '../domain/pantry';
import { type RuleStatus, describeRule, evaluateRules, impossibleReason } from '../domain/weekRules';
import type { Id, MealType, PlanSlot, WeekPlan } from '../domain/types';
import { PinIcon, ShuffleIcon } from '../components/icons';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { RecipeDetail } from '../components/RecipeDetail';
import { Sheet } from '../components/Sheet';
import { GrabBagSections } from './GrabBagSection';
import { PantryReview } from './PantrySection';

const MEAL_LABELS: Record<MealType, string> = {
  full: 'Full meals',
  light: 'Light meals',
  snack: 'Snacks',
};

export function PlanScreen({
  state,
  onShop,
}: {
  state: AppState;
  onShop: () => void;
}): JSX.Element {
  const { plan, ctx, recipes, ingredients, pantry, settings } = state;
  const [busy, setBusy] = useState(false);
  const [redrawingTreats, setRedrawingTreats] = useState(false);
  const [rerolling, setRerolling] = useState<MealType | null>(null);
  const [picking, setPicking] = useState<PlanSlot | null>(null);

  const score = useMemo(
    () => (plan && ctx ? scorePlan(plan.slots, plan.wildcards, ctx) : null),
    [plan, ctx],
  );

  /**
   * Allergens in the plan as it currently stands.
   *
   * Generation already excludes them, so this should normally be empty — but a
   * plan made before an allergy was set, a pinned slot, or a recipe chosen by hand
   * all bypass that filter. Those are exactly the cases where a silent filter
   * gives false confidence, so they are checked again here and shown.
   */
  const allergenAlerts = useMemo(() => {
    if (!plan || settings.allergens.length === 0) return [];
    return plan.slots.flatMap((slot) => {
      const recipe = slot.recipeId ? recipes.get(slot.recipeId) : null;
      if (!recipe) return [];
      const report = checkRecipe(recipe, ingredients, settings.allergens);
      return report.hasMatch ? [{ recipe, report }] : [];
    });
  }, [plan, recipes, ingredients, settings.allergens]);

  /**
   * How this week measures up against the rules in Settings.
   *
   * A report, not a control — the rules themselves are set in Settings, like
   * everything else that configures the app, and what belongs on this screen is
   * whether the week in front of you honoured them. Which is worth saying out
   * loud: the planner treats a rule as very expensive rather than impossible, so
   * a library with two pasta recipes and a rule asking for three still produces a
   * week, and this is where that shows up instead of being silently swallowed.
   */
  const ruleStatuses = useMemo(() => {
    if (!plan || !ctx?.rules?.length) return [];
    return evaluateRules(plan.slots, ctx.rules);
  }, [plan, ctx]);

  // `?? []` because plans written before the treat bag existed have no such
  // field, and a plan is a stored document rather than a row with a schema.
  const treats = plan?.treats ?? [];

  /**
   * How many pantry items this week's shop is picking up.
   *
   * In the heading because the section is long, sits at the bottom of a long
   * page, and is worth opening only when it has something to say.
   */
  const onListCount = useMemo(() => pantry.filter(isOnList).length, [pantry]);

  /**
   * That count as a phrase, or nothing at all while the cupboard is empty —
   * "nothing needed" over an empty pantry is true and useless, and the section
   * says the same thing at length inside.
   */
  const pantryNote =
    pantry.length === 0
      ? undefined
      : onListCount === 0
        ? 'nothing needed'
        : `${onListCount} on the list`;

  async function redrawTreatBag(): Promise<void> {
    if (!plan) return;
    setRedrawingTreats(true);
    try {
      await redrawTreats(plan);
    } finally {
      setRedrawingTreats(false);
    }
  }

  async function regenerate(): Promise<void> {
    if (!ctx) return;
    setBusy(true);
    try {
      await generateAndSave(ctx, { keepPinnedFrom: plan });
    } finally {
      setBusy(false);
    }
  }

  async function rerollSection(mealType: MealType): Promise<void> {
    if (!ctx || !plan) return;
    setRerolling(mealType);
    try {
      await regenerateMealSection(ctx, plan, mealType);
    } finally {
      setRerolling(null);
    }
  }

  if (!plan) {
    return (
      <main className="screen">
        <Header />
        <div className="empty" style={{ marginTop: '18vh' }}>
          <h2>No plan yet</h2>
          <p>
            Build a week of meals that share ingredients, so nothing is bought for a
            single recipe and left to rot.
          </p>
          <button className="btn primary" onClick={() => void regenerate()} disabled={busy || !ctx}>
            {busy ? 'Planning…' : 'Plan my week'}
          </button>
        </div>
      </main>
    );
  }

  const byType = (type: MealType): PlanSlot[] => plan.slots.filter((s) => s.mealType === type);
  const pinnedCount = plan.slots.filter((s) => s.pinned).length;
  const emptyCount = plan.slots.filter((s) => s.recipeId === null).length;

  // Restrictions can leave the library with too few recipes to fill a week. That
  // is correct behaviour, but a column of "Empty slot" with no explanation looks
  // like a bug — and the fix (loosen something, or add recipes) is not guessable.
  const restrictions = [
    settings.allergens.length > 0 ? 'your allergies' : null,
    settings.diets.length > 0 ? 'your diet filters' : null,
    settings.excludedIngredients.length > 0 ? 'your excluded ingredients' : null,
  ].filter(Boolean) as string[];

  return (
    <main className="screen">
      <Header subtitle={weekLabel(plan.weekStartISO)} />

      {allergenAlerts.length > 0 && (
        <div
          className="card"
          style={{ borderColor: 'var(--danger)', marginTop: 12 }}
          role="alert"
        >
          <div className="strong" style={{ color: 'var(--danger)' }}>
            {allergenAlerts.length} meal{allergenAlerts.length === 1 ? '' : 's'} in this
            plan contain{allergenAlerts.length === 1 ? 's' : ''} something you avoid
          </div>
          {allergenAlerts.map(({ recipe, report }) => (
            <div className="tiny dim" style={{ marginTop: 6 }} key={recipe.id}>
              <strong>{recipe.name}</strong> — {describeMatches(report.matches)}
            </div>
          ))}
          <div className="tiny faint" style={{ marginTop: 8 }}>
            Shuffle or unpin these. A fresh draw will not pick them again.
          </div>
        </div>
      )}

      {settings.summarySectionEnabled && score && (
        <div className="stat-grid" style={{ marginTop: 12 }}>
          <div className="stat">
            <div className="v">${score.waste.toFixed(2)}</div>
            <div className="k">likely waste</div>
          </div>
          <div className="stat">
            <div className="v">${score.spend.toFixed(0)}</div>
            <div className="k">estimated spend</div>
          </div>
          <div className="stat">
            <div className="v">{Math.round(score.season * 100)}%</div>
            <div className="k">in season</div>
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <button className="btn primary grow" onClick={() => void regenerate()} disabled={busy}>
          <span className="row" style={{ justifyContent: 'center', gap: 8 }}>
            <ShuffleIcon />
            {busy ? 'Planning…' : pinnedCount > 0 ? `Regenerate (keeping ${pinnedCount})` : 'Regenerate'}
          </span>
        </button>
        <button className="btn" onClick={onShop}>Shop</button>
      </div>

      {ruleStatuses.length > 0 && (
        <WeekRulesReport statuses={ruleStatuses} state={state} />
      )}

      {emptyCount > 0 && (
        <div className="card" style={{ borderColor: 'var(--warn)', marginTop: 10 }}>
          <div className="strong" style={{ color: 'var(--warn)' }}>
            {emptyCount} slot{emptyCount === 1 ? '' : 's'} could not be filled
          </div>
          <div className="small dim" style={{ marginTop: 4 }}>
            {restrictions.length > 0
              ? `Not enough recipes get past ${restrictions.join(' and ')}. `
              : 'Not enough recipes match the current filters. '}
            Add more recipes, loosen a restriction, or shrink the week in Settings.
          </div>
        </div>
      )}

      {settings.mealsSectionEnabled && pinnedCount === 0 && emptyCount === 0 && (
        <p className="tiny faint" style={{ marginTop: 8 }}>
          Pin a meal to keep it when you regenerate. To draw again without rebuilding
          the week, shuffle one kind of meal from its heading, or a single meal from
          its card.
        </p>
      )}

      {settings.mealsSectionEnabled &&
        (['full', 'light', 'snack'] as const).map((type) => {
          const slots = byType(type);
          if (slots.length === 0) return null;

          // Nothing for this button to do when every meal of the kind is pinned
          // and the section is already the size Settings asks for. Pressing it
          // would change nothing on screen, which reads as the button being
          // broken rather than as the pins doing their job.
          const stuck = slots.every((s) => s.pinned) && slots.length === settings.spec[type];

          return (
            <CollapsibleSection
              key={type}
              id={`meals:${type}`}
              title={MEAL_LABELS[type]}
              closedNote={`${slots.length} planned`}
              actions={
                <button
                  className="btn small"
                  // The visible label is the same on all three, so the section it
                  // belongs to has to be in the accessible name.
                  aria-label={`Shuffle all ${MEAL_LABELS[type].toLowerCase()}`}
                  title={
                    stuck
                      ? `Every one of these is pinned. Unpin one to shuffle it.`
                      : undefined
                  }
                  disabled={busy || rerolling !== null || stuck || !ctx}
                  onClick={() => void rerollSection(type)}
                >
                  <span className="row" style={{ gap: 6 }}>
                    <ShuffleIcon size={15} />
                    {rerolling === type ? 'Shuffling…' : 'Shuffle all'}
                  </span>
                </button>
              }
            >
              {slots.map((slot) => (
                <SlotCard
                  key={slot.id}
                  slot={slot}
                  plan={plan}
                  state={state}
                  onPick={() => setPicking(slot)}
                />
              ))}
            </CollapsibleSection>
          );
        })}

      <GrabBagSections state={state} />

      {settings.treatBagEnabled && (
        <CollapsibleSection
          id="treats"
          title="Treats"
          closedNote={treats.length === 0 ? 'empty' : `${treats.length} drawn`}
          actions={
            <button
              className="btn small"
              disabled={redrawingTreats}
              onClick={() => void redrawTreatBag()}
            >
              <span className="row" style={{ gap: 6 }}>
                <ShuffleIcon size={15} />
                {redrawingTreats ? 'Drawing…' : 'Redraw'}
              </span>
            </button>
          }
        >
          <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
            Herbal teas and other small good things, none of them over{' '}
            {formatMoneyShort(MAX_TREAT_CENTS, settings.currency)} and deliberately
            not all food. Keep one to hold it through the next draw.
          </p>

          {treats.length === 0 && (
            <p className="tiny faint" style={{ margin: '6px 0 10px' }}>
              {emptyTreatReason(settings.treatCount, eligibleTreats(settings).length > 0)}
            </p>
          )}

          {treats.map((item) => {
            const treat = getTreat(item.treatId);
            if (!treat) return null;
            return (
              <div className="card tight row between" key={item.treatId}>
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="strong">{treat.name}</span>
                    <span className="badge">{TREAT_KIND_LABELS[treat.kind]}</span>
                  </div>
                  <div className="tiny dim">{treat.note}</div>
                  <div className="tiny faint" style={{ marginTop: 2 }}>
                    about {formatTreatPrice(treat, settings.currency)}
                  </div>
                </div>
                <button
                  className="btn small"
                  aria-pressed={item.pinned}
                  style={item.pinned ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                  onClick={() => void setTreatPinned(plan.id, item.treatId, !item.pinned)}
                >
                  {item.pinned ? 'Kept' : 'Keep'}
                </button>
                <button
                  className="btn small ghost"
                  aria-label={`Remove ${treat.name}`}
                  onClick={() => void removeTreat(plan.id, item.treatId)}
                >
                  ✕
                </button>
              </div>
            );
          })}

          {treats.some((t) => getTreat(t.treatId)?.kind === 'tea') && (
            <p className="tiny faint" style={{ marginTop: 8 }}>
              Herbal teas are not inert — a few of them interact with medication.
              Worth a look if you take any.
            </p>
          )}
        </CollapsibleSection>
      )}

      {settings.pantrySectionEnabled && (
        <CollapsibleSection
          id="pantry"
          title="Pantry"
          // The same sentence whether the section is open or folded — it is the
          // one line of this section worth having without opening it.
          closedNote={pantryNote}
          actions={pantryNote !== undefined && <span className="tiny faint">{pantryNote}</span>}
        >
          <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
            What the cupboard is sending to this week's shop. Open the full list to
            say what is left of everything else.
          </p>

          <PantryReview state={state} />
        </CollapsibleSection>
      )}

      {picking && ctx && (
        <Sheet title={`Pick a ${MEAL_LABELS[picking.mealType].toLowerCase().replace(/s$/, '')}`} onClose={() => setPicking(null)}>
          {applyFilter(recipes.values(), { mealTypes: [picking.mealType] }, {
            ingredients, region: ctx.region, month: ctx.month,
          })
            .filter((r) => !plan.slots.some((s) => s.recipeId === r.id && s.id !== picking.id))
            .map((r) => {
              const n = recipeNutrition(r, ingredients);
              return (
                <button
                  key={r.id}
                  className="card tight row between"
                  style={{ width: '100%', textAlign: 'left' }}
                  onClick={() => {
                    void setSlotRecipe(plan.id, picking.id, r.id);
                    setPicking(null);
                  }}
                >
                  <div className="grow">
                    <div className="strong">{r.name}</div>
                    <div className="tiny dim">
                      {r.prepMinutes + r.cookMinutes} min · {Math.round(n.proteinG)} g protein
                    </div>
                  </div>
                  {r.id === picking.recipeId && <span className="badge accent">current</span>}
                </button>
              );
            })}
        </Sheet>
      )}
    </main>
  );
}

/**
 * One line per rule: what it asked for, and what the week actually has.
 *
 * Both halves matter. "2 of 3" is the number that tells you whether to press
 * Shuffle again; the sentence beside it is what makes the number mean anything a
 * week after the rule was written. An unmet rule the library cannot satisfy says
 * so rather than inviting a shuffle that cannot help.
 */
function WeekRulesReport({
  statuses,
  state,
}: {
  statuses: readonly RuleStatus[];
  state: AppState;
}): JSX.Element {
  const unmet = statuses.filter((s) => !s.satisfied).length;

  return (
    <div
      className="card"
      style={{ marginTop: 10, borderColor: unmet > 0 ? 'var(--warn)' : undefined }}
    >
      <div className="row between">
        <span className="strong">Week rules</span>
        <span className="tiny faint">
          {unmet === 0 ? 'all met' : `${unmet} not met`}
        </span>
      </div>

      {statuses.map((status) => {
        const name = status.rule.ingredientId
          ? state.ingredients.get(status.rule.ingredientId)?.name
          : undefined;
        const reason = impossibleReason(status);
        return (
          <div className="tiny" style={{ marginTop: 6 }} key={status.rule.id}>
            <span
              aria-hidden
              style={{ color: status.satisfied ? 'var(--accent)' : 'var(--warn)' }}
            >
              {status.satisfied ? '✓' : '✗'}
            </span>{' '}
            <span className="dim">{describeRule(status.rule, name)}</span>{' '}
            {/* The tick is decorative because the numbers already carry the
                verdict: "at least 3 … — 1 in this week" says it without help. */}
            <span className="faint">— {status.matched} in this week</span>
            {!status.satisfied && reason !== null && (
              <div className="faint" style={{ marginLeft: 14 }}>{reason}</div>
            )}
          </div>
        );
      })}

      {unmet > 0 && (
        <div className="tiny faint" style={{ marginTop: 8 }}>
          Shuffle to try again, or change what you are asking for under Week rules
          in Settings. Pinned meals are kept, so a pin can be what is in the way.
        </div>
      )}
    </div>
  );
}

function Header({ subtitle }: { subtitle?: string }): JSX.Element {
  return (
    <div className="header">
      <h1>This week</h1>
      {subtitle && <div className="sub">{subtitle}</div>}
    </div>
  );
}

function SlotCard({
  slot,
  plan,
  state,
  onPick,
}: {
  slot: PlanSlot;
  plan: WeekPlan;
  state: AppState;
  onPick: () => void;
}): JSX.Element {
  const { ctx, settings } = state;
  const recipe = slot.recipeId ? state.recipes.get(slot.recipeId) : null;
  const nutrition = recipe ? recipeNutrition(recipe, state.ingredients, slot.servings) : null;

  const [showing, setShowing] = useState(false);
  const [drawing, setDrawing] = useState(false);

  /**
   * What this card's redraw has already offered and had turned down.
   *
   * Held here rather than on the plan because it is a fact about pressing this
   * button, not about the week: nothing else in the app cares, and it is no
   * loss if a reload forgets it.
   */
  const [passedOver, setPassedOver] = useState<ReadonlySet<Id>>(new Set());

  /**
   * Set when a redraw came back empty, which is the one state where the button
   * has nothing left to do. Cleared the moment a different meal lands in this
   * slot by any route — a swap, a regenerate — because the pool it exhausted
   * was this meal's, and a failed redraw is exactly the case that leaves the
   * meal where it was, so this never clears itself out from under a live note.
   */
  const [exhausted, setExhausted] = useState(false);
  useEffect(() => setExhausted(false), [slot.recipeId]);

  async function redraw(): Promise<void> {
    if (!ctx) return;
    const going = slot.recipeId;
    setDrawing(true);
    try {
      const drew = await regenerateSlot(ctx, plan, slot.id, passedOver);
      setExhausted(!drew);
      if (drew && going) setPassedOver((prev) => new Set(prev).add(going));
    } finally {
      setDrawing(false);
    }
  }

  const meta = recipe && (
    <>
      <div className="strong">{recipe.name}</div>
      <div className="tiny dim" style={{ marginTop: 3 }}>
        {recipe.prepMinutes + recipe.cookMinutes} min
        {nutrition && nutrition.coverage > 0.7 &&
          ` · ${Math.round(nutrition.proteinG)} g protein · ${Math.round(nutrition.kcal)} kcal`}
      </div>
    </>
  );

  return (
    <div className="card">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        {/* The text block alone, not the whole card: the card holds four other
            controls, and a button inside a button is not a thing. An empty slot
            is a plain heading — there is no recipe behind it to open. */}
        {recipe ? (
          <button
            className="grow"
            style={{ background: 'none', border: 0, padding: 0, textAlign: 'left' }}
            // "Chickpea stew" on its own does not say what pressing it does, and
            // this card is a column of things that all look pressable.
            aria-label={`${recipe.name} — see the recipe`}
            onClick={() => setShowing(true)}
          >
            {meta}
          </button>
        ) : (
          <div className="grow">
            <div className="strong">Empty slot</div>
          </div>
        )}

        <button
          className="btn small ghost"
          aria-label={slot.pinned ? 'Unpin' : 'Pin'}
          aria-pressed={slot.pinned}
          style={slot.pinned ? { color: 'var(--accent)' } : undefined}
          onClick={() => void setSlotPinned(plan.id, slot.id, !slot.pinned)}
        >
          <PinIcon filled={slot.pinned} />
        </button>
      </div>

      {/* The stepper and both buttons share one line down to 375px, which is as
          narrow as the phones this is used on. Below that they wrap instead of
          spilling past the card edge — cheaper than clipping, and cheaper than
          dropping back to icons with no words on them. */}
      <div
        className="row between"
        style={{ marginTop: 10, flexWrap: 'wrap', rowGap: 10 }}
      >
        <div className="stepper">
          <button
            aria-label="Fewer portions"
            onClick={() => void setSlotServings(plan.id, slot.id, slot.servings - 1)}
          >
            −
          </button>
          <span className="val">{slot.servings}</span>
          <button
            aria-label="More portions"
            onClick={() => void setSlotServings(plan.id, slot.id, slot.servings + 1)}
          >
            +
          </button>
          <span className="tiny faint" style={{ marginLeft: 6 }}>portions</span>
        </div>
        <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
          {/* Choosing a particular meal is the rarer intent — "there is chard to
              use up" — so it keeps the quieter button of the two. */}
          <button className="btn small ghost" onClick={onPick}>Pick</button>

          {/* The section's "Shuffle all" narrowed to one card. The word is what
              ties the two together — the icon on its own never said which scope
              it meant, and at 375px the three controls only share a line if this
              button carries text alone. */}
          <button
            className="btn small"
            aria-label={
              recipe
                ? `Shuffle — draw a different meal instead of ${recipe.name}`
                : 'Shuffle — draw a meal for this slot'
            }
            title={
              slot.pinned
                ? 'Pinned. Unpin it to draw a different one.'
                : exhausted
                  ? 'Nothing else to draw. Everything else is in the week already, ruled out by your filters, or has been passed over.'
                  : undefined
            }
            disabled={drawing || slot.pinned || exhausted || !ctx}
            onClick={() => void redraw()}
          >
            {drawing ? 'Drawing…' : 'Shuffle'}
          </button>
        </div>
      </div>

      {showing && recipe && (
        <Sheet title={recipe.name} onClose={() => setShowing(false)}>
          {/* The week owns the portions, so the sheet's stepper writes to the
              slot rather than keeping a second number that would sit there
              disagreeing with the card underneath it. */}
          <RecipeDetail
            recipe={recipe}
            state={state}
            unitSystem={settings.unitSystem}
            servings={slot.servings}
            onServingsChange={(n) => void setSlotServings(plan.id, slot.id, n)}
          />
        </Sheet>
      )}
    </div>
  );
}

function weekLabel(iso: string): string {
  const start = new Date(`${iso}T00:00:00`);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const fmt = (d: Date): string =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * Why the treat bag is empty.
 *
 * Three ways it happens, and they want different answers: the size is zero, the
 * allergies and diets between them rule out the whole catalogue, or the bag
 * simply has not been drawn — which is every plan made before this existed, and
 * the one case where there is something to press. A bag switched off is not a
 * fourth: the whole section goes with the switch.
 */
function emptyTreatReason(target: number, anyEligible: boolean): string {
  if (target === 0) return 'Set to zero.';
  if (!anyEligible) {
    return 'Nothing to draw — your allergies and diets rule out every treat there is.';
  }
  return 'Empty. Redraw to fill it.';
}
