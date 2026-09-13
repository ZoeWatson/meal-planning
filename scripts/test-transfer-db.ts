/**
 * Transfer round-trip tests, against a real database.
 *
 * `test-transfer.ts` covers the file's shape. This covers what happens when one
 * is actually applied, which is where data is lost rather than merely rejected:
 * whether a record survives a trip through a file, whether an old file can walk
 * back over a newer edit, and whether a deletion propagates or quietly comes back
 * to life on the next exchange.
 *
 * IndexedDB is faked rather than mocked. The alternative is asserting against a
 * stub of Dexie, which proves the test's idea of Dexie behaves as expected and
 * nothing at all about the code that ships.
 *
 * Run with: npm run test:transfer-db
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

import { webcrypto } from 'node:crypto';

/**
 * Two browser globals this code takes for granted and Node 18 does not provide:
 * `crypto`, which the clock uses to generate a device id, and `CustomEvent`,
 * which Dexie fires when a database closes. Both exist in every browser and in
 * Node 20, so this is a shim for the version the toolchain is currently pinned
 * to rather than a gap in the code under test — delete it when that moves.
 *
 * Worth shimming rather than mocking around: a test that stubbed `generateNodeId`
 * would stop exercising the tie-breaker that makes two devices' stamps comparable
 * at all, which is precisely what these tests are for.
 */
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto as never;
}
if (typeof globalThis.CustomEvent === 'undefined') {
  // Typed structurally rather than as `CustomEventInit`, which is a DOM type.
  // `tsconfig.scripts.json` keeps the DOM libs out on purpose, so that everything
  // else compiled here is held to the Node globals it will actually have.
  globalThis.CustomEvent = class extends Event {
    readonly detail: unknown;
    constructor(type: string, options?: { detail?: unknown }) {
      super(type);
      this.detail = options?.detail;
    }
  } as never;
}

import { db } from '../src/db/database';
import {
  applyChanges, collectChanges, getSyncMeta, syncedDelete, syncedPut,
} from '../src/db/syncWrites';
import { buildTransferFile, parseTransferFile } from '../src/domain/sync/transferFile';
import { format } from '../src/domain/sync/hlc';
import type { Change } from '../src/domain/sync/types';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fresh();
  try {
    await fn();
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

/** A database with nothing in it, so no test can be carried by another's leftovers. */
async function fresh(): Promise<void> {
  await db.delete();
  await db.open();
}

/**
 * The file as it really travels: serialised, parsed, and validated on the way in.
 *
 * Passing the in-memory changes straight to `applyChanges` would skip exactly the
 * step most likely to lose something — JSON has no `undefined`, and a field that
 * survives in memory can vanish on the round trip.
 */
async function throughFile(changes: readonly Change[]): Promise<readonly Change[]> {
  const meta = await getSyncMeta();
  return parseTransferFile(JSON.stringify(buildTransferFile(changes, meta.deviceId))).changes;
}

/** A stamp from "the other device", positioned relative to a known one. */
function stampAt(physical: number, nodeId = 'ffff0000'): string {
  return format({ physical, counter: 0, nodeId });
}

// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  group('Round trip through a file');

  await test('a record survives export, a wipe, and import', async () => {
    await syncedPut('staples', { ingredientId: 'olive-oil', active: true });
    const exported = await throughFile(await collectChanges());

    await fresh();
    assert.equal(await db.staples.count(), 0, 'the wipe did not work');

    await applyChanges(exported);

    assert.deepEqual(await db.staples.get('olive-oil'), { ingredientId: 'olive-oil', active: true });
  });

  await test('the built-in library is left out of the file', async () => {
    // Seeded rows are written straight to the table and never stamped, which is
    // what marks them as shipped-with-the-app rather than user data.
    await db.recipes.bulkPut([{ id: 'seeded', name: 'Shipped', builtIn: true } as never]);
    await syncedPut('recipes', { id: 'mine', name: 'Added by hand', builtIn: false });

    const ids = (await collectChanges()).filter((c) => c.collection === 'recipes').map((c) => c.id);

    assert.deepEqual(ids, ['mine']);
  });

  await test('an export does not queue anything for a server', async () => {
    // Exporting is not joining a space. Queueing here would mean a device that
    // later links to a server pushes a backlog it already handed over by hand.
    await syncedPut('staples', { ingredientId: 'rice', active: true });
    const before = await db.outbox.count();

    await collectChanges();

    assert.equal(await db.outbox.count(), before);
  });

  await test('exporting twice produces the same file', async () => {
    // The stamps are the file's identity. If a second export re-stamped records,
    // every file would beat the last one regardless of what actually changed.
    await syncedPut('staples', { ingredientId: 'rice', active: true });

    const first = await collectChanges();
    const second = await collectChanges();

    assert.deepEqual(first, second);
  });

  group('Merging');

  await test('a newer incoming record wins', async () => {
    await syncedPut('staples', { ingredientId: 'rice', active: true });
    const local = (await collectChanges()).find((c) => c.collection === 'staples')!;

    const { applied } = await applyChanges(await throughFile([{
      collection: 'staples',
      id: 'rice',
      hlc: stampAt(Number(local.hlc.slice(0, 15)) + 1000),
      data: { ingredientId: 'rice', active: false },
    }]));

    assert.equal(applied, 1);
    assert.equal((await db.staples.get('rice'))?.active, false);
  });

  await test('an older incoming record is ignored', async () => {
    // The case this whole scheme exists to survive: importing last week's file
    // on the device that has this week's edits.
    await syncedPut('staples', { ingredientId: 'rice', active: true });
    const local = (await collectChanges()).find((c) => c.collection === 'staples')!;

    const { applied, skipped } = await applyChanges(await throughFile([{
      collection: 'staples',
      id: 'rice',
      hlc: stampAt(Number(local.hlc.slice(0, 15)) - 1000),
      data: { ingredientId: 'rice', active: false },
    }]));

    assert.equal(applied, 0);
    assert.equal(skipped, 1);
    assert.equal((await db.staples.get('rice'))?.active, true, 'an old file overwrote a newer edit');
  });

  await test('a deletion travels rather than being undone', async () => {
    await syncedPut('staples', { ingredientId: 'rice', active: true });
    const created = await throughFile(await collectChanges());

    await syncedDelete('staples', 'rice');
    const afterDelete = await throughFile(await collectChanges());

    // Rebuilt rather than re-created by hand: the far device holds the record as
    // it was *before* the deletion, which is the only arrangement that tests the
    // tombstone. A device that re-added it afterwards should keep it, and would.
    await fresh();
    await applyChanges(created);
    assert.ok(await db.staples.get('rice'), 'the far device never had the staple');

    await applyChanges(afterDelete);

    assert.equal(await db.staples.get('rice'), undefined, 'the deleted staple came back');
  });

  await test('a record re-added after a deletion is kept', async () => {
    // The other side of the same coin, and the reason the test above has to be
    // built the way it is: a tombstone must not outrank a later decision to add
    // the thing back.
    await syncedPut('staples', { ingredientId: 'rice', active: true });
    await syncedDelete('staples', 'rice');
    const tombstone = await throughFile(await collectChanges());

    await syncedPut('staples', { ingredientId: 'rice', active: true });
    await applyChanges(tombstone);

    assert.ok(await db.staples.get('rice'), 'a stale tombstone deleted a newer record');
  });

  group('Settings merge per field');

  await test('two devices changing different settings keep both', async () => {
    await syncedPut('settings', { id: 'settings', regionId: 'bc-canada', cycleDays: 7 }, ['regionId', 'cycleDays']);
    const local = (await collectChanges()).find((c) => c.collection === 'settings')!;
    const newer = stampAt(Number(local.hlc.slice(0, 15)) + 1000);

    // The other device changed only the shopping cycle, and is otherwise working
    // from an older copy of the row.
    await applyChanges(await throughFile([{
      collection: 'settings',
      id: 'settings',
      hlc: newer,
      data: {
        id: 'settings',
        regionId: 'somewhere-else',
        cycleDays: 14,
        __fieldHlc: { cycleDays: newer },
      },
    }]));

    const settings = await db.settings.get('settings');
    assert.equal(settings?.cycleDays, 14, 'the field the other device changed did not arrive');
    assert.equal(settings?.regionId, 'bc-canada', 'a field nobody changed was overwritten');
  });

  await test('an older settings file cannot walk a field backwards', async () => {
    await syncedPut('settings', { id: 'settings', cycleDays: 14 }, ['cycleDays']);
    const local = (await collectChanges()).find((c) => c.collection === 'settings')!;

    await applyChanges(await throughFile([{
      collection: 'settings',
      id: 'settings',
      hlc: stampAt(Number(local.hlc.slice(0, 15)) - 1000),
      data: {
        id: 'settings',
        cycleDays: 7,
        __fieldHlc: { cycleDays: stampAt(Number(local.hlc.slice(0, 15)) - 1000) },
      },
    }]));

    assert.equal((await db.settings.get('settings'))?.cycleDays, 14);
  });

  await test('the settings row keeps the later stamp after an older merge', async () => {
    // Taking the incoming stamp blindly would walk the row's clock backwards, and
    // the next local write would then lose to changes it genuinely came after.
    await syncedPut('settings', { id: 'settings', cycleDays: 14 }, ['cycleDays']);
    const before = (await collectChanges()).find((c) => c.collection === 'settings')!.hlc;

    await applyChanges(await throughFile([{
      collection: 'settings',
      id: 'settings',
      hlc: stampAt(Number(before.slice(0, 15)) - 1000),
      data: { id: 'settings', cycleDays: 7, __fieldHlc: {} },
    }]));

    const after = (await collectChanges()).find((c) => c.collection === 'settings')!.hlc;
    assert.equal(after, before);
  });

  group('Applying is safe to repeat');

  await test('importing the same file twice changes nothing the second time', async () => {
    // People will do this. It should be boring rather than destructive.
    await syncedPut('staples', { ingredientId: 'rice', active: true });
    const exported = await throughFile(await collectChanges());

    await fresh();
    await applyChanges(exported);
    const first = await db.staples.toArray();

    await applyChanges(exported);

    assert.deepEqual(await db.staples.toArray(), first);
  });

  // -------------------------------------------------------------------------

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

void run();
