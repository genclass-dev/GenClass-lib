// The explore verdict (docs/runtime/AGENT.md section 5). Runs of the same scenario (the same user actions on the same
// route) differ only in when their responses were delivered. What a run records of its actions can depend on that
// timing too (a label that shows a count once a response lands, a sorted header drawn in another element, a value typed
// with a counter), so the scenario is a normalised fingerprint, and runs whose names still differ are grouped by their
// action kinds and element roles in order (listed as variants). The two fifo runs are the baseline: responses in the
// order their requests started, as on a fast, serial network. Whatever differs between the two baselines is noise and
// is ignored, by shape as well as by value:
//   - a store field whose value differs between the baselines;
//   - the children of a store object whose keys differ between the baselines (new records get new ids on every run):
//     there, records are compared by their values, not by their keys;
//   - a page line whose shape (tokens holding digits blanked: times, counters, ids) differs between the baselines.
// Whatever a seeded run ends with that differs from the baseline beyond that depends on network timing: a race, by
// definition, whatever the app does. A group without two baselines cannot tell noise from a race and gives no verdict.
// No pattern of any kind is matched here.

import type { Run, Snapshot } from "./types.js";
import { parseTarget } from "./testgen.js";
import { pathShape, sigOf } from "./text.js";

/** A user action as the fingerprints see it. */
interface Act {
  kind: string;
  /** The element description with a trailing count dropped from its name: 'combobox "author"'. */
  target: string;
  role: string;
  /** The typed or chosen value with tokens holding a digit blanked. */
  value?: string;
  clicks: number;
}

/** Tags the runtime names an element by when it has no role of its own: their ARIA role is generic, one role here. */
const GENERIC = new Set(["generic", "div", "span", "b", "i", "u", "small", "bdi", "bdo", "data", "pre", "q", "samp"]);

/**
 * A run's user actions, normalised: a name's trailing count dropped ('combobox "author (1)"' → 'combobox "author"'),
 * digits blanked in values ("Post 17" → "Post N", as lineShape), and consecutive typing bursts on the same field
 * merged into one with the final value (the runtime starts a new burst when the field's description changes).
 */
function actsOf(run: Run): Act[] {
  const out: Act[] = [];
  for (const a of run.steps) {
    if (a.k !== "act") continue;
    const { role, name: full } = parseTarget(a.target);
    // a name that is only a count keeps it
    const name = full?.replace(/\s*\(\d[\d,.]*\)$/, "") || full;
    const target = name !== undefined ? `${role} "${name}"` : role;
    const value = a.value !== undefined ? lineShape(a.value) : undefined;
    const prev = out[out.length - 1];
    if (a.kind === "type" && prev?.kind === "type" && prev.target === target) {
      if (value !== undefined) prev.value = value;
      continue;
    }
    out.push({ kind: a.kind, target, role, ...(value !== undefined ? { value } : {}), clicks: a.clicks ?? 1 });
  }
  return out;
}

/**
 * The scenario a run performed: its user actions, in order (typing bursts with their final value), normalised so that
 * what the response order changes in an element's name or a typed counter does not make two runs different scenarios.
 */
export function scenarioOf(run: Run): string {
  return actsOf(run)
    .map((a) => `${a.kind} ${a.target}${a.value !== undefined ? ` = ${a.value}` : ""}${a.clicks > 1 ? ` ×${a.clicks}` : ""}`)
    .join("\n");
}

/** The fallback fingerprint: action kinds and element roles in order ("click generic", "type combobox"). */
export function scenarioShapeOf(run: Run): string {
  return actsOf(run)
    .map((a) => `${a.kind} ${GENERIC.has(a.role) ? "generic" : a.role}${a.clicks > 1 ? ` ×${a.clicks}` : ""}`)
    .join("\n");
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
  /** The first baseline's scenario (the first run's when there is no baseline). */
  scenario: string;
  /** Runs in the group whose scenario still differs from `scenario` (grouped by action kinds and element roles). */
  variants: { scenario: string; runs: string[] }[];
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

/**
 * Compare a set of runs (one explore session). Groups by route and scenario, falling back to action kinds and element
 * roles when names still differ (a run of the same steps whose element names differ is compared with the baselines,
 * and listed as a variant); each group needs two fifo baselines.
 */
export function compareRuns(runs: Run[]): GroupReport[] {
  const groups = new Map<string, Run[]>();
  const scenarios = new Map<Run, string>();
  for (const r of runs) {
    if (!settledAfterActs(r)) continue;
    scenarios.set(r, scenarioOf(r));
    const k = `${r.page.route}\n${scenarioShapeOf(r)}`;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  const out: GroupReport[] = [];
  for (const [k, g] of groups) {
    const route = k.slice(0, k.indexOf("\n"));
    const base = g.filter((r) => r.schedule?.order === "fifo");
    const rest = g.filter((r) => r.schedule?.order !== "fifo");
    const scenario = scenarios.get(base[0] ?? g[0]) ?? "";
    const variants = new Map<string, string[]>();
    for (const r of g) {
      const s = scenarios.get(r) ?? "";
      if (s !== scenario) variants.set(s, [...(variants.get(s) ?? []), r.id]);
    }
    const rep: GroupReport = { route, scenario, variants: [...variants].map(([s, ids]) => ({ scenario: s, runs: ids })), baselines: base.map((r) => r.id), runs: g.length, noise: [], diffs: [], missingBaseline: base.length === 0, insufficientBaselines: base.length === 1, unfiltered: [] };
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
