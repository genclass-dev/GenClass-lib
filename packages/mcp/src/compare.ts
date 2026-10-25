// The explore verdict (docs/runtime/AGENT.md section 5). Runs of the same scenario (the same user actions on the same
// route) differ only in when their responses were delivered. The two fifo runs are the baseline: responses in the
// order their requests started, as on a fast, serial network. Whatever differs between the two baselines is noise and
// is ignored, by shape as well as by value:
//   - a store field whose value differs between the baselines;
//   - the children of a store object whose keys differ between the baselines (new records get new ids on every run):
//     there, records are compared by their values, not by their keys;
//   - a page line whose shape (tokens holding digits blanked: times, counters, ids) differs between the baselines.
// A value the runtime redacted ("[redacted]") equals any value: whether an opaque id is redacted depends on the id
// itself, so a redaction is never a difference.
//
// Whatever a seeded run ends with that differs from the baseline beyond that depends on network timing. It is sorted by
// where the difference shows, from the evidence the run recorded:
//   visible    what the page shows (its text, its form values), the requests it sent, or an error only it had: a race;
//   internal   store values only, while the page showed the same as the baseline: reported apart, never as a race
//              (a cache's bookkeeping, such as request ids and lists of cache keys, depends on arrival order by
//              construction and never reaches the page);
//   transient  the same final state, but an older response overwrote newer data along the way (a later response
//              repaired it): reported apart, never as a race.
// Scenarios are grouped by their recorded actions: element names with digits blanked and parenthesised counts dropped,
// consecutive typing into one field as one burst; when that leaves reordered runs without two baselines to compare
// with (a label that changed with the order), by action kinds and element roles, then by action kinds alone. A group
// without two baselines cannot tell noise from a race and gives no verdict. No pattern of any kind is matched here.

import type { ActStep, Run, Snapshot } from "./types.js";
import { pathShape, sigOf } from "./text.js";

/** The runtime's redaction placeholder (packages/runtime/src/util.ts REDACTED). */
export const REDACTED = "[redacted]";

/** How a session's runs were grouped: by element names, by action kinds and element roles, or by action kinds only. */
export type Grouping = "names" | "roles" | "kinds";
const GROUPINGS: Grouping[] = ["names", "roles", "kinds"];

/** Where a seeded run's difference from the baseline shows (see the header). */
export type Tier = "visible" | "internal" | "transient";

const blankDigits = (s: string): string => s.replace(/\d+/g, "N");

/** Tags whose ARIA role is "generic": which of them takes a click can depend on what the page rendered first. */
const GENERIC = new Set(["div", "span", "b", "i", "u", "s", "small", "bdi", "bdo", "samp", "data"]);

/** A target's name for grouping: parenthesised counts dropped ('combobox "author (1)"' → 'combobox "author"'), digits blanked. */
function targetName(t: string | undefined): string {
  return blankDigits((t ?? "").replace(/\s*\(\d+\)/g, "")).trim();
}

/** A target's role: 'button "Save"' → button; a generic container (div, span, ...) → element. */
function targetRole(t: string | undefined): string {
  const role = (t ?? "").split(/[\s"]/)[0] ?? "";
  return GENERIC.has(role) ? "element" : role;
}

/** One action as a scenario line at a grouping level. */
function actLine(a: ActStep, level: Grouping | "exact"): string {
  const clicks = a.clicks && a.clicks > 1 ? ` ×${a.clicks}` : "";
  if (level === "exact") return `${a.kind} ${a.target ?? ""}${a.value !== undefined ? ` = ${a.value}` : ""}${clicks}`;
  if (level === "names") return `${a.kind} ${targetName(a.target)}${a.value !== undefined ? ` = ${blankDigits(a.value)}` : ""}${clicks}`;
  if (level === "roles") return `${a.kind} ${targetRole(a.target)}${clicks}`;
  return `${a.kind}${clicks}`;
}

/**
 * The scenario a run performed: its user actions, in order (typing bursts with their final value). `exact` is the
 * recorded text; the other levels are what explore groups by: consecutive typing into the same field (at that level)
 * is one burst, so a burst the recording split when the field's label changed under it is one action again.
 */
export function scenarioOf(run: Run, level: Grouping | "exact" = "exact"): string {
  const acts = run.steps.filter((s): s is ActStep => s.k === "act");
  const out: string[] = [];
  let prevType: string | null = null;
  for (const a of acts) {
    const line = actLine(a, level);
    if (level !== "exact" && a.kind === "type") {
      const field = actLine({ ...a, value: undefined }, level);
      if (prevType === field) {
        out[out.length - 1] = line;
        continue;
      }
      prevType = field;
    } else prevType = null;
    out.push(line);
  }
  return out.join("\n");
}

/** Two runs did the same steps: the same actions by name, or (a label that changed with the order) by kind and role. */
export function sameScenario(a: Run, b: Run): boolean {
  return scenarioOf(a, "names") === scenarioOf(b, "names") || scenarioOf(a, "roles") === scenarioOf(b, "roles");
}

/**
 * Two recorded values are equal, a redaction being equal to anything: "[redacted]" against any value, or a summary
 * with "[redacted]" inside it against one with any text in its place ('{id: 1, token: [redacted]}').
 */
export function sameValue(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return fits(a, b) || fits(b, a);
}

/** One value inside a summary, as describe() writes it: a quoted string, a bare token, or another redaction. */
const ONE_VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|[^,\s{}\[\]]+|\[redacted\])`;

/** `pattern` with its "[redacted]" standing for the whole value, or each one inside it for one value, matches `s`. */
function fits(pattern: string, s: string): boolean {
  if (pattern === REDACTED) return true;
  if (!pattern.includes(REDACTED)) return false;
  const re = new RegExp(`^${pattern.split(REDACTED).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(ONE_VALUE)}$`);
  return re.test(s);
}

/** Two lists of values are the same multiset, a redacted value matching any one value. */
function sameValues(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const rest = [...b];
  const left: string[] = [];
  for (const v of a) {
    const i = rest.indexOf(v);
    if (i >= 0) rest.splice(i, 1);
    else left.push(v);
  }
  for (const v of left) {
    const i = rest.findIndex((w) => sameValue(v, w));
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  return true;
}

export interface FieldDiff {
  where: "state" | "field" | "requests";
  name: string;
  baseline: string;
  run: string;
}

export interface RunDiff {
  run: string;
  label: string;
  /** Where the difference shows: what the page shows or sends (a race), store values only, or along the way only. */
  tier: Tier;
  /** Form values and request counts first (what the page shows and sends), then store values. */
  fields: FieldDiff[];
  /** Page text lines only the baseline shows, and only this run shows. */
  textOnlyBaseline: string[];
  textOnlyRun: string[];
  /** Errors this run had and the baselines did not (by message). */
  errors: string[];
  /** Witnesses this run had and the baselines did not ("overwrote-newer search.results by GET /api/search"). */
  witnesses: string[];
  /** Responses this run delivered only because their hold ran out (it may not have followed its schedule). */
  forced: number;
}

/**
 * The value keyed() gives a state name in a raw snapshot: a "*" segment (records under a noisy parent) pools the
 * matching records' values, sorted and joined, as the comparison did. Undefined when nothing matches.
 */
export function stateValue(state: Record<string, string>, name: string): string | undefined {
  if (!name.split(".").includes("*")) return state[name];
  const re = new RegExp(`^${name.split(".").map((s) => (s === "*" ? "[^.]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\.")}$`);
  const list = Object.entries(state)
    .filter(([k]) => re.test(k))
    .map(([, v]) => v);
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : `[${list.sort().join(" | ")}]`;
}

/** The run's snapshot was taken after its last user action (a final state, not the page as it loaded). */
export function settledAfterActs(r: Run): boolean {
  if (!r.snapshot) return false;
  let last = -Infinity;
  for (const s of r.steps) if (s.k === "act") last = Math.max(last, s.t);
  return r.snapshot.t >= last;
}

/** Did the run end in a different state (not only a witness along the way)? */
export function endedDifferently(d: RunDiff): boolean {
  return d.fields.length > 0 || d.textOnlyBaseline.length > 0 || d.textOnlyRun.length > 0 || d.errors.length > 0;
}

/** Did the difference reach what the page shows or sends (its text, form values, requests) or throw? A race. */
export function visibleDiff(d: Pick<RunDiff, "fields" | "textOnlyBaseline" | "textOnlyRun" | "errors">): boolean {
  return d.fields.some((f) => f.where !== "state") || d.textOnlyBaseline.length > 0 || d.textOnlyRun.length > 0 || d.errors.length > 0;
}

export interface GroupReport {
  route: string;
  /** The scenario as the group's first baseline (else its first run) recorded it. */
  scenario: string;
  /** The scenario at the grouping level: what the group's runs have in common (finding keys use it). */
  scenarioKey: string;
  /** How the session's runs were grouped (the same for every group of a session). */
  grouping: Grouping;
  baselines: string[];
  runs: number;
  /** Reordered runs compared with two baselines (0 without two baselines). */
  compared: number;
  /** Baseline-vs-baseline differences, ignored as noise. */
  noise: string[];
  /** Every reordered run that differed, each with its tier. */
  diffs: RunDiff[];
  /** No baseline among the runs: nothing to compare with. */
  missingBaseline: boolean;
  /** Only one baseline: noise cannot be told apart, so no verdict (the differences are in `unfiltered`). */
  insufficientBaselines: boolean;
  unfiltered: RunDiff[];
  /** Runs whose snapshot left store fields out (its budget), and the most left out of how many. */
  truncated?: { runs: number; left: number; total: number };
}

function multiset(lines: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

function onlyIn(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [l, n] of a) for (let i = b.get(l) ?? 0; i < n; i++) out.push(l);
  return out;
}

/** A page line with tokens that hold a digit blanked: "Order #A7F3KQ placed 12:01:04" → "Order #N placed N". */
export const lineShape = (l: string): string => l.replace(/[\w.:/-]*\d[\w.:/-]*/g, "N");

/** Parents ("todos.entities") whose child keys differ between two key sets (record ids made fresh each run). */
function noisyParents(a: Iterable<string>, b: Iterable<string>): Set<string> {
  const kids = (paths: Iterable<string>) => {
    const m = new Map<string, Set<string>>();
    for (const p of paths) {
      const segs = p.split(".");
      for (let i = 1; i < segs.length; i++) {
        const parent = segs.slice(0, i).join(".");
        let k = m.get(parent);
        if (!k) m.set(parent, (k = new Set()));
        k.add(segs[i]);
      }
    }
    return m;
  };
  const ka = kids(a);
  const kb = kids(b);
  const out = new Set<string>();
  for (const parent of new Set([...ka.keys(), ...kb.keys()])) {
    const x = ka.get(parent);
    const y = kb.get(parent);
    if (!x || !y) continue; // the parent itself is new in one: its own parent is the noisy one
    if (x.size !== y.size || [...x].some((k) => !y.has(k))) out.add(parent);
  }
  // keep the shallowest: under a noisy parent, every deeper key is a record's own
  return new Set([...out].filter((p) => ![...out].some((q) => q !== p && p.startsWith(`${q}.`))));
}

/** A state path under a noisy parent, with the record key blanked: "todos.entities.aK3x.title" → "todos.entities.*.title". */
function underNoisy(path: string, noisy: Set<string>): string | null {
  const segs = path.split(".");
  for (let i = 1; i < segs.length; i++) {
    const parent = segs.slice(0, i).join(".");
    if (noisy.has(parent)) return [...segs.slice(0, i), "*", ...segs.slice(i + 1)].join(".");
  }
  return null;
}

/**
 * A snapshot as comparable entries: `state <path>`, `field <label>`, `requests <sig>` → its values. Under a noisy
 * parent the records are compared as a multiset of values per blanked path (`state todos.entities.*.title`).
 */
function keyed(s: Snapshot | undefined, noisy: Set<string>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!s) return m;
  for (const [k, v] of Object.entries(s.state)) {
    const blank = underNoisy(k, noisy);
    const name = `state ${blank ?? k}`;
    const list = m.get(name);
    if (list) list.push(v);
    else m.set(name, [v]);
  }
  for (const [k, v] of Object.entries(s.fields ?? {})) m.set(`field ${k}`, [v]);
  for (const [k, v] of Object.entries(s.requests)) m.set(`requests ${k}`, [String(v)]);
  return m;
}

/** An entry's values as one string (a pooled multiset sorted and joined, as stateValue() reads it back). */
const shown = (v: string[] | undefined): string => (!v ? "(absent)" : v.length === 1 ? v[0] : `[${[...v].sort().join(" | ")}]`);

function witnessesOf(run: Run): string[] {
  return run.witnesses.map((w) => `${w.kind} ${pathShape(w.subject)} by ${sigOf(w.by)}`);
}

/** Group runs by route and the scenario at one level; only runs whose snapshot came after their steps. */
function groupAt(runs: Run[], level: Grouping): Map<string, Run[]> {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const k = `${r.page.route}\n${scenarioOf(r, level)}`;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  return groups;
}

const isBaseline = (r: Run): boolean => r.schedule?.order === "fifo";

/** Reordered runs that share a group with two baselines (the ones a verdict can be given for). */
function comparable(groups: Map<string, Run[]>): number {
  let n = 0;
  for (const g of groups.values()) if (g.filter(isBaseline).length >= 2) n += g.filter((r) => !isBaseline(r)).length;
  return n;
}

/**
 * Group a session's runs: the finest level that compares as many reordered runs with two baselines as any level does
 * (a label that changed with the response order splits the runs by name, not by kind and role).
 */
export function groupRuns(runs: Run[]): { grouping: Grouping; groups: Map<string, Run[]> } {
  const settled = runs.filter(settledAfterActs);
  const levels = GROUPINGS.map((level) => ({ level, groups: groupAt(settled, level) }));
  const best = Math.max(...levels.map((l) => comparable(l.groups)));
  const pick = levels.find((l) => comparable(l.groups) === best) ?? levels[0];
  return { grouping: pick.level, groups: pick.groups };
}

/** Compare a set of runs (one explore session). Groups by route and scenario; each group needs two fifo baselines. */
export function compareRuns(runs: Run[]): GroupReport[] {
  const { grouping, groups } = groupRuns(runs);
  const out: GroupReport[] = [];
  for (const g of groups.values()) {
    const route = g[0].page.route;
    const base = g.filter(isBaseline);
    const rest = g.filter((r) => !isBaseline(r));
    const scenario = scenarioOf(base[0] ?? g[0]);
    const rep: GroupReport = { route, scenario, scenarioKey: scenarioOf(base[0] ?? g[0], grouping), grouping, baselines: base.map((r) => r.id), runs: g.length, compared: base.length >= 2 ? rest.length : 0, noise: [], diffs: [], missingBaseline: base.length === 0, insufficientBaselines: base.length === 1, unfiltered: [] };
    const cut = g.filter((r) => (r.snapshot?.stateLeft ?? 0) > 0);
    if (cut.length) rep.truncated = { runs: cut.length, left: Math.max(...cut.map((r) => r.snapshot!.stateLeft!)), total: Math.max(...cut.map((r) => r.snapshot!.stateTotal ?? 0)) };
    if (!base.length) {
      out.push(rep);
      continue;
    }
    const b0 = base[0];
    // record ids that differ between the baselines (and, with one baseline, between it and nothing: none)
    const noisy = new Set<string>();
    for (const b of base.slice(1)) for (const p of noisyParents(Object.keys(b0.snapshot?.state ?? {}), Object.keys(b.snapshot?.state ?? {}))) noisy.add(p);
    const bk = keyed(b0.snapshot, noisy);
    const bt = multiset(b0.snapshot?.text ?? []);
    const noise = new Set<string>([...noisy].map((p) => `state ${p}.* (record ids)`));
    const noiseName = new Set<string>();
    const noiseShape = new Set<string>();
    for (const b of base.slice(1)) {
      const o = keyed(b.snapshot, noisy);
      for (const [name, v] of bk) {
        const w = o.get(name);
        if (!w || !sameValues(v, w)) noiseName.add(name);
      }
      for (const name of o.keys()) if (!bk.has(name)) noiseName.add(name);
      const ot = multiset(b.snapshot?.text ?? []);
      for (const l of [...onlyIn(bt, ot), ...onlyIn(ot, bt)]) noiseShape.add(lineShape(l));
    }
    for (const n of noiseName) noise.add(n);
    for (const s of noiseShape) noise.add(`text ${JSON.stringify(s)}`);
    rep.noise = [...noise].slice(0, 40);
    const isNoiseLine = (l: string) => noiseShape.has(lineShape(l));
    const baseErrors = new Set(base.flatMap((b) => b.errors.map((e) => e.message)));
    const baseWit = new Set(base.flatMap(witnessesOf));
    const baseCut = (b0.snapshot?.stateLeft ?? 0) > 0;
    for (const r of rest) {
      const rk = keyed(r.snapshot, noisy);
      const runCut = (r.snapshot?.stateLeft ?? 0) > 0;
      const fields: FieldDiff[] = [];
      for (const name of new Set([...bk.keys(), ...rk.keys()])) {
        if (noiseName.has(name)) continue;
        const a = bk.get(name);
        const c = rk.get(name);
        if (a && c && sameValues(a, c)) continue;
        const sp = name.indexOf(" ");
        const where = name.slice(0, sp) === "state" ? "state" : name.slice(0, sp) === "field" ? "field" : "requests";
        // a store field missing from a snapshot that left fields out was not compared, not lost
        if (where === "state" && ((!a && baseCut) || (!c && runCut))) continue;
        fields.push({ where, name: name.slice(sp + 1), baseline: shown(a), run: shown(c) });
      }
      fields.sort((x, y) => Number(x.where === "state") - Number(y.where === "state"));
      const rt = multiset(r.snapshot?.text ?? []);
      const textOnlyBaseline = onlyIn(bt, rt).filter((l) => !isNoiseLine(l));
      const textOnlyRun = onlyIn(rt, bt).filter((l) => !isNoiseLine(l));
      const errors = [...new Set(r.errors.map((e) => e.message))].filter((m) => !baseErrors.has(m));
      const witnesses = [...new Set(witnessesOf(r))].filter((w) => !baseWit.has(w));
      if (fields.length || textOnlyBaseline.length || textOnlyRun.length || errors.length || witnesses.length) {
        const parts = { fields, textOnlyBaseline, textOnlyRun, errors };
        const tier: Tier = visibleDiff(parts) ? "visible" : fields.length ? "internal" : "transient";
        const d: RunDiff = { run: r.id, label: r.assignment?.label ?? r.schedule?.label ?? r.id, tier, fields: fields.slice(0, 30), textOnlyBaseline: textOnlyBaseline.slice(0, 15), textOnlyRun: textOnlyRun.slice(0, 15), errors: errors.slice(0, 10), witnesses: witnesses.slice(0, 10), forced: r.forced };
        (rep.insufficientBaselines ? rep.unfiltered : rep.diffs).push(d);
      }
    }
    out.push(rep);
  }
  return out;
}
