/**
 * Budget logic tests.
 *
 * Money parsing and month arithmetic are both areas where the code looks obviously
 * correct and quietly is not — off-by-one days, timezone-shifted dates, and
 * decimal separators all fail silently and produce a total that is merely a bit
 * wrong, which is the hardest kind of wrong to notice.
 *
 * Run with: npm run test:budget
 */

import assert from 'node:assert/strict';

import {
  addMonths, daysInMonth, formatMoney, monthKey, monthKeyOf, monthlyTotals,
  parseMoney, summariseMonth, todayISO, verdict, type Expense,
} from '../src/domain/budget';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`\x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

function group(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function expense(dateISO: string, amountCents: number, kind: Expense['kind'] = 'groceries'): Expense {
  return {
    id: `${dateISO}-${amountCents}`, kind, dateISO, amountCents,
    label: 'test', createdAtISO: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------

group('Money parsing');

test('plain decimal', () => assert.equal(parseMoney('12.34'), 1234));
test('whole number', () => assert.equal(parseMoney('12'), 1200));
test('currency symbol is ignored', () => assert.equal(parseMoney('$12.34'), 1234));
test('surrounding whitespace', () => assert.equal(parseMoney('  42.50  '), 4250));
test('thousands separator', () => assert.equal(parseMoney('1,234.56'), 123456));
test('comma as decimal separator', () => assert.equal(parseMoney('12,34'), 1234));
test('european form', () => assert.equal(parseMoney('1.234,56'), 123456));
test('single decimal place', () => assert.equal(parseMoney('12.5'), 1250));

test('rounds rather than truncating', () => {
  // Truncation would bias every total downward, a cent at a time.
  assert.equal(parseMoney('10.999'), 1100);
  assert.equal(parseMoney('10.994'), 1099);
});

test('rejects what it cannot read', () => {
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('   '), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('-'), null);
});

test('no floating point drift when summing', () => {
  // The whole reason for integer cents: this is 0.30000000000000004 in floats.
  const total = parseMoney('0.10')! + parseMoney('0.20')!;
  assert.equal(total, 30);
  assert.equal(formatMoney(total, 'CAD', 'en-CA'), '$0.30');
});

test('a hundred prices sum exactly', () => {
  let total = 0;
  for (let i = 0; i < 100; i++) total += parseMoney('1.15')!;
  assert.equal(total, 11500, 'must be exactly $115.00');
});

// ---------------------------------------------------------------------------

group('Month arithmetic');

test('month key is local, not UTC', () => {
  // `toISOString` on a late-evening local date rolls into the next day in any
  // timezone behind UTC, which silently files a shop under the wrong month.
  const lateOnLastDay = new Date(2025, 0, 31, 23, 30);
  assert.equal(monthKey(lateOnLastDay), '2025-01');
  assert.equal(todayISO(lateOnLastDay), '2025-01-31');
});

test('rolls forward over a year boundary', () => {
  assert.equal(addMonths('2024-12', 1), '2025-01');
});

test('rolls backward over a year boundary', () => {
  assert.equal(addMonths('2025-01', -1), '2024-12');
});

test('day counts including leap years', () => {
  assert.equal(daysInMonth('2025-02'), 28);
  assert.equal(daysInMonth('2024-02'), 29);
  assert.equal(daysInMonth('2025-01'), 31);
  assert.equal(daysInMonth('2025-04'), 30);
});

test('extracts the month from a date', () => {
  assert.equal(monthKeyOf('2025-09-14'), '2025-09');
});

// ---------------------------------------------------------------------------

group('Month summary');

const NOW = new Date(2025, 8, 10, 12, 0); // 10 September 2025, a third through

test('totals and splits by kind', () => {
  const summary = summariseMonth([
    expense('2025-09-02', 8500),
    expense('2025-09-06', 4200, 'dining'),
    expense('2025-09-09', 6300),
    expense('2025-08-30', 9900), // previous month, must not count
  ], '2025-09', 40000, NOW);

  assert.equal(summary.totalCents, 19000);
  assert.equal(summary.byKind.groceries, 14800);
  assert.equal(summary.byKind.dining, 4200);
  assert.equal(summary.expenseCount, 3);
});

test('progress against the goal', () => {
  const summary = summariseMonth([expense('2025-09-02', 20000)], '2025-09', 40000, NOW);
  assert.equal(summary.fractionOfGoal, 0.5);
});

test('projects the month-end total from current pace', () => {
  // $150 over 10 days of a 30-day month projects to $450.
  const summary = summariseMonth([expense('2025-09-05', 15000)], '2025-09', 40000, NOW);
  assert.equal(summary.projectedCents, 45000);
});

test('does not project from a partial first week', () => {
  // Food spending is lumpy at weekly cadence. On the 3rd, a single $150 shop
  // extrapolates to $1,500 — a confident, prominent, meaningless number.
  const early = new Date(2025, 8, 3, 12, 0);
  const summary = summariseMonth([expense('2025-09-02', 15000)], '2025-09', 40000, early);
  assert.equal(summary.projectedCents, null);
});

test('starts projecting once a full shopping cycle has passed', () => {
  const day7 = new Date(2025, 8, 7, 12, 0);
  const summary = summariseMonth([expense('2025-09-02', 7000)], '2025-09', 40000, day7);
  assert.equal(summary.projectedCents, 30000, '$70 over 7 days of 30 → $300');
});

test('no projection for a past month', () => {
  const summary = summariseMonth([expense('2025-07-05', 15000)], '2025-07', 40000, NOW);
  assert.equal(summary.projectedCents, null);
  assert.equal(summary.fractionOfMonth, 1, 'a finished month is fully elapsed');
});

test('daily allowance divides what is left by the days left', () => {
  // $400 goal, $190 spent, 20 days remaining of September.
  const summary = summariseMonth([expense('2025-09-02', 19000)], '2025-09', 40000, NOW);
  assert.equal(summary.dailyAllowanceCents, Math.round(21000 / 20));
});

test('daily allowance floors at zero when over budget', () => {
  const summary = summariseMonth([expense('2025-09-02', 50000)], '2025-09', 40000, NOW);
  assert.equal(summary.dailyAllowanceCents, 0, 'never suggests a negative daily spend');
});

test('handles no goal set', () => {
  const summary = summariseMonth([expense('2025-09-02', 5000)], '2025-09', null, NOW);
  assert.equal(summary.fractionOfGoal, null);
  assert.equal(summary.dailyAllowanceCents, null);
});

test('handles an empty month', () => {
  const summary = summariseMonth([], '2025-09', 40000, NOW);
  assert.equal(summary.totalCents, 0);
  assert.equal(summary.projectedCents, null, 'nothing to project from');
});

// ---------------------------------------------------------------------------

group('Verdict');

test('over budget', () => {
  assert.equal(verdict(summariseMonth([expense('2025-09-02', 45000)], '2025-09', 40000, NOW)), 'over-budget');
});

test('over pace warns before the budget is gone', () => {
  // A third through the month, two thirds of the budget spent. Still under, but
  // worth saying now rather than on the 30th.
  const summary = summariseMonth([expense('2025-09-02', 26000)], '2025-09', 40000, NOW);
  assert.equal(verdict(summary), 'over-pace');
});

test('on track', () => {
  const summary = summariseMonth([expense('2025-09-02', 13000)], '2025-09', 40000, NOW);
  assert.equal(verdict(summary), 'on-track');
});

test('ahead', () => {
  const summary = summariseMonth([expense('2025-09-02', 2000)], '2025-09', 40000, NOW);
  assert.equal(verdict(summary), 'ahead');
});

test('one weekly shop does not trigger a warning', () => {
  // Groceries arrive in lumps. A single shop early in the month must not read as
  // overspending, or the warning becomes noise and gets ignored.
  const summary = summariseMonth([expense('2025-09-08', 15000)], '2025-09', 40000, NOW);
  assert.notEqual(verdict(summary), 'over-pace');
});

test('no goal is reported as such', () => {
  assert.equal(verdict(summariseMonth([], '2025-09', null, NOW)), 'no-goal');
});

// ---------------------------------------------------------------------------

group('History');

test('returns a contiguous run of months, oldest first', () => {
  const totals = monthlyTotals([
    expense('2025-09-02', 1000),
    expense('2025-07-02', 3000),
  ], 4, NOW);

  assert.deepEqual(totals.map((t) => t.key), ['2025-06', '2025-07', '2025-08', '2025-09']);
  assert.deepEqual(totals.map((t) => t.totalCents), [0, 3000, 0, 1000]);
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
