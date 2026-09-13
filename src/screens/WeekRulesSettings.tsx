/**
 * The week rules editor.
 *
 * Here rather than on the This week screen, like every other control that
 * configures the app: the week screen is the week. What that screen shows is
 * whether THIS week met the rules, which is a fact about the week and belongs
 * there; the rules themselves are a standing answer to "what do we want out of a
 * week", which is a setting and belongs here.
 *
 * One card per rule, and each card reads as the sentence it is — "At least 3
 * full meals under 30 minutes" — with the controls underneath in the order the
 * sentence says them. A rule is four separate decisions and a form of four
 * unlabelled dropdowns hides what they add up to.
 */

import { useMemo, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { updateSettings } from '../db/repository';
import { IngredientPicker } from '../components/IngredientPicker';
import { CUISINE_REGIONS, DISH_TYPES } from '../domain/taxonomy';
import {
  type WeekRule, DEFAULT_RULE_MAX_INGREDIENTS, DEFAULT_RULE_MINUTES, RULE_SUBJECTS,
  availableCounts, describeRule, getSubject, isConfigured, newRule, ruleTagVocabulary, withSubject,
} from '../domain/weekRules';
import type { MealType } from '../domain/types';

const MEAL_LABELS: Record<MealType, string> = {
  full: 'Full meals',
  light: 'Light meals',
  snack: 'Snacks',
};

export function WeekRulesSettings({ state }: { state: AppState }): JSX.Element {
  const { settings, ingredients, recipes, ctx } = state;
  const rules = settings.weekRules;

  /**
   * How many recipes each rule could possibly match, taken from the compiled
   * rules the planner is already using rather than recomputed here. Two answers
   * to "does anything match this" is one answer too many.
   */
  const available = useMemo(() => availableCounts(ctx?.rules ?? []), [ctx?.rules]);

  /** Tags worth offering, commonest first. Cuisines are excluded: they have a subject. */
  const tags = useMemo(() => ruleTagVocabulary(recipes.values()), [recipes]);

  async function write(next: readonly WeekRule[]): Promise<void> {
    await updateSettings({ weekRules: next });
  }

  return (
    <>
      {rules.length === 0 && (
        <p className="tiny faint" style={{ margin: '0 0 8px' }}>
          No rules yet, so a week is whatever wastes least. Add one and every
          regenerate and shuffle has to honour it.
        </p>
      )}

      {rules.map((rule) => (
        <RuleCard
          key={rule.id}
          rule={rule}
          tags={tags}
          available={available.get(rule.id)}
          ingredientName={
            rule.ingredientId ? ingredients.get(rule.ingredientId)?.name : undefined
          }
          state={state}
          onChange={(next) => void write(rules.map((r) => (r.id === rule.id ? next : r)))}
          onRemove={() => void write(rules.filter((r) => r.id !== rule.id))}
        />
      ))}

      <button
        className="btn block"
        style={{ marginBottom: 10 }}
        onClick={() => void write([...rules, newRule('quick', tags)])}
      >
        Add a rule
      </button>
    </>
  );
}

export function RuleCard({
  rule,
  tags,
  available,
  ingredientName,
  state,
  onChange,
  onRemove,
}: {
  rule: WeekRule;
  tags: readonly string[];
  available: number | undefined;
  ingredientName: string | undefined;
  state: AppState;
  onChange: (rule: WeekRule) => void;
  onRemove: () => void;
}): JSX.Element {
  const [picking, setPicking] = useState(false);
  const subject = getSubject(rule.subject);

  // Only ever a shortage: an "at most" rule is satisfied by a week with none of
  // the thing in it, so an empty library cannot break one.
  const short =
    rule.comparison === 'at-least' && available !== undefined && available < rule.count;

  return (
    <div className="card">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <span className="grow strong">{describeRule(rule, ingredientName)}</span>
        <button className="btn small ghost" aria-label="Remove this rule" onClick={onRemove}>
          ✕
        </button>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <div className="segmented" style={{ flex: '0 0 150px' }}>
          <button
            aria-pressed={rule.comparison === 'at-least'}
            onClick={() => onChange({ ...rule, comparison: 'at-least' })}
          >
            At least
          </button>
          <button
            aria-pressed={rule.comparison === 'at-most'}
            onClick={() => onChange({ ...rule, comparison: 'at-most' })}
          >
            At most
          </button>
        </div>

        <div className="stepper">
          <button
            aria-label="Fewer meals"
            onClick={() => onChange({ ...rule, count: Math.max(0, rule.count - 1) })}
          >
            −
          </button>
          <span className="val">{rule.count}</span>
          <button
            aria-label="More meals"
            onClick={() => onChange({ ...rule, count: rule.count + 1 })}
          >
            +
          </button>
        </div>
      </div>

      <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
        <label htmlFor={`subject-${rule.id}`}>What the meals have in common</label>
        <select
          id={`subject-${rule.id}`}
          value={rule.subject}
          // Through `withSubject`, so the rule arrives carrying the parameter the
          // control beside it is already showing.
          onChange={(e) =>
            onChange(withSubject(rule, e.target.value as WeekRule['subject'], tags))
          }
        >
          {RULE_SUBJECTS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>

      {subject.parameter === 'minutes' && (
        <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <label htmlFor={`minutes-${rule.id}`}>Minutes, start to plate</label>
          <input
            id={`minutes-${rule.id}`}
            type="number"
            min={5}
            max={180}
            step={5}
            value={rule.minutes ?? DEFAULT_RULE_MINUTES}
            onChange={(e) =>
              onChange({ ...rule, minutes: Number(e.target.value) || DEFAULT_RULE_MINUTES })
            }
          />
        </div>
      )}

      {subject.parameter === 'count' && (
        <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <label htmlFor={`ingredients-${rule.id}`}>Ingredients at most</label>
          <input
            id={`ingredients-${rule.id}`}
            type="number"
            min={1}
            max={20}
            value={rule.maxIngredients ?? DEFAULT_RULE_MAX_INGREDIENTS}
            onChange={(e) =>
              onChange({
                ...rule,
                maxIngredients: Number(e.target.value) || DEFAULT_RULE_MAX_INGREDIENTS,
              })
            }
          />
        </div>
      )}

      {subject.parameter === 'dish-type' && (
        <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <label htmlFor={`dish-${rule.id}`}>Kind of dish</label>
          <select
            id={`dish-${rule.id}`}
            value={rule.dishType ?? 'pasta'}
            onChange={(e) =>
              onChange({ ...rule, dishType: e.target.value as WeekRule['dishType'] })
            }
          >
            {DISH_TYPES.filter((t) => t.id !== 'other').map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      )}

      {subject.parameter === 'region' && (
        <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <label htmlFor={`region-${rule.id}`}>Region</label>
          <select
            id={`region-${rule.id}`}
            value={rule.region ?? 'italy'}
            onChange={(e) =>
              onChange({ ...rule, region: e.target.value as WeekRule['region'] })
            }
          >
            {CUISINE_REGIONS.filter((r) => r.id !== 'unfiled').map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
          <div className="hint">
            Where the food is from, not where you shop — that one is at the top of
            this page.
          </div>
        </div>
      )}

      {subject.parameter === 'tag' && (
        <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <label htmlFor={`tag-${rule.id}`}>Tag</label>
          <select
            id={`tag-${rule.id}`}
            value={rule.tag ?? tags[0] ?? ''}
            onChange={(e) => onChange({ ...rule, tag: e.target.value })}
          >
            {tags.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      )}

      {subject.parameter === 'ingredient' && (
        <div style={{ marginTop: 10 }}>
          <button className="btn small block" onClick={() => setPicking(true)}>
            {ingredientName ?? 'Choose an ingredient'}
          </button>
        </div>
      )}

      <div className="tiny faint" style={{ marginTop: 10 }}>Which meals this is about</div>
      <div className="chips" style={{ marginTop: 4 }}>
        {(['full', 'light', 'snack'] as const).map((type) => {
          const on = rule.mealTypes.includes(type);
          return (
            <button
              key={type}
              className="chip"
              aria-pressed={on}
              onClick={() =>
                onChange({
                  ...rule,
                  mealTypes: on
                    ? rule.mealTypes.filter((t) => t !== type)
                    : [...rule.mealTypes, type],
                })
              }
            >
              {MEAL_LABELS[type]}
            </button>
          );
        })}
      </div>
      {rule.mealTypes.length === 0 && (
        <div className="tiny faint" style={{ marginTop: 6 }}>
          Every meal in the week counts. Most snacks are already quick and
          five-ingredient, so a rule that covers them is easier to meet than it looks.
        </div>
      )}

      {!isConfigured(rule) ? (
        <div className="tiny" style={{ marginTop: 8, color: 'var(--warn)' }}>
          Unfinished — choose one above, or this rule matches nothing.
        </div>
      ) : available !== undefined && (
        <div
          className="tiny"
          style={{ marginTop: 8, color: short ? 'var(--warn)' : 'var(--muted)' }}
        >
          {short
            ? `Only ${available} recipe${available === 1 ? '' : 's'} in your library match this — the week will come back short.`
            : `${available} recipes in your library match.`}
        </div>
      )}

      {picking && (
        <IngredientPicker
          title="Which ingredient"
          ingredients={state.ingredients}
          exclude={new Set()}
          onPick={(ing) => {
            onChange({ ...rule, ingredientId: ing.id });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
