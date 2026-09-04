/**
 * Sync logic tests.
 *
 * These cover the pure parts — clocks and merge rules — because that is where a
 * bug silently loses data rather than throwing. "It seemed to work when I tried
 * it on two devices" is not adequate confidence for code whose failure mode is a
 * shopping list quietly reverting.
 *
 * Run with: npm run test:sync
 */

import assert from 'node:assert/strict';

import { compare, createClock, format, parse, receive, tick } from '../src/domain/sync/hlc';
import { collapse, mergeChange, mergeSettings, pruneSupersededOutbox } from '../src/domain/sync/merge';
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

function change(id: string, hlc: string, extra: Partial<Change> = {}): Change {
  return { collection: 'checks', id, hlc, data: { id }, ...extra };
}

// ---------------------------------------------------------------------------

group('Hybrid logical clock');

test('advances with physical time', () => {
  const a = createClock('aaaa', 1000);
  const b = tick(a, 2000);
  assert.equal(b.physical, 2000);
  assert.equal(b.counter, 0);
});

test('counter carries within the same millisecond', () => {
  let clock = createClock('aaaa', 1000);
  clock = tick(clock, 1000);
  clock = tick(clock, 1000);
  assert.equal(clock.counter, 2);
});

test('survives the clock going backwards', () => {
  // A laptop resuming from sleep, or an NTP correction. Timestamps must still
  // increase or last-write-wins starts choosing the wrong write.
  let clock = createClock('aaaa', 5000);
  const before = format(clock);
  clock = tick(clock, 3000);
  assert.ok(compare(format(clock), before) > 0, 'must still move forward');
});

test('serialised order is causal order', () => {
  const a = format({ physical: 1000, counter: 0, nodeId: 'aaaa' });
  const b = format({ physical: 1000, counter: 1, nodeId: 'aaaa' });
  const c = format({ physical: 1001, counter: 0, nodeId: 'aaaa' });
  assert.ok(compare(a, b) < 0);
  assert.ok(compare(b, c) < 0);
  assert.ok(compare(a, c) < 0);
});

test('round-trips through parse', () => {
  const original = { physical: 1_700_000_000_000, counter: 42, nodeId: 'beef1234' };
  assert.deepEqual(parse(format(original)), original);
});

test('a device with a slow clock still wins after seeing a remote write', () => {
  // The headline reason this is not plain wall-clock LWW. The phone is an hour
  // behind the laptop; it must still be able to make a write that beats one it
  // has already seen, or the laptop wins every conflict forever.
  const laptopStamp = format({ physical: 5_000_000, counter: 0, nodeId: 'laptop00' });

  let phone = createClock('phone000', 1_400_000);
  phone = receive(phone, parse(laptopStamp), 1_400_000);
  phone = tick(phone, 1_400_001);

  assert.ok(
    compare(format(phone), laptopStamp) > 0,
    `phone ${format(phone)} should beat laptop ${laptopStamp}`,
  );
});

test('a wildly wrong remote clock cannot poison this device forever', () => {
  const absurd = format({ physical: Date.now() + 400 * 24 * 3600_000, counter: 0, nodeId: 'broken00' });
  const now = Date.now();
  const clock = receive(createClock('aaaa', now), parse(absurd), now);
  assert.ok(
    clock.physical <= now + 24 * 3600_000 + 1,
    'drift should be capped at a day, not adopted wholesale',
  );
});

test('node id breaks ties deterministically', () => {
  const a = format({ physical: 1000, counter: 0, nodeId: 'aaaa' });
  const b = format({ physical: 1000, counter: 0, nodeId: 'bbbb' });
  assert.ok(compare(a, b) < 0);
  assert.ok(compare(b, a) > 0);
});

// ---------------------------------------------------------------------------

group('Merge rules');

test('newer remote wins', () => {
  assert.equal(mergeChange(change('x', 'B'), 'A').action, 'apply');
});

test('older remote loses', () => {
  const result = mergeChange(change('x', 'A'), 'B');
  assert.equal(result.action, 'skip');
  assert.equal(result.action === 'skip' && result.reason, 'local-newer');
});

test('identical is skipped, not reapplied', () => {
  const result = mergeChange(change('x', 'A'), 'A');
  assert.equal(result.action, 'skip');
  assert.equal(result.action === 'skip' && result.reason, 'identical');
});

test('unseen record always applies', () => {
  assert.equal(mergeChange(change('x', 'A'), undefined).action, 'apply');
});

test('a tombstone for an unseen record applies', () => {
  // The resurrection bug: device A deletes a staple while B is offline. B must
  // accept the tombstone even though it has no local stamp to compare against.
  assert.equal(mergeChange(change('x', 'A', { deleted: true }), undefined).action, 'apply');
});

test('an old tombstone does not undo a newer edit', () => {
  assert.equal(mergeChange(change('x', 'A', { deleted: true }), 'B').action, 'skip');
});

// ---------------------------------------------------------------------------

group('Collapsing');

test('keeps only the latest per record', () => {
  const result = collapse([change('x', 'A'), change('x', 'C'), change('x', 'B')]);
  assert.equal(result.length, 1);
  assert.equal(result[0].hlc, 'C');
});

test('different records are all kept', () => {
  assert.equal(collapse([change('x', 'A'), change('y', 'B')]).length, 2);
});

test('same id in different collections is not conflated', () => {
  const result = collapse([
    { collection: 'checks', id: 'shared', hlc: 'A' },
    { collection: 'staples', id: 'shared', hlc: 'B' },
  ]);
  assert.equal(result.length, 2, 'collection is part of identity');
});

test('output is ordered', () => {
  const result = collapse([change('z', 'C'), change('x', 'A'), change('y', 'B')]);
  assert.deepEqual(result.map((c) => c.hlc), ['A', 'B', 'C']);
});

// ---------------------------------------------------------------------------

group('Outbox reconciliation');

test('a stale queued change is dropped', () => {
  // The important case: this device edited offline, the server already has a
  // newer edit of the same record. Pushing ours would clobber theirs.
  const { keep, dropped } = pruneSupersededOutbox([change('x', 'A')], [change('x', 'B')]);
  assert.equal(keep.length, 0);
  assert.equal(dropped.length, 1);
});

test('a newer queued change is kept', () => {
  const { keep, dropped } = pruneSupersededOutbox([change('x', 'C')], [change('x', 'B')]);
  assert.equal(keep.length, 1);
  assert.equal(dropped.length, 0);
});

test('unrelated queued changes are untouched', () => {
  const { keep } = pruneSupersededOutbox([change('x', 'A')], [change('y', 'Z')]);
  assert.equal(keep.length, 1);
});

test('equal stamps keep the local entry', () => {
  // Re-pushing something the server already has is harmless under LWW; dropping
  // a change that was never actually acknowledged is permanent.
  const { keep } = pruneSupersededOutbox([change('x', 'B')], [change('x', 'B')]);
  assert.equal(keep.length, 1);
});

// ---------------------------------------------------------------------------

group('Settings field merge');

test('concurrent edits to different fields both survive', () => {
  // Row-level LWW would discard one of these. Settings is a single row holding
  // unrelated preferences, so that is a real and very annoying data loss.
  const { merged } = mergeSettings(
    { regionId: 'bc-canada', unitSystem: 'imperial' },
    { regionId: 'on-canada', unitSystem: 'metric' },
    { regionId: 'A', unitSystem: 'C' },
    { regionId: 'B', unitSystem: 'A' },
  );
  assert.equal(merged.regionId, 'on-canada', 'remote region is newer');
  assert.equal(merged.unitSystem, 'imperial', 'local unit system is newer');
});

test('an unstamped remote field does not overwrite a local value', () => {
  const { merged } = mergeSettings(
    { regionId: 'bc-canada' }, { regionId: 'on-canada' },
    { regionId: 'A' }, undefined,
  );
  assert.equal(merged.regionId, 'bc-canada');
});

test('a field absent locally is taken from remote', () => {
  const { merged } = mergeSettings({}, { cycleDays: 5 }, {}, undefined);
  assert.equal(merged.cycleDays, 5);
});

test('field stamps advance with the winning value', () => {
  const { fieldHlc } = mergeSettings(
    { regionId: 'a' }, { regionId: 'b' }, { regionId: 'A' }, { regionId: 'B' },
  );
  assert.equal(fieldHlc.regionId, 'B');
});

// ---------------------------------------------------------------------------

group('Convergence');

test('two devices reach the same state regardless of sync order', () => {
  // The property that matters: whatever order changes arrive in, both devices
  // must end up identical. Anything else is a bug you find weeks later.
  const changes = [
    change('a', format({ physical: 100, counter: 0, nodeId: 'aaaa' })),
    change('a', format({ physical: 200, counter: 0, nodeId: 'bbbb' })),
    change('b', format({ physical: 150, counter: 0, nodeId: 'aaaa' })),
    change('a', format({ physical: 150, counter: 3, nodeId: 'cccc' })),
  ];

  const apply = (order: Change[]): Record<string, string> => {
    const state: Record<string, string> = {};
    for (const c of order) {
      if (mergeChange(c, state[c.id]).action === 'apply') state[c.id] = c.hlc;
    }
    return state;
  };

  const forwards = apply([...changes]);
  const backwards = apply([...changes].reverse());
  const shuffled = apply([changes[2], changes[0], changes[3], changes[1]]);

  assert.deepEqual(forwards, backwards);
  assert.deepEqual(forwards, shuffled);
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
