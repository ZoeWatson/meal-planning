/**
 * The one deterministic random number generator.
 *
 * Everything random in this app is seeded and stored — a plan keeps the seed it
 * was built from, so it can be reproduced or nudged rather than merely re-rolled.
 * That only holds if every draw uses the same generator: two different PRNGs mean
 * the same seed gives different answers depending on which code path ran, which
 * is the kind of bug that only shows up as "the plan changed and nothing changed".
 */

/** mulberry32 — small, fast, and good enough for choosing carrots. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
