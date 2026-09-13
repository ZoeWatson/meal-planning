/**
 * Spending and budgets.
 *
 * MONEY IS STORED AS INTEGER CENTS, everywhere, without exception.
 *
 * Floating point cannot represent most decimal amounts: `0.1 + 0.2` is
 * `0.30000000000000004`, and a month of grocery totals added as floats drifts by
 * cents that never reconcile against a bank statement. The bug is invisible in
 * testing — every individual number looks right — and only shows up as a total
 * that is inexplicably a penny off. Integers make it impossible rather than
 * unlikely.
 *
 * The rule: cents at rest and in every calculation; decimals only at the moment
 * of parsing user input and formatting for display.
 *
 * (The waste model in `waste.ts` uses floats for *estimated* prices, which is
 * fine — those are approximations of what something costs per kilo, never sums of
 * real transactions. This module deals in money that actually changed hands.)
 */

import type { Id } from './types';

export type ExpenseKind = 'groceries' | 'dining' | 'other';

export const EXPENSE_LABELS: Readonly<Record<ExpenseKind, string>> = {
  groceries: 'Groceries',
  dining: 'Eating out',
  other: 'Other food',
};

/** One thing that was actually paid for. */
export interface Expense {
  readonly id: Id;
  readonly kind: ExpenseKind;
  /** `YYYY-MM-DD`, local date of the spend — not of the data entry. */
  readonly dateISO: string;
  readonly amountCents: number;
  readonly label: string;
  /** Links a shop back to the week it was for, so plan vs. till can be compared. */
  readonly planId?: Id;
  readonly note?: string;
  readonly createdAtISO: string;
}

/** An item added by hand to a shopping list — not from any recipe. */
export interface CustomItem {
  readonly id: Id;
  readonly planId: Id;
  readonly label: string;
  /** Free text, e.g. "2 packs". Not parsed; this never enters the waste model. */
  readonly quantityText?: string;
  readonly category: string;
  readonly amountCents?: number;
  readonly checked: boolean;
  /**
   * Taken off this week's list, but not thrown away.
   *
   * Hidden rather than deleted so that the way back is the same one every other
   * line on the list has. An item added by hand is the one kind that could simply
   * be typed in again, and "press ✕, then retype it" is not an undo. Finishing
   * the shop clears these out along with the rest.
   */
  readonly removed?: boolean;
  /** Off the list because the cupboard has it. See `GroceryCheck.inStock`. */
  readonly inStock?: boolean;
  /** Set when the item came from a scan, so the next scan recognises it. */
  readonly barcode?: string;
  readonly updatedAtISO: string;
}

/**
 * What a barcode turned out to be, remembered locally.
 *
 * A barcode carries an identifier and nothing else — no name, and certainly no
 * price. Looking one up needs a product database and a network connection, and
 * this app has to work in a shop with neither. So it learns: tell it once what a
 * barcode is, and every later scan of that product fills itself in.
 */
export interface BarcodeEntry {
  readonly barcode: string;
  readonly label: string;
  readonly ingredientId?: Id;
  /** Last price paid, offered as the default next time. */
  readonly lastAmountCents?: number;
  readonly updatedAtISO: string;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Parses typed input into cents.
 *
 * Accepts what people actually type at a till: "12.34", "$12.34", "12,34",
 * "12", " 1 234.56 ". Returns null for anything it cannot read, rather than
 * guessing — a silently misread price becomes a wrong monthly total.
 */
export function parseMoney(input: string): number | null {
  const cleaned = input.trim().replace(/[^0-9.,-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;

  // A comma is a decimal separator in much of the world and a thousands separator
  // elsewhere. Treat it as decimal only when it is clearly in that position.
  const normalised = /,\d{1,2}$/.test(cleaned)
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/,/g, '');

  const value = Number(normalised);
  if (!Number.isFinite(value)) return null;

  // Rounded rather than truncated: "10.999" is nearer 11.00 than 10.99, and
  // truncation biases every total downward.
  return Math.round(value * 100);
}

export function formatMoney(cents: number, currency = 'CAD', locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/** Compact form for tight spaces: "$42" rather than "$41.87". */
export function formatMoneyShort(cents: number, currency = 'CAD', locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** Value for a `<input type="number">`, which needs a plain decimal. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

/** `YYYY-MM` for a date, in local time. */
export function monthKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function monthKeyOf(dateISO: string): string {
  return dateISO.slice(0, 7);
}

export function addMonths(key: string, delta: number): string {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return monthKey(date);
}

export function monthLabel(key: string, locale?: string): string {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(locale, {
    month: 'long',
    year: 'numeric',
  });
}

export function daysInMonth(key: string): number {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month, 0).getDate();
}

/** Local `YYYY-MM-DD`. `toISOString` would shift the date across a timezone. */
export function todayISO(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface MonthSummary {
  readonly monthKey: string;
  readonly totalCents: number;
  readonly byKind: Readonly<Record<ExpenseKind, number>>;
  readonly goalCents: number | null;
  /** 0..1+ of the goal spent. Above 1 means over. */
  readonly fractionOfGoal: number | null;
  /** 0..1 of the month elapsed. Only meaningful for the current month. */
  readonly fractionOfMonth: number;
  /**
   * Projected month-end total at the current rate.
   *
   * The useful number mid-month: "$310 spent" means nothing on the 8th without
   * knowing whether that is fast or slow. Null for past months, where the actual
   * total is already the answer, and null early in the month — see
   * `MIN_DAYS_FOR_PROJECTION`.
   */
  readonly projectedCents: number | null;
  /** Remaining budget divided by remaining days. Null without a goal. */
  readonly dailyAllowanceCents: number | null;
  readonly expenseCount: number;
}

const ZERO_BY_KIND: Readonly<Record<ExpenseKind, number>> = {
  groceries: 0, dining: 0, other: 0,
};

/**
 * Days that must have elapsed before a month-end projection is shown.
 *
 * Food spending is lumpy at weekly cadence — one shop, then several quiet days —
 * so extrapolating a partial week is not a forecast, it is an artefact of when
 * you happened to go shopping. Three days into a month, a single $150 shop
 * projects to $1,500 and the number is worse than useless: it is prominent,
 * confident, and wrong, and it appears exactly when there is least reason to
 * trust it.
 *
 * A full shopping cycle is the shortest span that contains a representative mix
 * of shop days and quiet days. Before that, the honest display is nothing.
 */
export const MIN_DAYS_FOR_PROJECTION = 7;

export function summariseMonth(
  expenses: readonly Expense[],
  key: string,
  goalCents: number | null,
  now: Date = new Date(),
): MonthSummary {
  const inMonth = expenses.filter((e) => monthKeyOf(e.dateISO) === key);

  const byKind = { ...ZERO_BY_KIND };
  let totalCents = 0;
  for (const expense of inMonth) {
    byKind[expense.kind] += expense.amountCents;
    totalCents += expense.amountCents;
  }

  const days = daysInMonth(key);
  const isCurrent = key === monthKey(now);
  const isPast = key < monthKey(now);

  // A finished month is fully elapsed; a future one has not started.
  const elapsedDays = isCurrent ? now.getDate() : isPast ? days : 0;
  const fractionOfMonth = elapsedDays / days;

  const projectedCents = isCurrent && elapsedDays >= MIN_DAYS_FOR_PROJECTION && totalCents > 0
    ? Math.round((totalCents / elapsedDays) * days)
    : null;

  const remainingDays = Math.max(1, days - elapsedDays);
  const dailyAllowanceCents = goalCents !== null && isCurrent
    ? Math.round(Math.max(0, goalCents - totalCents) / remainingDays)
    : null;

  return {
    monthKey: key,
    totalCents,
    byKind,
    goalCents,
    fractionOfGoal: goalCents && goalCents > 0 ? totalCents / goalCents : null,
    fractionOfMonth,
    projectedCents,
    dailyAllowanceCents,
    expenseCount: inMonth.length,
  };
}

export type BudgetVerdict = 'no-goal' | 'on-track' | 'ahead' | 'over-pace' | 'over-budget';

/**
 * Turns the numbers into the one thing a person actually wants to know.
 *
 * Note `over-pace` is separate from `over-budget`: spending faster than the month
 * is passing is worth flagging on the 10th, while there is still time to act. A
 * tracker that only tells you once you have blown the budget has told you too late
 * to be useful.
 */
export function verdict(summary: MonthSummary): BudgetVerdict {
  if (summary.goalCents === null || summary.goalCents <= 0) return 'no-goal';
  if (summary.fractionOfGoal !== null && summary.fractionOfGoal > 1) return 'over-budget';

  // Groceries come in large weekly lumps, so a strict pace comparison would cry
  // wolf every time you shop. The 10% margin absorbs one shop's worth of lumpiness.
  const pace = summary.fractionOfGoal ?? 0;
  if (pace > summary.fractionOfMonth + 0.1) return 'over-pace';
  if (pace < summary.fractionOfMonth - 0.1) return 'ahead';
  return 'on-track';
}

export const VERDICT_TEXT: Readonly<Record<BudgetVerdict, string>> = {
  'no-goal': 'Set a monthly goal to track progress.',
  'on-track': 'On track for the month.',
  ahead: 'Running under budget.',
  'over-pace': 'Spending faster than the month is passing.',
  'over-budget': 'Over budget for this month.',
};

/** Rolling history for the trend chart, newest last. */
export function monthlyTotals(
  expenses: readonly Expense[],
  months: number,
  now: Date = new Date(),
): Array<{ key: string; totalCents: number }> {
  const current = monthKey(now);
  const out: Array<{ key: string; totalCents: number }> = [];

  for (let i = months - 1; i >= 0; i--) {
    const key = addMonths(current, -i);
    const total = expenses
      .filter((e) => monthKeyOf(e.dateISO) === key)
      .reduce((sum, e) => sum + e.amountCents, 0);
    out.push({ key, totalCents: total });
  }

  return out;
}

/**
 * Compares what a shop was estimated to cost against what it actually cost.
 *
 * The estimates come from per-kilo figures that are guesses; this is the only
 * signal available for how wrong they are, and a persistent gap in one direction
 * means the seed prices need revisiting.
 */
export function estimateAccuracy(
  estimatedCents: number,
  actualCents: number,
): { differenceCents: number; ratio: number } {
  return {
    differenceCents: actualCents - estimatedCents,
    ratio: estimatedCents > 0 ? actualCents / estimatedCents : 1,
  };
}
