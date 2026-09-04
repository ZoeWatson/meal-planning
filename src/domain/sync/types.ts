/**
 * The sync protocol.
 *
 * Deliberately small. Single user, two devices, rarely used simultaneously, and
 * the worst realistic collision is a ticked checkbox — so this is last-write-wins
 * over a change log, not a CRDT. Resisting that temptation is the design decision;
 * CRDTs would be several hundred lines of machinery to correctly merge a boolean
 * that two devices essentially never touch at the same moment.
 */

/** Tables that participate in sync. The recipe library's built-ins are excluded. */
export const SYNCED_COLLECTIONS = [
  'settings', 'plans', 'checks', 'staples', 'pantry', 'sales', 'carryOver',
  'recipes', 'ingredients',
  // Spending. Barcodes are included because what a scan means is worth learning
  // once across all your devices, not once per device.
  'expenses', 'customItems', 'barcodes',
] as const;

export type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number];

/**
 * One record's state at one moment.
 *
 * Deletions travel as `deleted: true` with no payload rather than as an absence.
 * Without a tombstone, deleting a staple on the phone would simply be undone by
 * the laptop's next sync re-uploading its copy — the record would rise from the
 * dead every time, which is a genuinely baffling bug to debug from the outside.
 */
export interface Change {
  readonly collection: SyncedCollection;
  readonly id: string;
  /** Serialised HLC. Lexicographic order is causal order; larger wins. */
  readonly hlc: string;
  readonly deleted?: boolean;
  readonly data?: unknown;
}

/** A change as stored by the server, with its position in the space's log. */
export interface ServerChange extends Change {
  readonly seq: number;
}

export interface PullResult {
  readonly changes: readonly ServerChange[];
  /** Cursor to pass as `since` next time. */
  readonly seq: number;
  /** True when the server had more than one page; call pull again immediately. */
  readonly hasMore: boolean;
}

export interface PushResult {
  readonly seq: number;
  readonly accepted: number;
}

/**
 * The one thing a backend has to implement.
 *
 * Kept to two methods so the reference server can stay dependency-free and be
 * swapped for Supabase, a Cloudflare Worker, or anything else without the engine
 * or the UI knowing.
 */
export interface SyncTransport {
  push(changes: readonly Change[]): Promise<PushResult>;
  pull(since: number, limit?: number): Promise<PullResult>;
}

export class SyncError extends Error {
  constructor(
    message: string,
    /** True when retrying later might work — offline, server down, timeout. */
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export type SyncPhase = 'idle' | 'pushing' | 'pulling' | 'error' | 'offline';

export interface SyncStatus {
  readonly phase: SyncPhase;
  readonly lastSyncedAtISO: string | null;
  readonly pendingChanges: number;
  readonly lastError: string | null;
  /** Set once the device is linked to a space. */
  readonly spaceId: string | null;
}
