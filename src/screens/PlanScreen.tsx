import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { generateAndSave, redrawWildcards } from '../state/useAppState';
import {
  removeWildcard, setSlotPinned, setSlotRecipe, setSlotServings, setWildcardPromoted,
} from '../db/repository';
import { scorePlan } from '../domain/planner/scoring';
import { applyFilter } from '../domain/filters';
import { formatQuantity } from '../domain/units';
import { recipeNutrition } from '../domain/nutrition';
import { seasonStatus } from '../domain/seasonality';
import { type ProduceKind, PRODUCE_KINDS, PRODUCE_KIND_LABELS, produceKind } from '../domain/produce';
import { checkRecipe, describeMatches } from '../domain/allergens';
import type { Id, MealType, PlanSlot, WildcardItem } from '../domain/types';
import { PinIcon, ShuffleIcon } from '../components/icons';
import { GrabBagControls } from '../components/GrabBagControls';
import { Sheet } from '../components/Sheet';

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
  const { plan, ctx, recipes, ingredients, settings } = state;
  const [busy, setBusy] = useState(false);
  const [redrawing, setRedrawing] = useState(false);
  const [swapping, setSwapping] = useState<PlanSlot | null>(null);

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
   * The grab bag as it should be displayed: one bag, or fruit and veg separately.
   *
   * Grouped here rather than relying on draw order, because promoting and removing
   * items edit the list in place and a plan drawn before the split was turned on
   * has no order to rely on in the first place.
   */
  const bags = useMemo((): Array<{ kind: ProduceKind | null; items: WildcardItem[] }> => {
    const items = plan?.wildcards ?? [];
    if (!settings.wildcardSplit) return [{ kind: null, items: [...items] }];
    return PRODUCE_KINDS.map((kind) => ({
      kind,
      items: items.filter((w) => {
        const ing = ingredients.get(w.ingredientId);
        return ing !== undefined && produceKind(ing) === kind;
      }),
    }));
  }, [plan?.wildcards, settings.wildcardSplit, ingredients]);

  async function redraw(): Promise<void> {
    if (!ctx || !plan) return;
    setRedrawing(true);
    try {
      await redrawWildcards(ctx, plan);
    } finally {
      setRedrawing(false);
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
            Swap or unpin these. Regenerating will not pick them again.
          </div>
        </div>
      )}

      {score && (
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

      {pinnedCount === 0 && emptyCount === 0 && (
        <p className="tiny faint" style={{ marginTop: 8 }}>
          Pin a meal to keep it when you regenerate.
        </p>
      )}

      {(['full', 'light', 'snack'] as const).map((type) => {
        const slots = byType(type);
        if (slots.length === 0) return null;
        return (
          <section key={type}>
            <h2 className="section-title">{MEAL_LABELS[type]}</h2>
            {slots.map((slot) => (
              <SlotCard
                key={slot.id}
                slot={slot}
                planId={plan.id}
                state={state}
                onSwap={() => setSwapping(slot)}
              />
            ))}
          </section>
        );
      })}

      <section>
        <div className="row between" style={{ alignItems: 'baseline' }}>
          <h2 className="section-title grow">Produce grab bag</h2>
          <button
            className="btn small"
            disabled={redrawing || !ctx}
            onClick={() => void redraw()}
          >
            <span className="row" style={{ gap: 6 }}>
              <ShuffleIcon size={15} />
              {redrawing ? 'Drawing…' : 'Redraw'}
            </span>
          </button>
        </div>
        <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
          A random draw weighted to what is in season and on sale — the antidote to
          cooking the same eight things forever. Promote one to build next week's
          plan around it, or redraw the bag without touching the meals.
        </p>

        <GrabBagControls state={state} />

        {bags.map(({ kind, items }) => (
          <div key={kind ?? 'all'}>
            {kind && <h3 className="sub-title">{PRODUCE_KIND_LABELS[kind]}</h3>}
            {items.length === 0 && (
              <p className="tiny faint" style={{ margin: '6px 0 10px' }}>
                {emptyBagReason(kind, settings.wildcardSplit
                  ? (kind === 'fruit' ? settings.wildcardFruitCount : settings.wildcardVegCount)
                  : settings.wildcardCount)}
              </p>
            )}
            {items.map((w) => {
              const ing = ingredients.get(w.ingredientId);
              if (!ing) return null;
              const status = ctx ? seasonStatus(ing, ctx.month, ctx.region) : 'unknown';
              return (
                <div className="card tight row between" key={w.ingredientId}>
                  <div className="grow">
                    <div className="row" style={{ gap: 6 }}>
                      <span className="strong">{ing.name}</span>
                      {status === 'peak' && <span className="badge accent">peak</span>}
                    </div>
                    <div className="tiny dim">
                      {formatQuantity(w.grams, ing, settings.unitSystem).text}
                    </div>
                  </div>
                  <button
                    className="btn small"
                    aria-pressed={w.promoted}
                    style={w.promoted ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                    onClick={() => void setWildcardPromoted(plan.id, w.ingredientId, !w.promoted)}
                  >
                    {w.promoted ? 'Promoted' : 'Promote'}
                  </button>
                  <button
                    className="btn small ghost"
                    aria-label={`Remove ${ing.name}`}
                    onClick={() => void removeWildcard(plan.id, w.ingredientId)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </section>

      {swapping && ctx && (
        <Sheet title={`Swap ${MEAL_LABELS[swapping.mealType].toLowerCase().replace(/s$/, '')}`} onClose={() => setSwapping(null)}>
          {applyFilter(recipes.values(), { mealTypes: [swapping.mealType] }, {
            ingredients, region: ctx.region, month: ctx.month,
          })
            .filter((r) => !plan.slots.some((s) => s.recipeId === r.id && s.id !== swapping.id))
            .map((r) => {
              const n = recipeNutrition(r, ingredients);
              return (
                <button
                  key={r.id}
                  className="card tight row between"
                  style={{ width: '100%', textAlign: 'left' }}
                  onClick={() => {
                    void setSlotRecipe(plan.id, swapping.id, r.id);
                    setSwapping(null);
                  }}
                >
                  <div className="grow">
                    <div className="strong">{r.name}</div>
                    <div className="tiny dim">
                      {r.prepMinutes + r.cookMinutes} min · {Math.round(n.proteinG)} g protein
                    </div>
                  </div>
                  {r.id === swapping.recipeId && <span className="badge accent">current</span>}
                </button>
              );
            })}
        </Sheet>
      )}
    </main>
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
  planId,
  state,
  onSwap,
}: {
  slot: PlanSlot;
  planId: Id;
  state: AppState;
  onSwap: () => void;
}): JSX.Element {
  const recipe = slot.recipeId ? state.recipes.get(slot.recipeId) : null;
  const nutrition = recipe ? recipeNutrition(recipe, state.ingredients, slot.servings) : null;

  return (
    <div className="card">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <div className="strong">{recipe?.name ?? 'Empty slot'}</div>
          {recipe && (
            <div className="tiny dim" style={{ marginTop: 3 }}>
              {recipe.prepMinutes + recipe.cookMinutes} min
              {nutrition && nutrition.coverage > 0.7 &&
                ` · ${Math.round(nutrition.proteinG)} g protein · ${Math.round(nutrition.kcal)} kcal`}
            </div>
          )}
        </div>
        <button
          className="btn small ghost"
          aria-label={slot.pinned ? 'Unpin' : 'Pin'}
          aria-pressed={slot.pinned}
          style={slot.pinned ? { color: 'var(--accent)' } : undefined}
          onClick={() => void setSlotPinned(planId, slot.id, !slot.pinned)}
        >
          <PinIcon filled={slot.pinned} />
        </button>
      </div>

      <div className="row between" style={{ marginTop: 10 }}>
        <div className="stepper">
          <button
            aria-label="Fewer portions"
            onClick={() => void setSlotServings(planId, slot.id, slot.servings - 1)}
          >
            −
          </button>
          <span className="val">{slot.servings}</span>
          <button
            aria-label="More portions"
            onClick={() => void setSlotServings(planId, slot.id, slot.servings + 1)}
          >
            +
          </button>
          <span className="tiny faint" style={{ marginLeft: 6 }}>portions</span>
        </div>
        <button className="btn small" onClick={onSwap}>Swap</button>
      </div>
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
 * Why a bag came back empty. A zero size is a choice; anything else means the
 * library has nothing left to offer once exclusions are applied, and saying so is
 * the difference between a fixable problem and a screen that looks broken.
 */
function emptyBagReason(kind: ProduceKind | null, target: number): string {
  if (target === 0) return 'Turned off.';
  const what = kind === null ? 'produce' : PRODUCE_KIND_LABELS[kind].toLowerCase();
  return `No ${what} left to draw — add more to the library, or check what you have excluded.`;
}
