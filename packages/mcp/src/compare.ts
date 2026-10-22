// The explore verdict (docs/runtime/AGENT.md section 5). Runs of the same scenario (the same user actions on the same
// route) differ only in when their responses were delivered. The two fifo runs are the baseline: responses in the
// order their requests started, as on a fast, serial network. Whatever differs between the two baselines is noise and
// is ignored, by shape as well as by value:
//   - a store field whose value differs between the baselines;
//   - the children of a store object whose keys differ between the baselines (new records get new ids on every run):
//     there, records are compared by their values, not by their keys;
//   - a page line whose shape (tokens holding digits blanked: times, counters, ids) differs between the baselines.
// Whatever a seeded run ends with that differs from the baseline beyond that depends on network timing: a race, by
// definition, whatever the app does. A group without two baselines cannot tell noise from a race and gives no verdict.
// No pattern of any kind is matched here.

import type { ActStep, Run, Snapshot } from "./types.js";
import { pathShape, sigOf } from "./text.js";

/** The scenario a run performed: its user actions, in order (typing bursts with their final value). */
export function scenarioOf(run: Run): string {
  const acts = run.steps.filter((s): s is ActStep => s.k === "act");
  return acts.map((a) => `${a.kind} ${a.target ?? ""}${a.value !== undefined ? ` = ${a.value}` : ""}${a.clicks && a.clicks > 1 ? ` ×${a.clicks}` : ""}`).join("\n");
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

export interface GroupReport {
  route: string;
  scenario: string;
  baselines: string[];
  runs: number;
  /** Baseline-vs-baseline differences, ignored as noise. */
  noise: string[];
  diffs: RunDiff[];
  /** No baseline among the runs: nothing to compare with. */
  missingBaseline: boolean;
  /** Only one baseline: noise cannot be told apart, so no verdict (the differences are in `unfiltered`). */
  insufficientBaselines: boolean;
  unfiltered: RunDiff[];
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
 * A snapshot as comparable entries: `state <path>`, `field <label>`, `requests <sig>` → value. Under a noisy parent the
 * records are compared as a multiset of values per blanked path (`state todos.entities.*.title` → sorted values).
 */
function keyed(s: Snapshot | undefined, noisy: Set<string>): Map<string, string> {
  const m = new Map<string, string>();
  if (!s) return m;
  const pooled = new Map<string, string[]>();
  for (const [k, v] of Object.entries(s.state)) {
    const blank = underNoisy(k, noisy);
    if (blank) {
      const list = pooled.get(blank) ?? [];
      list.push(v);
      pooled.set(blank, list);
    } else m.set(`state ${k}`, v);
  }
  for (const [k, list] of pooled) m.set(`state ${k}`, list.length === 1 ? list[0] : `[${list.sort().join(" | ")}]`);
  for (const [k, v] of Object.entries(s.fields ?? {})) m.set(`field ${k}`, v);
  for (const [k, v] of Object.entries(s.requests)) m.set(`requests ${k}`, String(v));
  return m;
}

function witnessesOf(run: Run): string[] {
  return run.witnesses.map((w) => `${w.kind} ${pathShape(w.subject)} by ${sigOf(w.by)}`);
}

/** Compare a set of runs (one explore session). Groups by route and scenario; each group needs two fifo baselines. */
export function compareRuns(runs: Run[]): GroupReport[] {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    if (!settledAfterActs(r)) continue;
    const k = `${r.page.route}\n${scenarioOf(r)}`;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  const out: GroupReport[] = [];
  for (const [k, g] of groups) {
    const nl = k.indexOf("\n");
    const route = k.slice(0, nl);
    const scenario = k.slice(nl + 1);
    const base = g.filter((r) => r.schedule?.order === "fifo");
    const rest = g.filter((r) => r.schedule?.order !== "fifo");
    const rep: GroupReport = { route, scenario, baselines: base.map((r) => r.id), runs: g.length, noise: [], diffs: [], missingBaseline: base.length === 0, insufficientBaselines: base.length === 1, unfiltered: [] };
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
      for (const [name, v] of bk) if (o.get(name) !== v) noiseName.add(name);
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
    for (const r of rest) {
      const rk = keyed(r.snapshot, noisy);
      const fields: FieldDiff[] = [];
      for (const name of new Set([...bk.keys(), ...rk.keys()])) {
        if (noiseName.has(name)) continue;
        const a = bk.get(name);
        const c = rk.get(name);
        if (a === c) continue;
        const sp = name.indexOf(" ");
        const where = name.slice(0, sp) === "state" ? "state" : name.slice(0, sp) === "field" ? "field" : "requests";
        fields.push({ where, name: name.slice(sp + 1), baseline: a ?? "(absent)", run: c ?? "(absent)" });
      }
      const rt = multiset(r.snapshot?.text ?? []);
      const textOnlyBaseline = onlyIn(bt, rt).filter((l) => !isNoiseLine(l));
      const textOnlyRun = onlyIn(rt, bt).filter((l) => !isNoiseLine(l));
      const errors = [...new Set(r.errors.map((e) => e.message))].filter((m) => !baseErrors.has(m));
      const witnesses = [...new Set(witnessesOf(r))].filter((w) => !baseWit.has(w));
      if (fields.length || textOnlyBaseline.length || textOnlyRun.length || errors.length || witnesses.length) {
        const d: RunDiff = { run: r.id, label: r.assignment?.label ?? r.schedule?.label ?? r.id, fields: fields.slice(0, 30), textOnlyBaseline: textOnlyBaseline.slice(0, 15), textOnlyRun: textOnlyRun.slice(0, 15), errors: errors.slice(0, 10), witnesses: witnesses.slice(0, 10), forced: r.forced };
        (rep.insufficientBaselines ? rep.unfiltered : rep.diffs).push(d);
      }
    }
    out.push(rep);
  }
  return out;
}
