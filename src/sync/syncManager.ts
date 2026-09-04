/**
 * Sync orchestration.
 *
 * Order matters and is not arbitrary: PULL, then reconcile the outbox, then PUSH.
 *
 * Pulling first means a stale local edit can be dropped before it is sent, rather
 * than being pushed and clobbering a newer change that was already on the server.
 * Pushing first would make the last device to sync always win, which is exactly
 * the bug last-write-wins is supposed to avoid.
 */

import { db } from '../db/database';
import {
  applyRemote, enqueueEverything, getSyncMeta, localHlcFor, observeRemoteStamp, updateSyncMeta,
} from '../db/syncWrites';
import { collapse, mergeChange, pruneSupersededOutbox } from '../domain/sync/merge';
import { parse } from '../domain/sync/hlc';
import {
  SyncError, type Change, type SyncStatus, type SyncTransport,
} from '../domain/sync/types';
import { HttpSyncTransport, spaceIdFromCode } from './httpTransport';

export interface SyncOutcome {
  readonly pulled: number;
  readonly applied: number;
  readonly pushed: number;
  readonly dropped: number;
}

let inFlight: Promise<SyncOutcome> | null = null;
const listeners = new Set<() => void>();

export function onSyncChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

async function transportFor(): Promise<SyncTransport | null> {
  const meta = await getSyncMeta();
  if (!meta.spaceId || !meta.serverUrl) return null;
  return new HttpSyncTransport(meta.serverUrl, meta.spaceId);
}

/**
 * Runs one full sync cycle.
 *
 * Guarded against concurrent runs: a manual tap while the periodic timer is
 * already syncing would otherwise push the same outbox entries twice and, worse,
 * clear the outbox out from under the first run.
 */
export async function sync(): Promise<SyncOutcome> {
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => {
    inFlight = null;
    notify();
  });
  return inFlight;
}

async function runSync(): Promise<SyncOutcome> {
  const transport = await transportFor();
  if (!transport) throw new SyncError('This device is not linked to a sync space.', false);

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new SyncError('Offline — changes are queued and will sync when you reconnect.', true);
  }

  let pulled = 0;
  let applied = 0;
  let dropped = 0;

  try {
    // --- 1. Pull ---------------------------------------------------------
    // Paged, because a device that has been offline for weeks should not have to
    // hold the entire history in memory to catch up.
    let hasMore = true;
    while (hasMore) {
      const meta = await getSyncMeta();
      const result = await transport.pull(meta.lastPulledSeq);
      pulled += result.changes.length;
      hasMore = result.hasMore;

      if (result.changes.length > 0) {
        applied += await applyIncoming(result.changes);
        dropped += await reconcileOutbox(result.changes);
      }

      await updateSyncMeta({ lastPulledSeq: result.seq });
      if (result.changes.length === 0) break;
    }

    // --- 2. Push ---------------------------------------------------------
    const pushed = await drainOutbox(transport);

    await updateSyncMeta({ lastSyncedAtISO: new Date().toISOString(), lastError: null });
    return { pulled, applied, pushed, dropped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateSyncMeta({ lastError: message });
    throw err;
  }
}

/** Applies pulled changes that beat the local copy. */
async function applyIncoming(changes: readonly Change[]): Promise<number> {
  let applied = 0;

  for (const change of collapse(changes)) {
    // Advance the local clock past everything seen, whether or not it wins, so
    // this device's next write is guaranteed to compare later than it.
    await observeRemoteStamp(parse(change.hlc));

    const local = await localHlcFor(change.collection, change.id);
    if (mergeChange(change, local).action === 'apply') {
      await applyRemote(change);
      applied++;
    }
  }

  return applied;
}

/** Drops queued local changes the server has already superseded. */
async function reconcileOutbox(incoming: readonly Change[]): Promise<number> {
  const pending = await db.outbox.toArray();
  if (pending.length === 0) return 0;

  const { dropped } = pruneSupersededOutbox(pending, incoming);
  if (dropped.length === 0) return 0;

  const keys = dropped
    .map((d) => (d as { localSeq?: number }).localSeq)
    .filter((s): s is number => s !== undefined);
  await db.outbox.bulkDelete(keys);

  return dropped.length;
}

const PUSH_BATCH = 200;

/**
 * Sends queued changes, deleting each batch only after the server confirms it.
 *
 * If the connection drops mid-drain the un-acknowledged entries stay queued and
 * go out next time. Re-sending a change the server already has is harmless — it
 * is idempotent under last-write-wins — whereas dropping one is permanent.
 */
async function drainOutbox(transport: SyncTransport): Promise<number> {
  let pushed = 0;

  for (;;) {
    const batch = await db.outbox.orderBy('localSeq').limit(PUSH_BATCH).toArray();
    if (batch.length === 0) break;

    const changes: Change[] = batch.map(({ collection, id, hlc, deleted, data }) => ({
      collection, id, hlc, deleted, data,
    }));

    await transport.push(changes);

    const keys = batch
      .map((entry) => entry.localSeq)
      .filter((s): s is number => s !== undefined);
    await db.outbox.bulkDelete(keys);

    pushed += batch.length;
    if (batch.length < PUSH_BATCH) break;
  }

  return pushed;
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

/**
 * Links this device to a sync space.
 *
 * Everything already on the device is queued for upload. That is correct for both
 * cases it has to cover — the first device, whose data is the starting point, and
 * a second device that already has its own plans and staples. Merging by HLC means
 * the second device's records join the space rather than being wiped by it.
 */
export async function linkSpace(serverUrl: string, code: string): Promise<{ queued: number }> {
  const spaceId = await spaceIdFromCode(code);

  // Verified before anything is written, so a typo in the URL fails immediately
  // rather than leaving the device "linked" to something that does not exist.
  const probe = new HttpSyncTransport(serverUrl, spaceId);
  await probe.pull(0, 1);

  await updateSyncMeta({ spaceId, serverUrl, lastPulledSeq: 0, lastError: null });
  const queued = await enqueueEverything();

  notify();
  return { queued };
}

/**
 * Unlinks, leaving local data untouched.
 *
 * The outbox is cleared because those entries belong to a space this device is no
 * longer part of; keeping them would dump them into whatever space it joins next.
 */
export async function unlinkSpace(): Promise<void> {
  await db.outbox.clear();
  await updateSyncMeta({
    spaceId: null, serverUrl: null, lastPulledSeq: 0,
    lastSyncedAtISO: null, lastError: null,
  });
  notify();
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function getStatus(): Promise<SyncStatus> {
  const meta = await getSyncMeta();
  const pending = await db.outbox.count();

  return {
    phase: inFlight ? 'pulling'
      : meta.lastError ? 'error'
      : typeof navigator !== 'undefined' && !navigator.onLine ? 'offline'
      : 'idle',
    lastSyncedAtISO: meta.lastSyncedAtISO,
    pendingChanges: pending,
    lastError: meta.lastError,
    spaceId: meta.spaceId,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let stopAuto: (() => void) | null = null;

/**
 * Syncs on the events that actually matter on a phone.
 *
 * Not a short polling interval: the phone is asleep in a pocket most of the time,
 * and waking the radio every thirty seconds to hear "nothing changed" costs
 * battery for no benefit. Coming back to the app, regaining a connection, and
 * leaving the app are the moments when syncing is both useful and cheap — the
 * last one especially, since it is what makes a list ticked in a shop reach the
 * laptop before you get home.
 */
export function startAutoSync(): () => void {
  if (stopAuto) return stopAuto;

  const attempt = (): void => {
    void sync().catch(() => {
      // Failures are surfaced through status; an unhandled rejection here would
      // just be noise in the console every time the user walks into a basement.
    });
  };

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') attempt();
    else void flush();
  };

  window.addEventListener('online', attempt);
  document.addEventListener('visibilitychange', onVisible);
  const timer = window.setInterval(attempt, 5 * 60 * 1000);

  attempt();

  stopAuto = () => {
    window.removeEventListener('online', attempt);
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(timer);
    stopAuto = null;
  };
  return stopAuto;
}

/** Best-effort push when the app is being backgrounded. */
async function flush(): Promise<void> {
  const meta = await getSyncMeta();
  if (!meta.spaceId) return;
  if ((await db.outbox.count()) === 0) return;
  await sync().catch(() => undefined);
}
