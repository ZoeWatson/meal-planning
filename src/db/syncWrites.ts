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
import {
  compare, createClock, format, generateNodeId, parse, receive, tick, type Hlc,
} from '../domain/sync/hlc';
import { collapse, isSyncable, mergeChange, mergeSettings } from '../domain/sync/merge';
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
  cookedMeals: 'id',
  leftovers: 'id',
  mealLog: 'id',
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

    /**
     * Settings merge per field rather than per row.
     *
     * The row is one record holding unrelated preferences, so changing the region
     * here and the unit system there is not a conflict in any sense a human would
     * recognise — but a wholesale put discards one of them, which is the "my
     * setting keeps reverting" bug `mergeSettings` was written to prevent.
     *
     * The stored stamp is the later of the two. Taking the incoming one blindly
     * would walk the row's clock *backwards* when an older device's file is
     * applied, and the next write from here would then lose to changes it
     * genuinely came after.
     */
    if (change.collection === 'settings') {
      const local = (await db.settings.get(change.id)) as Record<string, unknown> | undefined;
      const localMeta = await db.recordMeta.get(key);

      const { merged, fieldHlc: mergedFieldHlc } = mergeSettings(
        local, incoming, localMeta?.fieldHlc, fieldHlc,
      );

      await db.settings.put(merged as never);
      await db.recordMeta.put({
        key,
        collection: change.collection,
        id: change.id,
        hlc: localMeta && compare(localMeta.hlc, change.hlc) > 0 ? localMeta.hlc : change.hlc,
        fieldHlc: mergedFieldHlc,
      });
      return;
    }

    await db.table(change.collection).put(incoming);
    await db.recordMeta.put({
      key, collection: change.collection, id: change.id, hlc: change.hlc, fieldHlc,
    });
  });
}

export async function localHlcFor(collection: SyncedCollection, id: string): Promise<string | undefined> {
  return (await db.recordMeta.get(metaKey(collection, id)))?.hlc;
}

export interface ApplyOutcome {
  readonly applied: number;
  /** Changes the local copy already beat. Not a failure — the common case. */
  readonly skipped: number;
}

/**
 * Merges a batch of foreign changes into this device, whatever carried them.
 *
 * One implementation for both transports on purpose. The server pull and the
 * hand-carried file are the same operation — here are some records, decide which
 * of them beat what you hold — and two copies of that loop would be two chances
 * to get last-write-wins subtly different depending on how the data arrived.
 */
export async function applyChanges(changes: readonly Change[]): Promise<ApplyOutcome> {
  let applied = 0;
  let skipped = 0;

  for (const change of collapse(changes)) {
    // Advance the local clock past everything seen, whether or not it wins, so
    // this device's next write is guaranteed to compare later than it.
    await observeRemoteStamp(parse(change.hlc));

    // Settings skip the row-level gate deliberately. An incoming row that loses
    // overall can still carry a newer individual field, and `applyRemote` merges
    // it field by field — gating here would discard that before it was looked at.
    if (change.collection === 'settings') {
      await applyRemote(change);
      applied++;
      continue;
    }

    const local = await localHlcFor(change.collection, change.id);
    if (mergeChange(change, local).action === 'apply') {
      await applyRemote(change);
      applied++;
    } else {
      skipped++;
    }
  }

  return { applied, skipped };
}

// ---------------------------------------------------------------------------
// Hand-carried transfer
// ---------------------------------------------------------------------------

/**
 * Every local record as a change, for writing to a transfer file.
 *
 * The sibling of `enqueueEverything` — same rules about what travels, different
 * destination. It returns the changes rather than queueing them, because a file
 * is not a space this device has joined: exporting twice should produce the same
 * file, not push the same records twice.
 *
 * It does write, despite reading like a query. Records made before sync existed
 * have no stamp at all, and an unstamped record cannot be compared against
 * anything on the far side — so they are stamped here and the stamp is kept, all
 * with one timestamp, which is honest: nothing has ever compared them to anything.
 *
 * Tombstones are gathered separately because a deleted record has no row left to
 * iterate. Without them a recipe deleted on the phone would simply be handed back
 * by the laptop's next file, which is the resurrection bug `deleted` exists to
 * prevent — and it is far more visible here than over HTTP, where both devices
 * reconcile against one server rather than against each other.
 */
export async function collectChanges(): Promise<Change[]> {
  const fallback = await nextStamp();
  const changes: Change[] = [];
  const stamped: RecordMeta[] = [];

  for (const collection of SYNCED_COLLECTIONS) {
    const rows = (await db.table(collection).toArray()) as Record<string, unknown>[];

    for (const record of rows) {
      if (!isSyncable(collection, record)) continue;
      const id = idOf(collection, record);
      const existing = await db.recordMeta.get(metaKey(collection, id));

      // The built-in library ships inside the app and reseeds itself on every
      // install, so carrying it would be megabytes of file saying nothing.
      // Absence of a stamp is what identifies it: anything the user imported or
      // edited went through `syncedPut` and therefore has one.
      if (!existing && (collection === 'ingredients' || collection === 'recipes')) continue;

      const hlc = existing?.hlc ?? fallback;
      if (!existing) stamped.push({ key: metaKey(collection, id), collection, id, hlc });

      // Settings carry their per-field stamps, which is what lets the far side
      // merge field by field instead of taking the row wholesale.
      changes.push({
        collection,
        id,
        hlc,
        data: collection === 'settings' && existing?.fieldHlc
          ? { ...record, __fieldHlc: existing.fieldHlc }
          : record,
      });
    }
  }

  const tombstones = await db.recordMeta.filter((meta) => meta.deleted === true).toArray();
  for (const meta of tombstones) {
    changes.push({ collection: meta.collection, id: meta.id, hlc: meta.hlc, deleted: true });
  }

  if (stamped.length > 0) await db.recordMeta.bulkPut(stamped);

  return changes;
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
