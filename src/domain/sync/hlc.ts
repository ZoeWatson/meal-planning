/**
 * Hybrid logical clocks.
 *
 * Sync resolves conflicts last-write-wins, which needs a definition of "last".
 * The obvious choice — each device's wall clock — is quietly broken: if the
 * laptop's clock is ten minutes ahead of the phone, the laptop wins *every*
 * conflict regardless of what actually happened last, including overwriting
 * changes made after it. Phone clocks drift, laptops resume from sleep with stale
 * time, and nobody notices until a shopping list silently reverts.
 *
 * A hybrid logical clock fixes this for about thirty lines. It carries a physical
 * component (so timestamps stay human-meaningful and roughly track real time) and
 * a logical counter that increments when physical time fails to advance. Crucially
 * it also moves *forward* on receiving a remote timestamp, so once two devices
 * have exchanged anything, causally-later writes always compare greater — whatever
 * the local clocks say.
 *
 * Timestamps serialise to a fixed-width string so lexicographic comparison is
 * causal order, which means the database can sort them and the server never needs
 * to understand them.
 */

export interface HlcState {
  /** Milliseconds since epoch, as last observed or advanced. */
  readonly physical: number;
  /** Ticks within the same millisecond, or while waiting for physical to catch up. */
  readonly counter: number;
  /** Stable per-device id. Breaks ties deterministically so merges converge. */
  readonly nodeId: string;
}

/** Widths chosen to stay sortable past the year 5138 and 65k events per millisecond. */
const PHYSICAL_WIDTH = 15;
const COUNTER_WIDTH = 5;
const MAX_COUNTER = 99_999;

/**
 * Guards against a wildly wrong remote clock dragging this device's clock decades
 * into the future, which would make every subsequent local write unbeatable.
 * A day is far beyond any plausible skew and far below "clock is nonsense".
 */
const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

export function createClock(nodeId: string, now = Date.now()): HlcState {
  return { physical: now, counter: 0, nodeId };
}

/** Advances the clock for a local write. */
export function tick(state: HlcState, now = Date.now()): HlcState {
  if (now > state.physical) {
    return { ...state, physical: now, counter: 0 };
  }
  // Physical time did not advance (same millisecond, or the clock went backwards):
  // the logical counter is what keeps timestamps strictly increasing.
  return { ...state, counter: state.counter + 1 };
}

/**
 * Advances the clock on receiving a remote timestamp.
 *
 * This is the step that makes the whole scheme work: after receiving, any write
 * this device makes is guaranteed to compare greater than the remote write it just
 * saw, regardless of the local clock.
 */
export function receive(state: HlcState, remote: Hlc, now = Date.now()): HlcState {
  const cappedRemotePhysical = Math.min(remote.physical, now + MAX_DRIFT_MS);
  const physical = Math.max(state.physical, cappedRemotePhysical, now);

  if (physical === state.physical && physical === cappedRemotePhysical) {
    return { ...state, counter: Math.max(state.counter, remote.counter) + 1 };
  }
  if (physical === state.physical) {
    return { ...state, counter: state.counter + 1 };
  }
  if (physical === cappedRemotePhysical) {
    return { ...state, physical, counter: remote.counter + 1 };
  }
  return { ...state, physical, counter: 0 };
}

export interface Hlc {
  readonly physical: number;
  readonly counter: number;
  readonly nodeId: string;
}

/** Serialises to a fixed-width string whose lexicographic order is causal order. */
export function format(state: Hlc): string {
  if (state.counter > MAX_COUNTER) {
    // Rolling over would break sort order, so borrow from physical time instead.
    return format({ physical: state.physical + 1, counter: 0, nodeId: state.nodeId });
  }
  return [
    String(state.physical).padStart(PHYSICAL_WIDTH, '0'),
    String(state.counter).padStart(COUNTER_WIDTH, '0'),
    state.nodeId,
  ].join('-');
}

export function parse(stamp: string): Hlc {
  const physical = Number(stamp.slice(0, PHYSICAL_WIDTH));
  const counter = Number(stamp.slice(PHYSICAL_WIDTH + 1, PHYSICAL_WIDTH + 1 + COUNTER_WIDTH));
  const nodeId = stamp.slice(PHYSICAL_WIDTH + COUNTER_WIDTH + 2);

  if (!Number.isFinite(physical) || !Number.isFinite(counter)) {
    throw new Error(`Malformed HLC timestamp: ${stamp}`);
  }
  return { physical, counter, nodeId };
}

/**
 * Orders two serialised timestamps. Negative when `a` happened before `b`.
 *
 * Plain string comparison, which is the point of the fixed-width encoding: the
 * database, the server and the merge logic can all order changes without any of
 * them knowing what an HLC is.
 */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Generates a stable device identifier. Short, because it is in every timestamp. */
export function generateNodeId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
