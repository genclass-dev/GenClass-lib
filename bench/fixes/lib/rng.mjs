// Seeded randomness shared by the server (latency, failures) and the runner (typing, clicks, terms).
// Every draw comes from a string key, so the same key gives the same number in every strategy and condition:
// the request for "react q" in seed 7 of the jittery profile takes the same time whichever fix is on the page.

/** 32-bit FNV-1a of a string, finished with murmur3's mixer so that keys differing in one character spread out. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: a small, fast PRNG; returns a function giving floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PRNG stream for a key. */
export const stream = (key) => mulberry32(hash32(key));

/** A uniform integer in [lo, hi] from a PRNG. */
export const uniformInt = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
