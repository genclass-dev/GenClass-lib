// Seeded network chaos for the GenClass Playwright fixture: which responses to slow down, by how much, and whether
// they may overtake each other, every value derived from a seed so that a run repeats exactly. Pure: no Playwright,
// no I/O, no clock of its own (the scheduler takes its timers from the caller, so tests drive it by hand). The fixture
// (install.ts) applies the plan with page.route: it fetches the real response and holds its delivery for the planned
// time. Nothing is dropped, changed or invented, and requests outside the filter are never touched; the runtime's own
// files (served on RUNTIME_PATH) never are.
//
// Determinism: a matched request is keyed by its method, path and occurrence in the test ("GET /api/search#3"), and
// its delay is read from a small PRNG seeded by the chaos seed and that key. The same test under the same seed gives
// the same delays whatever the wall clock does.

/** Where install.ts serves the runtime's dist/ on the page's origin. Chaos never applies to it. */
export const RUNTIME_PATH = "/__genclass__/";
/** The largest extra latency the fixture applies, in ms (a hold must stay bounded). */
export const MAX_DELAY_MS = 10_000;
/** The default `delayMs` when `chaos` is given without one. */
export const DEFAULT_DELAY_MS: readonly [number, number] = [0, 600];
/** The default seed (the fixture adds Playwright's `repeatEachIndex` to it). */
export const DEFAULT_SEED = 1;

/** A request as the filter sees it, before its response is fetched. */
export interface ChaosRequest {
  url: string;
  method: string;
  /** Playwright's resource type; only "fetch" and "xhr" are ever candidates. */
  resourceType: string;
  /** Same origin as the document that sent it. */
  sameOrigin: boolean;
}

export type ChaosMatchFn = (r: ChaosRequest) => boolean;
/**
 * Which requests get chaos: a string (a path prefix such as "/api", or a URL prefix such as "https://api.example.com/"),
 * a RegExp tested against the full URL, a function, or a list of those (any match counts). Unset: same-origin
 * requests whose path starts with /api or whose response is JSON.
 */
export type ChaosMatch = string | RegExp | ChaosMatchFn | readonly (string | RegExp | ChaosMatchFn)[];

export interface ChaosOptions {
  /** Every delay is derived from it. Default 1; with `repeatEach`, the fixture adds the repeat index. */
  seed?: number;
  /** Extra latency per matched response, uniform in [min, max] ms. Default [0, 600]; at most 10000. */
  delayMs?: readonly [number, number];
  /** false: matched responses keep their request order (latency only, nothing overtakes). Default true. */
  reorder?: boolean;
  /** Which requests (see ChaosMatch). Default: same-origin, path /api* or a JSON response. */
  match?: ChaosMatch;
}

export interface ResolvedChaos {
  seed: number;
  delayMs: [number, number];
  reorder: boolean;
  match: ChaosMatch | undefined;
}

/** One matched request: its key and the latency the seed gives it. */
export interface ChaosPlan {
  key: string;
  delayMs: number;
}

/** 32-bit FNV-1a with a murmur3 finaliser (the same hash the runtime's agent schedules use). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The latency for one key under a seed: uniform in [min, max], the same for the same seed and key. */
export function delayFor(seed: number, key: string, delayMs: readonly [number, number]): number {
  const [min, max] = delayMs;
  if (max <= min) return min;
  const r = mulberry32(hash32(`${seed}|${key}`))();
  return Math.min(max, min + Math.floor(r * (max - min + 1)));
}

function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/** Fills in the defaults and bounds the values. `true` means the defaults. Throws on a `match` of the wrong type. */
export function resolveChaos(o: ChaosOptions | true | undefined | null, seedOffset = 0): ResolvedChaos {
  const c: ChaosOptions = o === true || !o ? {} : o;
  const d = c.delayMs;
  let min = DEFAULT_DELAY_MS[0];
  let max = DEFAULT_DELAY_MS[1];
  if (Array.isArray(d) && d.length === 2) {
    min = Math.min(MAX_DELAY_MS, int(d[0], 0));
    max = Math.min(MAX_DELAY_MS, Math.max(min, int(d[1], min)));
  } else if (d !== undefined) throw new TypeError(`@genclass/playwright: chaos.delayMs must be [min, max] in ms, got ${JSON.stringify(d)}`);
  if (c.match !== undefined && !isMatch(c.match)) throw new TypeError("@genclass/playwright: chaos.match must be a string, a RegExp, a function, or a list of those");
  return { seed: int(c.seed, DEFAULT_SEED) + Math.max(0, int(seedOffset, 0)), delayMs: [min, max], reorder: c.reorder !== false, match: c.match };
}

function isMatch(m: unknown): m is ChaosMatch {
  if (Array.isArray(m)) return m.every((x) => typeof x === "string" || x instanceof RegExp || typeof x === "function");
  return typeof m === "string" || m instanceof RegExp || typeof m === "function";
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** True for the runtime's own files (never chaos, whatever the filter says). */
export function isRuntimeUrl(url: string): boolean {
  return pathOf(url).startsWith(RUNTIME_PATH);
}

function matchesOne(m: string | RegExp | ChaosMatchFn, r: ChaosRequest): boolean {
  if (typeof m === "function") return m(r) === true;
  if (m instanceof RegExp) {
    m.lastIndex = 0;
    return m.test(r.url);
  }
  return m.startsWith("/") ? pathOf(r.url).startsWith(m) : r.url.startsWith(m);
}

/**
 * Whether a request may get chaos, decided before its response is fetched. Only fetch and XHR requests, never the
 * runtime's files. With a `match`, the filter decides; without one, every same-origin request is a candidate and
 * `confirms` decides from the response.
 */
export function isCandidate(r: ChaosRequest, match: ChaosMatch | undefined): boolean {
  if (r.resourceType !== "fetch" && r.resourceType !== "xhr") return false;
  if (isRuntimeUrl(r.url)) return false;
  if (match === undefined) return r.sameOrigin;
  const list = Array.isArray(match) ? (match as readonly (string | RegExp | ChaosMatchFn)[]) : [match as string | RegExp | ChaosMatchFn];
  return list.some((m) => matchesOne(m, r));
}

/**
 * Whether a candidate gets chaos once its response is known. With a `match`, always (the filter already said yes);
 * without one, when the path starts with /api or the response is JSON (its content-type names json).
 */
export function confirms(r: ChaosRequest, match: ChaosMatch | undefined, contentType: string | null | undefined): boolean {
  if (match !== undefined) return true;
  if (pathOf(r.url).startsWith("/api")) return true;
  return /json/i.test(contentType ?? "");
}

/** The filter as written to the race file's `chaos.routes` (functions as "function", RegExps as their source). */
export function describeMatch(match: ChaosMatch | undefined): unknown[] {
  if (match === undefined) return ["same-origin /api* or JSON responses"];
  const list = Array.isArray(match) ? (match as readonly (string | RegExp | ChaosMatchFn)[]) : [match as string | RegExp | ChaosMatchFn];
  return list.map((m) => (typeof m === "function" ? "function" : m instanceof RegExp ? String(m) : m));
}

/** The timers the scheduler holds with (the globals by default; a test passes its own). */
export interface ChaosTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realTimers: ChaosTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * Assigns each matched request its key and latency, and holds its delivery: for its own delay, and with `reorder`
 * off also until every earlier matched response was released, so nothing overtakes. `dispose()` releases every
 * hold at once (the page is gone). Never throws.
 */
export class ChaosScheduler {
  private readonly counts = new Map<string, number>();
  private last: Promise<void> = Promise.resolve();
  private readonly pending = new Map<unknown, () => void>();
  private disposed = false;
  /** Every plan made so far, in request order (for the race file and tests). */
  readonly plans: ChaosPlan[] = [];

  constructor(
    readonly chaos: ResolvedChaos,
    private readonly timers: ChaosTimers = realTimers,
  ) {}

  /** The key ("GET /api/search#3": method, path, occurrence in this test) and latency of a matched request. */
  plan(method: string, url: string, sameOrigin = true): ChaosPlan {
    let where: string;
    try {
      const u = new URL(url);
      where = sameOrigin ? u.pathname : `${u.host}${u.pathname}`;
    } catch {
      where = url;
    }
    const sig = `${method.toUpperCase()} ${where}`;
    const n = (this.counts.get(sig) ?? 0) + 1;
    this.counts.set(sig, n);
    const key = `${sig}#${n}`;
    const p = { key, delayMs: delayFor(this.chaos.seed, key, this.chaos.delayMs) };
    this.plans.push(p);
    return p;
  }

  /** Resolves when the response may be delivered. */
  hold(plan: ChaosPlan): Promise<void> {
    const own = this.sleep(plan.delayMs);
    if (this.chaos.reorder) return own;
    const after = this.last;
    const mine = Promise.all([after, own]).then(() => undefined);
    this.last = mine;
    return mine;
  }

  /** Release every held response now and stop the timers. */
  dispose(): void {
    this.disposed = true;
    for (const [id, release] of this.pending) {
      try {
        this.timers.clearTimeout(id);
      } catch {
        /* ignore */
      }
      release();
    }
    this.pending.clear();
  }

  private sleep(ms: number): Promise<void> {
    if (this.disposed || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let id: unknown = null;
      const release = () => {
        if (id !== null) this.pending.delete(id);
        resolve();
      };
      try {
        id = this.timers.setTimeout(release, ms);
        this.pending.set(id, release);
      } catch {
        resolve();
      }
    });
  }
}
