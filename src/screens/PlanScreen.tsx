import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { generateAndSave } from '../state/useAppState';
import {
  removeWildcard, setSlotPinned, setSlotRecipe, setSlotServings, setWildcardPromoted,
} from '../db/repository';
import { scorePlan } from '../domain/planner/scoring';
import { applyFilter } from '../domain/filters';
import { formatQuantity } from '../domain/units';
import { recipeNutrition } from '../domain/nutrition';
import { seasonStatus } from '../domain/seasonality';
import type { Id, MealType, PlanSlot } from '../domain/types';
import { PinIcon, ShuffleIcon } from '../components/icons';
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
  const [swapping, setSwapping] = useState<PlanSlot | null>(null);

  const score = useMemo(
    () => (plan && ctx ? scorePlan(plan.slots, plan.wildcards, ctx) : null),
    [plan, ctx],
  );

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

  return (
    <main className="screen">
      <Header subtitle={weekLabel(plan.weekStartISO)} />

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

      {pinnedCount === 0 && (
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

      {plan.wildcards.length > 0 && (
        <section>
          <h2 className="section-title">Produce grab bag</h2>
          <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
            A random draw weighted to what is in season and on sale — the antidote to
            cooking the same eight things forever. Promote one to build next week's
            plan around it.
          </p>
          {plan.wildcards.map((w) => {
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
        </section>
      )}

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
