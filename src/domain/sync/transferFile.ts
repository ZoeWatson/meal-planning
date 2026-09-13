/**
 * The transfer file: sync's change log, carried by hand.
 *
 * There is no server. Two devices are kept in step by exporting a file on one and
 * importing it on the other — over a cable, a chat message, whatever is to hand.
 *
 * The file holds **changes, not a snapshot**, and that is the whole design. A
 * snapshot can only be restored, which means the importing device loses whatever
 * it did since the export: tick a list in a shop, import the laptop's new plan,
 * and the ticks are gone. A change log merges instead — every record carries the
 * HLC it was written at, so `mergeChange` picks a winner per record exactly as it
 * would over HTTP, and the phone's ticks and the laptop's plan both survive.
 *
 * It doubles as a backup for free: applied to an empty database, every record in
 * the log is new, so the merge writes all of it.
 *
 * What is deliberately absent is the built-in library. Those several hundred
 * recipes ship inside the app and reseed themselves on any install, so carrying
 * them would be megabytes of file saying nothing. `collectChanges` uses the same
 * test `enqueueEverything` does — an unstamped recipe is one the app shipped.
 */

import { parse } from './hlc';
import { SYNCED_COLLECTIONS, type Change, type SyncedCollection } from './types';

/** Identifies the file to a human looking at it, and to us on the way back in. */
export const TRANSFER_FORMAT = 'meal-planning-transfer';

/**
 * Bumped only when an old file would be read *wrongly* by new code, which is not
 * the same as the shape changing. Adding a field older code ignores is safe and
 * needs no bump; changing what `hlc` means is not.
 */
export const TRANSFER_VERSION = 1;

export interface TransferFile {
  readonly format: typeof TRANSFER_FORMAT;
  readonly version: number;
  readonly exportedAtISO: string;
  /**
   * Which device wrote the file. Carried for the human, who is otherwise holding
   * two identically-named files and guessing which one is the phone's.
   */
  readonly deviceId: string;
  readonly changes: readonly Change[];
}

export function buildTransferFile(
  changes: readonly Change[],
  deviceId: string,
  now = new Date(),
): TransferFile {
  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAtISO: now.toISOString(),
    deviceId,
    changes,
  };
}

/** Thrown for anything that is not a transfer file we can safely apply. */
export class TransferFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferFileError';
  }
}

const COLLECTIONS = new Set<string>(SYNCED_COLLECTIONS);

/**
 * Parses and validates, refusing anything it cannot fully vouch for.
 *
 * Strict on purpose. These changes go straight into the merge engine, which
 * trusts its input — a change with an unparseable HLC would sort arbitrarily
 * against real ones, and one naming a collection that does not exist would throw
 * from inside a Dexie transaction with earlier changes already written. Both are
 * far worse than refusing the file at the door, and a hand-carried file has no
 * server to have checked it on the way past.
 *
 * The error messages name the offending entry, because the person debugging this
 * is holding a multi-megabyte JSON file and nothing else.
 */
export function parseTransferFile(source: string): TransferFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new TransferFileError(
      `That is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TransferFileError('That file is not a transfer file.');
  }

  const file = parsed as Record<string, unknown>;

  if (file.format !== TRANSFER_FORMAT) {
    // The library bundle is the other JSON file this app produces, and picking
    // the wrong one is the obvious mistake. Say so rather than "invalid format".
    const looksLikeLibrary = 'recipes' in file || 'ingredients' in file;
    throw new TransferFileError(
      looksLikeLibrary
        ? 'That looks like a recipe library export, not a transfer file. Bring it in under "Import & export recipes" instead.'
        : 'That file is not a transfer file.',
    );
  }

  if (typeof file.version !== 'number' || !Number.isInteger(file.version)) {
    throw new TransferFileError('That transfer file has no version number.');
  }
  if (file.version > TRANSFER_VERSION) {
    throw new TransferFileError(
      `That file was written by a newer version of the app (format ${file.version}, this one reads ${TRANSFER_VERSION}). Update this device first.`,
    );
  }

  if (!Array.isArray(file.changes)) {
    throw new TransferFileError('That transfer file has no changes in it.');
  }

  const changes = file.changes.map((entry, index) => validateChange(entry, index));

  return {
    format: TRANSFER_FORMAT,
    version: file.version,
    exportedAtISO: typeof file.exportedAtISO === 'string' ? file.exportedAtISO : '',
    deviceId: typeof file.deviceId === 'string' ? file.deviceId : '',
    changes,
  };
}

function validateChange(entry: unknown, index: number): Change {
  const where = `Change ${index + 1}`;

  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TransferFileError(`${where} is not an object.`);
  }

  const change = entry as Record<string, unknown>;

  if (typeof change.collection !== 'string' || !COLLECTIONS.has(change.collection)) {
    throw new TransferFileError(
      `${where} names a collection this app does not have: ${String(change.collection)}`,
    );
  }
  if (typeof change.id !== 'string' || change.id === '') {
    throw new TransferFileError(`${where} has no id.`);
  }
  if (typeof change.hlc !== 'string') {
    throw new TransferFileError(`${where} (${change.collection}/${change.id}) has no timestamp.`);
  }

  // Parsing is the only real check that the stamp will sort correctly. A stamp
  // that throws here would otherwise throw mid-apply, after earlier changes in
  // the same file had already been written.
  try {
    parse(change.hlc);
  } catch {
    throw new TransferFileError(
      `${where} (${change.collection}/${change.id}) has a malformed timestamp.`,
    );
  }

  const deleted = change.deleted === true;

  // A tombstone carries no payload and a write must carry one. Letting a
  // payload-less write through would put `undefined` into the table, losing the
  // record on the importing device while reporting success.
  if (!deleted && (typeof change.data !== 'object' || change.data === null)) {
    throw new TransferFileError(
      `${where} (${change.collection}/${change.id}) is missing its data.`,
    );
  }

  return deleted
    ? {
        collection: change.collection as SyncedCollection,
        id: change.id,
        hlc: change.hlc,
        deleted: true,
      }
    : {
        collection: change.collection as SyncedCollection,
        id: change.id,
        hlc: change.hlc,
        data: change.data,
      };
}

export interface CollectionSummary {
  readonly collection: SyncedCollection;
  readonly writes: number;
  readonly deletes: number;
}

/** Per-collection counts, for showing what a file holds before it is applied. */
export function summarizeChanges(changes: readonly Change[]): CollectionSummary[] {
  const counts = new Map<SyncedCollection, { writes: number; deletes: number }>();

  for (const change of changes) {
    const entry = counts.get(change.collection) ?? { writes: 0, deletes: 0 };
    if (change.deleted) entry.deletes++;
    else entry.writes++;
    counts.set(change.collection, entry);
  }

  // Ordered by the canonical collection list rather than by count, so the same
  // file always reads the same way down the screen.
  return SYNCED_COLLECTIONS.flatMap((collection) => {
    const entry = counts.get(collection);
    return entry ? [{ collection, writes: entry.writes, deletes: entry.deletes }] : [];
  });
}
