/**
 * Transfer file tests.
 *
 * The file is the only thing moving data between two devices now, so a bug here
 * is not a broken screen — it is a week of plans that quietly did not arrive, or
 * worse, a malformed file half-applied into a database with no server copy to
 * re-pull from. Validation is tested harder than the happy path for that reason.
 *
 * Run with: npm run test:transfer
 */

import assert from 'node:assert/strict';

import {
  TRANSFER_FORMAT, TRANSFER_VERSION, TransferFileError,
  buildTransferFile, parseTransferFile, summarizeChanges,
} from '../src/domain/sync/transferFile';
import { format } from '../src/domain/sync/hlc';
import type { Change } from '../src/domain/sync/types';

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

const STAMP = format({ physical: 1_700_000_000_000, counter: 0, nodeId: 'abcd1234' });

function change(over: Partial<Change> = {}): Change {
  return { collection: 'checks', id: 'plan-1:tomato', hlc: STAMP, data: { id: 'plan-1:tomato' }, ...over };
}

/** The file as it actually travels — serialised, not the object in memory. */
function roundTrip(changes: readonly Change[]): ReturnType<typeof parseTransferFile> {
  return parseTransferFile(JSON.stringify(buildTransferFile(changes, 'abcd1234')));
}

// ---------------------------------------------------------------------------

group('Round trip');

test('survives being written and read back', () => {
  const changes = [change(), change({ id: 'plan-1:onion' })];
  const file = roundTrip(changes);

  assert.equal(file.format, TRANSFER_FORMAT);
  assert.equal(file.version, TRANSFER_VERSION);
  assert.equal(file.deviceId, 'abcd1234');
  assert.deepEqual(file.changes, changes);
});

test('carries tombstones without inventing a payload', () => {
  const file = roundTrip([change({ deleted: true, data: undefined })]);
  assert.equal(file.changes[0].deleted, true);
  assert.equal(file.changes[0].data, undefined);
});

test('keeps the settings field stamps that make per-field merge possible', () => {
  // Losing `__fieldHlc` in transit would not fail — it would silently downgrade
  // settings to row-level last-write-wins on the far side, which is exactly the
  // "my region keeps reverting" bug the per-field stamps exist to prevent.
  const fieldHlc = { regionId: STAMP };
  const file = roundTrip([
    change({ collection: 'settings', id: 'settings', data: { id: 'settings', regionId: 'bc-canada', __fieldHlc: fieldHlc } }),
  ]);

  assert.deepEqual((file.changes[0].data as Record<string, unknown>).__fieldHlc, fieldHlc);
});

test('an empty export is a valid file, not an error', () => {
  // A fresh device has nothing but settings, and exporting from it should produce
  // something importable rather than something that fails on the other end.
  assert.equal(roundTrip([]).changes.length, 0);
});

// ---------------------------------------------------------------------------

group('Refusing bad files');

function refuses(name: string, source: string, expected: RegExp): void {
  test(name, () => {
    assert.throws(() => parseTransferFile(source), (err: unknown) => {
      assert.ok(err instanceof TransferFileError, `threw ${String(err)}, not a TransferFileError`);
      assert.match(err.message, expected);
      return true;
    });
  });
}

refuses('not JSON at all', 'this is not json', /not valid JSON/);
refuses('a bare array', '[]', /not a transfer file/);
refuses('JSON that is not an object', '"hello"', /not a transfer file/);
refuses('a file with no format marker', '{"changes":[]}', /not a transfer file/);

refuses(
  'the recipe library, which is the obvious wrong file to reach for',
  JSON.stringify({ recipes: [], ingredients: [] }),
  /recipe library export/,
);

refuses(
  'a file from a newer app version',
  JSON.stringify({ format: TRANSFER_FORMAT, version: TRANSFER_VERSION + 1, changes: [] }),
  /newer version/,
);

refuses(
  'changes that are not an array',
  JSON.stringify({ format: TRANSFER_FORMAT, version: 1, changes: 'lots' }),
  /no changes in it/,
);

function refusesChange(name: string, entry: unknown, expected: RegExp): void {
  refuses(name, JSON.stringify({ format: TRANSFER_FORMAT, version: 1, changes: [entry] }), expected);
}

refusesChange('a change naming a collection this app does not have',
  { ...change(), collection: 'nonsense' }, /does not have/);
refusesChange('a change with no id',
  { ...change(), id: '' }, /no id/);
refusesChange('a change with no timestamp',
  { collection: 'checks', id: 'x', data: {} }, /no timestamp/);
refusesChange('a change whose timestamp will not parse',
  { ...change(), hlc: 'not-a-stamp' }, /malformed timestamp/);
refusesChange('a write with no data, which would blank the record',
  { collection: 'checks', id: 'x', hlc: STAMP }, /missing its data/);
refusesChange('a change that is not an object at all',
  'nonsense', /not an object/);

test('names which entry is wrong, not just that one is', () => {
  // The person reading this error has a multi-megabyte file and no other clue.
  const changes = [change(), change(), { ...change(), hlc: 'broken' }];
  assert.throws(
    () => parseTransferFile(JSON.stringify({ format: TRANSFER_FORMAT, version: 1, changes })),
    /Change 3/,
  );
});

test('refuses the whole file rather than the bad entry', () => {
  // Applying the good half of a file and reporting success would leave the two
  // devices disagreeing with nothing to show it happened.
  const changes = [change(), { ...change(), collection: 'nope' }];
  assert.throws(() => parseTransferFile(JSON.stringify({ format: TRANSFER_FORMAT, version: 1, changes })));
});

// ---------------------------------------------------------------------------

group('Summary');

test('counts writes and deletes apart', () => {
  const summary = summarizeChanges([
    change({ collection: 'plans', id: 'p1' }),
    change({ collection: 'checks', id: 'c1' }),
    change({ collection: 'checks', id: 'c2', deleted: true, data: undefined }),
  ]);

  assert.deepEqual(summary, [
    { collection: 'plans', writes: 1, deletes: 0 },
    { collection: 'checks', writes: 1, deletes: 1 },
  ]);
});

test('orders by the canonical collection list, not by count', () => {
  // So the same file reads the same way down the screen every time.
  const summary = summarizeChanges([
    change({ collection: 'mealLog', id: 'm' }),
    change({ collection: 'settings', id: 's' }),
    change({ collection: 'plans', id: 'p' }),
  ]);

  assert.deepEqual(summary.map((s) => s.collection), ['settings', 'plans', 'mealLog']);
});

test('leaves out collections with nothing in them', () => {
  assert.equal(summarizeChanges([change()]).length, 1);
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
