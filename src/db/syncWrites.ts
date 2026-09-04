/**
 * The single choke point for every syncable write.
 *
 * A write has to do three things atomically: change the record, stamp it with an
 * HLC, and queue it for push. If those come apart — and they will, if each caller
 * does it by hand — you get records that exist locally but never sync, or outbox
 * entries for records that were rolled back. Both are invisible until two devices
 * disagree and neither is debuggable after the fact.
 *
 * So the repository never touches a synced table directly; it goes through here.
 */

import { db, type OutboxEntry, type RecordMeta, type SyncMeta } from './database';
import { createClock, format, generateNodeId, receive, tick, type Hlc } from '../domain/sync/hlc';
import { isSyncable } from '../domain/sync/merge';
import { SYNCED_COLLECTIONS, type Change, type SyncedCollection } from '../domain/sync/types';

/** Primary key field per collection, since they are not all called `id`. */
const KEY_FIELD: Readonly<Record<SyncedCollection, string>> = {
  settings: 'id',
  plans: 'id',
  checks: 'id',
  staples: 'ingredientId',
  pantry: 'ingredientId',
  sales: 'ingredientId',
  carryOver: 'ingredientId',
  recipes: 'id',
  ingredients: 'id',
  expenses: 'id',
  customItems: 'id',
  barcodes: 'barcode',
};

export function idOf(collection: SyncedCollection, record: Record<string, unknown>): string {
  return String(record[KEY_FIELD[collection]]);
}

function metaKey(collection: SyncedCollection, id: string): string {
  return `${collection}:${id}`;
}

// ---------------------------------------------------------------------------
// Device clock
// ---------------------------------------------------------------------------

const DEFAULT_SYNC_META: Omit<SyncMeta, 'deviceId' | 'hlcPhysical'> = {
  id: 'sync',
  hlcCounter: 0,
  spaceId: null,
  serverUrl: null,
  lastPulledSeq: 0,
  lastSyncedAtISO: null,
  lastError: null,
};

export async function getSyncMeta(): Promise<SyncMeta> {
  const existing = await db.syncMeta.get('sync');
  if (existing) return existing;

  const fresh: SyncMeta = {
    ...DEFAULT_SYNC_META,
    deviceId: generateNodeId(),
    hlcPhysical: Date.now(),
  };
  await db.syncMeta.put(fresh);
  return fresh;
}

export async function updateSyncMeta(patch: Partial<SyncMeta>): Promise<SyncMeta> {
  const current = await getSyncMeta();
  const next = { ...current, ...patch, id: 'sync' as const };
  await db.syncMeta.put(next);
  return next;
}

/**
 * Issues the next timestamp for a local write.
 *
 * Persisted on every tick so the counter survives a reload; without that, two
 * writes either side of a refresh in the same millisecond would collide.
 */
async function nextStamp(): Promise<string> {
  const meta = await getSyncMeta();
  const advanced = tick({
    physical: meta.hlcPhysical,
    counter: meta.hlcCounter,
    nodeId: meta.deviceId,
  });
  await db.syncMeta.put({ ...meta, hlcPhysical: advanced.physical, hlcCounter: advanced.counter });
  return format(advanced);
}

/** Moves the local clock past a timestamp seen from another device. */
export async function observeRemoteStamp(remote: Hlc): Promise<void> {
  const meta = await getSyncMeta();
  const advanced = receive(
    { physical: meta.hlcPhysical, counter: meta.hlcCounter, nodeId: meta.deviceId },
    remote,
  );
  await db.syncMeta.put({ ...meta, hlcPhysical: advanced.physical, hlcCounter: advanced.counter });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Writes a record and queues it for sync.
 *
 * `fields` names which keys changed, used only for settings' per-field stamps so
 * that changing the region on one device does not discard a unit-system change
 * made on the other.
 */
export async function syncedPut(
  collection: SyncedCollection,
  record: Record<string, unknown>,
  fields?: readonly string[],
): Promise<void> {
  const id = idOf(collection, record);
  const hlc = await nextStamp();

  await db.transaction('rw', db.table(collection), db.recordMeta, db.outbox, async () => {
    await db.table(collection).put(record);

    const previous = await db.recordMeta.get(metaKey(collection, id));
    const fieldHlc = collection === 'settings'
      ? { ...(previous?.fieldHlc ?? {}), ...Object.fromEntries((fields ?? Object.keys(record)).map((f) => [f, hlc])) }
      : undefined;

    const meta: RecordMeta = { key: metaKey(collection, id), collection, id, hlc, fieldHlc };
    await db.recordMeta.put(meta);

    if (isSyncable(collection, record)) {
      const entry: OutboxEntry = {
        collection, id, hlc,
        data: fieldHlc ? { ...record, __fieldHlc: fieldHlc } : record,
      };
      await db.outbox.add(entry);
    }
  });
}

/** Deletes a record and queues a tombstone so the deletion actually propagates. */
export async function syncedDelete(collection: SyncedCollection, id: string): Promise<void> {
  const hlc = await nextStamp();

  await db.transaction('rw', db.table(collection), db.recordMeta, db.outbox, async () => {
    await db.table(collection).delete(id);
    await db.recordMeta.put({ key: metaKey(collection, id), collection, id, hlc, deleted: true });
    await db.outbox.add({ collection, id, hlc, deleted: true });
  });
}

/** Bulk variant for imports. One clock tick for the batch; still one outbox entry each. */
export async function syncedBulkPut(
  collection: SyncedCollection,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  if (records.length === 0) return;
  const hlc = await nextStamp();

  await db.transaction('rw', db.table(collection), db.recordMeta, db.outbox, async () => {
    await db.table(collection).bulkPut(records as never[]);

    const metas: RecordMeta[] = [];
    const entries: OutboxEntry[] = [];

    for (const record of records) {
      const id = idOf(collection, record);
      metas.push({ key: metaKey(collection, id), collection, id, hlc });
      if (isSyncable(collection, record)) entries.push({ collection, id, hlc, data: record });
    }

    await db.recordMeta.bulkPut(metas);
    if (entries.length > 0) await db.outbox.bulkAdd(entries);
  });
}

// ---------------------------------------------------------------------------
// Applying remote changes
// ---------------------------------------------------------------------------

/**
 * Applies a change pulled from the server, WITHOUT queueing it back for push.
 *
 * That distinction is the whole reason this is separate from `syncedPut`: echoing
 * remote changes back to the server would make two devices bounce the same record
 * between them indefinitely.
 */
export async function applyRemote(change: Change): Promise<void> {
  const key = metaKey(change.collection, change.id);

  await db.transaction('rw', db.table(change.collection), db.recordMeta, async () => {
    if (change.deleted) {
      await db.table(change.collection).delete(change.id);
      await db.recordMeta.put({
        key, collection: change.collection, id: change.id, hlc: change.hlc, deleted: true,
      });
      return;
    }

    const incoming = { ...(change.data as Record<string, unknown>) };
    const fieldHlc = incoming.__fieldHlc as Record<string, string> | undefined;
    delete incoming.__fieldHlc;

    await db.table(change.collection).put(incoming);
    await db.recordMeta.put({
      key, collection: change.collection, id: change.id, hlc: change.hlc, fieldHlc,
    });
  });
}

export async function localHlcFor(collection: SyncedCollection, id: string): Promise<string | undefined> {
  return (await db.recordMeta.get(metaKey(collection, id)))?.hlc;
}

// ---------------------------------------------------------------------------
// Initial upload
// ---------------------------------------------------------------------------

/**
 * Queues every existing local record for push.
 *
 * Runs when a device first links to a space. Records created before sync existed
 * have no HLC at all, so they are stamped here — all with the same timestamp,
 * which is fine because they are causally simultaneous from sync's point of view:
 * nothing has ever compared them to anything.
 */
export async function enqueueEverything(): Promise<number> {
  const hlc = await nextStamp();
  let queued = 0;

  for (const collection of SYNCED_COLLECTIONS) {
    const rows = (await db.table(collection).toArray()) as Record<string, unknown>[];

    await db.transaction('rw', db.recordMeta, db.outbox, async () => {
      const metas: RecordMeta[] = [];
      const entries: OutboxEntry[] = [];

      for (const record of rows) {
        if (!isSyncable(collection, record)) continue;
        const id = idOf(collection, record);

        // A record already stamped keeps its own timestamp — overwriting it would
        // make this device's copy spuriously win against a genuinely newer one.
        const existing = await db.recordMeta.get(metaKey(collection, id));

        // The built-in library ships with the app on every device, so pushing it
        // would send several hundred identical rows to say nothing. Absence of a
        // stamp is what identifies it: anything the user imported or edited went
        // through `syncedPut` and therefore has one.
        if (!existing && (collection === 'ingredients' || collection === 'recipes')) continue;

        const stamp = existing?.hlc ?? hlc;
        if (!existing) metas.push({ key: metaKey(collection, id), collection, id, hlc: stamp });

        entries.push({ collection, id, hlc: stamp, data: record });
        queued++;
      }

      if (metas.length > 0) await db.recordMeta.bulkPut(metas);
      if (entries.length > 0) await db.outbox.bulkAdd(entries);
    });
  }

  return queued;
}

export { createClock };
