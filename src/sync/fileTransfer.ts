/**
 * Sync by hand: the file transport.
 *
 * The reference server implements `SyncTransport` — push and pull against a
 * cursor. A file cannot: there is no sequence to pull from and nothing on the far
 * side to acknowledge a push, so forcing it through that interface would mean
 * inventing a cursor that means nothing. It is a sibling of the HTTP transport
 * rather than an implementation of it.
 *
 * What it does share is everything that matters — the change format, the clock,
 * and `applyChanges`. A file and a server pull are the same thing arriving by
 * different means, and the merge cannot tell them apart.
 */

import { collectChanges, getSyncMeta, applyChanges } from '../db/syncWrites';
import {
  buildTransferFile, parseTransferFile, summarizeChanges,
  type CollectionSummary, type TransferFile,
} from '../domain/sync/transferFile';

export interface TransferExport {
  /** The file's contents, ready to be written or shared. */
  readonly json: string;
  readonly filename: string;
  readonly changeCount: number;
  readonly summary: readonly CollectionSummary[];
}

/**
 * Everything this device holds, as a file.
 *
 * Not pretty-printed. This is written and read by the app rather than edited by
 * hand — the library export is the one people open in a text editor — and the
 * indentation on a few thousand records is a third of the file size, which is a
 * third of what has to go down a cable or through a chat app.
 */
export async function exportTransfer(): Promise<TransferExport> {
  const changes = await collectChanges();
  const meta = await getSyncMeta();
  const file = buildTransferFile(changes, meta.deviceId);

  return {
    json: JSON.stringify(file),
    // Device and date in the name, because the failure mode of this whole scheme
    // is two files in a downloads folder and no way to tell which is the phone's.
    filename: `meal-plan-${meta.deviceId}-${file.exportedAtISO.slice(0, 10)}.json`,
    changeCount: changes.length,
    summary: summarizeChanges(changes),
  };
}

export interface TransferPreview {
  readonly file: TransferFile;
  readonly summary: readonly CollectionSummary[];
  /**
   * True when the file came from this device.
   *
   * Applying it is harmless — every change would lose to the copy it came from,
   * or tie with it — but it is almost always a mistake reaching for the wrong
   * file, and saying so beats reporting that nothing happened.
   */
  readonly sameDevice: boolean;
}

/**
 * Reads a file and says what is in it, writing nothing.
 *
 * Separate from applying it because that is how the rest of this app treats
 * imports: nothing lands until you have seen what it will do. It matters more
 * here than for recipes — this file can delete records.
 */
export async function previewTransfer(source: string): Promise<TransferPreview> {
  const file = parseTransferFile(source);
  const meta = await getSyncMeta();

  return {
    file,
    summary: summarizeChanges(file.changes),
    sameDevice: file.deviceId !== '' && file.deviceId === meta.deviceId,
  };
}

export interface TransferImportResult {
  readonly applied: number;
  /** Records where this device's copy was already newer. Expected, not a problem. */
  readonly skipped: number;
  readonly total: number;
}

/**
 * Merges a previewed file into this device.
 *
 * Takes the parsed file rather than the text so the thing applied is provably the
 * thing shown — re-parsing here would let the two drift apart if the source in
 * hand ever changed between the two calls.
 */
export async function importTransfer(file: TransferFile): Promise<TransferImportResult> {
  const { applied, skipped } = await applyChanges(file.changes);
  return { applied, skipped, total: file.changes.length };
}
