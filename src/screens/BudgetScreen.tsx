import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { db } from '../db/database';
import { addExpense, removeExpense, updateSettings } from '../db/repository';
import {
  EXPENSE_LABELS, VERDICT_TEXT, addMonths, centsToInput, formatMoney, formatMoneyShort,
  monthKey, monthKeyOf, monthLabel, monthlyTotals, parseMoney, summariseMonth, todayISO,
  verdict, type ExpenseKind,
} from '../domain/budget';
import type { AppState } from '../state/useAppState';
import { Sheet } from '../components/Sheet';

export function BudgetScreen({ state }: { state: AppState }): JSX.Element {
  const { settings } = state;
  const [month, setMonth] = useState(() => monthKey());
  const [adding, setAdding] = useState(false);
  const [editingGoal, setEditingGoal] = useState(false);

  const expenses = useLiveQuery(() => db.expenses.toArray(), [], []) ?? [];
  const currency = settings.currency;

  /**
   * Eating out can be excluded from the goal without hiding it: you still want to
   * see what a month of takeaways cost, even when the budget is about groceries.
   */
  const counted = useMemo(
    () => (settings.budgetIncludesDining ? expenses : expenses.filter((e) => e.kind !== 'dining')),
    [expenses, settings.budgetIncludesDining],
  );

  const summary = useMemo(
    () => summariseMonth(counted, month, settings.monthlyBudgetCents),
    [counted, month, settings.monthlyBudgetCents],
  );
  const allKinds = useMemo(() => summariseMonth(expenses, month, null), [expenses, month]);

  const history = useMemo(() => monthlyTotals(counted, 6), [counted]);
  const status = verdict(summary);
  const isCurrentMonth = month === monthKey();

  const monthExpenses = useMemo(
    () => expenses
      .filter((e) => monthKeyOf(e.dateISO) === month)
      .sort((a, b) => (a.dateISO < b.dateISO ? 1 : a.dateISO > b.dateISO ? -1 : 0)),
    [expenses, month],
  );

  return (
    <main className="screen">
      <div className="header">
        <h1>Spending</h1>
        <div className="sub">{VERDICT_TEXT[status]}</div>
      </div>

      <div className="month-nav" style={{ marginTop: 12 }}>
        <button aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))}>‹</button>
        <strong className="grow" style={{ textAlign: 'center' }}>{monthLabel(month)}</strong>
        <button
          aria-label="Next month"
          disabled={month >= monthKey()}
          onClick={() => setMonth((m) => addMonths(m, 1))}
        >
          ›
        </button>
      </div>

      <BudgetRing summary={summary} status={status} currency={currency} />

      {summary.goalCents === null ? (
        <button className="btn primary block" onClick={() => setEditingGoal(true)}>
          Set a monthly goal
        </button>
      ) : (
        <div className="stat-grid">
          <div className="stat">
            <div className="v">{formatMoneyShort(summary.goalCents, currency)}</div>
            <div className="k">monthly goal</div>
          </div>
          <div className="stat">
            <div className="v">
              {summary.projectedCents !== null
                ? formatMoneyShort(summary.projectedCents, currency)
                : '—'}
            </div>
            <div className="k">{summary.projectedCents !== null ? 'projected' : 'too early'}</div>
          </div>
          <div className="stat">
            <div className="v">
              {summary.dailyAllowanceCents !== null
                ? formatMoneyShort(summary.dailyAllowanceCents, currency)
                : '—'}
            </div>
            <div className="k">left per day</div>
          </div>
        </div>
      )}

      {/* Projection is the number that makes mid-month spending legible: "$190
          spent" says nothing on the 10th without knowing where it lands. */}
      {isCurrentMonth && summary.projectedCents !== null && summary.goalCents !== null && (
        <p className="tiny faint" style={{ marginTop: 8 }}>
          At this rate you will finish the month around{' '}
          <strong>{formatMoney(summary.projectedCents, currency)}</strong>
          {summary.projectedCents > summary.goalCents
            ? `, which is ${formatMoney(summary.projectedCents - summary.goalCents, currency)} over.`
            : `, which is ${formatMoney(summary.goalCents - summary.projectedCents, currency)} under.`}
        </p>
      )}

      {/* --- breakdown --------------------------------------------------- */}
      <h2 className="section-title">Where it went</h2>
      {(['groceries', 'dining', 'other'] as const).map((kind) => {
        const cents = allKinds.byKind[kind];
        if (cents === 0) return null;
        const share = allKinds.totalCents > 0 ? cents / allKinds.totalCents : 0;
        return (
          <div className="card tight row between" key={kind}>
            <span className="grow">
              {EXPENSE_LABELS[kind]}
              {kind === 'dining' && !settings.budgetIncludesDining && (
                <span className="badge" style={{ marginLeft: 6 }}>not counted</span>
              )}
            </span>
            <span className="tiny faint">{Math.round(share * 100)}%</span>
            <span className="strong" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatMoney(cents, currency)}
            </span>
          </div>
        );
      })}
      {allKinds.totalCents === 0 && (
        <div className="card small dim">Nothing recorded for this month yet.</div>
      )}

      {/* --- history ----------------------------------------------------- */}
      <h2 className="section-title">Last six months</h2>
      <div className="card">
        <MonthBars history={history} goalCents={settings.monthlyBudgetCents} currency={currency} />
      </div>

      {/* --- entries ----------------------------------------------------- */}
      <h2 className="section-title">Entries</h2>
      {monthExpenses.map((expense) => (
        <div className="card tight row between" key={expense.id}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="strong truncate">{expense.label}</div>
            <div className="tiny dim">
              {new Date(`${expense.dateISO}T12:00:00`).toLocaleDateString(undefined,
                { month: 'short', day: 'numeric' })}
              {' · '}{EXPENSE_LABELS[expense.kind]}
              {expense.note ? ` · ${expense.note}` : ''}
            </div>
          </div>
          <span className="strong" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatMoney(expense.amountCents, currency)}
          </span>
          <button
            className="btn small ghost"
            aria-label={`Delete ${expense.label}`}
            onClick={() => void removeExpense(expense.id)}
          >
            ✕
          </button>
        </div>
      ))}
      {monthExpenses.length === 0 && (
        <div className="card small dim">
          Finish a shop on the Shop tab to record its total, or add anything else here.
        </div>
      )}

      <button className="btn primary block" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>
        Add spending
      </button>
      {summary.goalCents !== null && (
        <button className="btn block" style={{ marginTop: 8 }} onClick={() => setEditingGoal(true)}>
          Change goal
        </button>
      )}

      {adding && <AddExpenseSheet currency={currency} onClose={() => setAdding(false)} />}
      {editingGoal && (
        <GoalSheet
          currency={currency}
          goalCents={settings.monthlyBudgetCents}
          includesDining={settings.budgetIncludesDining}
          onClose={() => setEditingGoal(false)}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function BudgetRing({
  summary, status, currency,
}: {
  summary: ReturnType<typeof summariseMonth>;
  status: ReturnType<typeof verdict>;
  currency: string;
}): JSX.Element {
  const size = 168;
  const stroke = 13;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  // Capped so overspending shows a full ring rather than winding round again,
  // which would read as being back under budget.
  const fraction = Math.min(1, summary.fractionOfGoal ?? 0);
  const offset = circumference * (1 - fraction);

  const fillClass = status === 'over-budget' ? 'over' : status === 'over-pace' ? 'warn' : '';

  return (
    <svg className="budget-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      role="img" aria-label={`${formatMoney(summary.totalCents, currency)} spent`}>
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle
          className="budget-track" cx={size / 2} cy={size / 2} r={radius}
          fill="none" strokeWidth={stroke}
        />
        {summary.goalCents !== null && (
          <circle
            className={`budget-fill ${fillClass}`} cx={size / 2} cy={size / 2} r={radius}
            fill="none" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={offset}
          />
        )}
      </g>
      <text className="budget-amount" x="50%" y="48%" textAnchor="middle">
        {formatMoneyShort(summary.totalCents, currency)}
      </text>
      <text className="budget-caption" x="50%" y="62%" textAnchor="middle">
        {summary.goalCents !== null
          ? `of ${formatMoneyShort(summary.goalCents, currency)}`
          : 'this month'}
      </text>
    </svg>
  );
}

function MonthBars({
  history, goalCents, currency,
}: {
  history: Array<{ key: string; totalCents: number }>;
  goalCents: number | null;
  currency: string;
}): JSX.Element {
  // Scaled against the goal as well as the data, so a low month is visibly low
  // rather than being stretched to fill the chart.
  const peak = Math.max(1, ...history.map((h) => h.totalCents), goalCents ?? 0);
  const current = monthKey();

  return (
    <>
      <div className="bars">
        {history.map((h) => (
          <div key={h.key} title={`${monthLabel(h.key)}: ${formatMoney(h.totalCents, currency)}`}>
            <i
              className={h.key === current ? 'current' : ''}
              style={{ height: `${Math.max(2, (h.totalCents / peak) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        {history.map((h) => (
          <span key={h.key} className="tiny faint grow" style={{ textAlign: 'center' }}>
            {h.key.slice(5)}
          </span>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function AddExpenseSheet({
  currency, onClose,
}: {
  currency: string;
  onClose: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<ExpenseKind>('dining');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [date, setDate] = useState(() => todayISO());

  const cents = parseMoney(amount);
  const valid = cents !== null && cents > 0;

  async function save(): Promise<void> {
    if (!valid) return;
    await addExpense({
      kind,
      amountCents: cents,
      label: label.trim() || EXPENSE_LABELS[kind],
      dateISO: date,
    });
    onClose();
  }

  return (
    <Sheet title="Add spending" onClose={onClose}>
      <div className="field">
        <label>What kind</label>
        <div className="segmented">
          {(['groceries', 'dining', 'other'] as const).map((k) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {EXPENSE_LABELS[k]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="amount">Amount</label>
        <input
          id="amount" type="text" inputMode="decimal" autoFocus
          value={amount} onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
        />
        {amount.trim() !== '' && !valid && (
          <div className="hint" style={{ color: 'var(--danger)' }}>
            Could not read that as an amount.
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="label">Where</label>
        <input
          id="label" type="text" value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={kind === 'dining' ? 'Restaurant name' : 'Shop name'}
        />
      </div>

      <div className="field">
        <label htmlFor="date">When</label>
        <input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <button className="btn primary block" disabled={!valid} onClick={() => void save()}>
        {valid ? `Add ${formatMoney(cents, currency)}` : 'Add'}
      </button>
    </Sheet>
  );
}

function GoalSheet({
  currency, goalCents, includesDining, onClose,
}: {
  currency: string;
  goalCents: number | null;
  includesDining: boolean;
  onClose: () => void;
}): JSX.Element {
  const [amount, setAmount] = useState(goalCents !== null ? centsToInput(goalCents) : '');
  const [dining, setDining] = useState(includesDining);

  const cents = parseMoney(amount);

  async function save(): Promise<void> {
    await updateSettings({
      monthlyBudgetCents: cents !== null && cents > 0 ? cents : null,
      budgetIncludesDining: dining,
    });
    onClose();
  }

  return (
    <Sheet title="Monthly goal" onClose={onClose}>
      <div className="field">
        <label htmlFor="goal">Monthly food budget</label>
        <input
          id="goal" type="text" inputMode="decimal" autoFocus
          value={amount} onChange={(e) => setAmount(e.target.value)}
          placeholder="600.00"
        />
        <div className="hint">Leave empty to track spending without a target.</div>
      </div>

      <div className="field">
        <label>Count eating out toward the goal</label>
        <div className="segmented">
          <button aria-pressed={dining} onClick={() => setDining(true)}>Yes</button>
          <button aria-pressed={!dining} onClick={() => setDining(false)}>Groceries only</button>
        </div>
        <div className="hint">
          Either way it is still recorded and shown — this only decides whether it
          counts against the target.
        </div>
      </div>

      <button className="btn primary block" onClick={() => void save()}>
        {cents !== null && cents > 0 ? `Set ${formatMoney(cents, currency)} a month` : 'Save'}
      </button>
    </Sheet>
  );
}
