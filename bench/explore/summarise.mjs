// Scores explore's verdicts against a DOM oracle, per reordered run and per session (docs/runtime/RESULTS.md, the
// agent section). Reads a directory of explore sessions written by a hunt harness (docs/adoption/hunts/strapi/hunt.mjs
// on the claude/dazzling-cray-8tqzkn branch, or bench/explore/apps.mjs): per session `<scenario>-<slow_ms>.json` (the
// report as the agent read it, and each load's DOM oracle with its bridge run id) and `state-<scenario>-<slow_ms>/`
// (the bridge's state: every recorded run). Each session's runs are compared again with this checkout's comparison
// (packages/mcp/dist) and, with --old <dist>, with another one (the comparison before this change), so both are scored
// on the same recorded runs.
//
//   node bench/explore/summarise.mjs <dir> [--old <path to an older packages/mcp/dist>] [--json <file>]
//
// A reordered run "differs" when its DOM oracle equals neither baseline's (a title the scenario makes unique per run
// has its digits blanked). A run explore "reports" is one in a group with two baselines whose difference reaches the
// race verdict: any difference for the old comparison (it reported every one as "RACE"), the visible tier for the new.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const dir = args[0];
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!dir) throw new Error("usage: summarise.mjs <dir> [--old <mcp dist>] [--json <file>]");
const here = new URL(".", import.meta.url);
const cur = await import(new URL("../../packages/mcp/dist/index.js", here).href);
const old = opt("--old") ? await import(pathToFileURL(resolve(opt("--old"), "index.js")).href) : null;

// a title the scenario makes unique per run has its digits blanked; notifications (toasts that disappear after a few
// seconds) are left out: whether one is still shown at the quiet point depends on timing, not on the order
const key = (o) => JSON.stringify(o ?? null, (k, v) => (k === "notifications" ? undefined : k === "title" && typeof v === "string" ? v.replace(/\d+/g, "N") : v));

const settled = (r) => !!r.snapshot && r.snapshot.t >= Math.max(-Infinity, ...r.steps.filter((x) => x.k === "act").map((x) => x.t));

/** The runs of each group, in the order compareRuns reports the groups (the new comparison exports its grouping). */
function groupsOf(impl, runs) {
  if (impl.groupRuns) return [...impl.groupRuns(runs).groups.values()];
  const m = new Map();
  for (const r of runs.filter(settled)) {
    const k = `${r.page.route}\n${impl.scenarioOf(r)}`;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.values()];
}

/** Per reordered run: compared with two baselines, reported as a race, and its tier. `isNew`: only the visible tier is a race. */
function score(impl, runs, isNew) {
  const out = new Map();
  const reports = impl.compareRuns(runs);
  const groups = groupsOf(impl, runs);
  reports.forEach((g, i) => {
    const two = g.baselines.length >= 2;
    const diffs = new Map(g.diffs.concat(g.unfiltered ?? []).map((d) => [d.run, d]));
    for (const r of groups[i] ?? []) {
      if (r.schedule?.order === "fifo") continue;
      const d = diffs.get(r.id);
      const tier = !d ? "same" : d.tier ?? (d.fields.length || d.textOnlyBaseline.length || d.textOnlyRun.length || d.errors.length ? "ended differently" : "witness only");
      out.set(r.id, { compared: two, reported: two && !!d && (!isNew || d.tier === "visible"), tier, grouping: g.grouping });
    }
  });
  return out;
}

const rows = [];
for (const f of readdirSync(dir).filter((x) => /^[a-z-]+-\d+(-[a-z]+)?\.json$/.test(x)).sort()) {
  const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const tag = f.replace(/\.json$/, "");
  const stateFile = join(dir, `state-${tag}`, "state.json");
  if (!existsSync(stateFile)) continue;
  const st = JSON.parse(readFileSync(stateFile, "utf8"));
  const byId = new Map(st.runs.map((r) => [r.id, r]));
  const x = st.explores.find((e) => e.runs.length) ?? st.explores[0];
  const runs = x.runs.map((id) => byId.get(id)).filter(Boolean);
  // the DOM oracle per run (the harness's own check, secondary)
  const oracle = new Map((d.loads ?? []).filter((l) => l.run).map((l) => [l.run, l]));
  const baseKeys = new Set((d.loads ?? []).filter((l) => l.schedule?.order === "fifo").map((l) => key(l.oracle)));
  const seeded = runs.filter((r) => r.schedule?.order !== "fifo");
  const truth = new Map(seeded.map((r) => [r.id, oracle.has(r.id) ? !baseKeys.has(key(oracle.get(r.id).oracle)) : null]));
  const sNew = score(cur, runs, true);
  const sOld = old ? score(old, runs, false) : null;
  const tally = (s) => {
    if (!s) return null;
    let compared = 0, reported = 0, tp = 0, fp = 0, fn = 0;
    const tiers = {};
    for (const r of seeded) {
      const v = s.get(r.id) ?? { compared: false, reported: false, tier: "not compared" };
      const t = truth.get(r.id);
      if (v.compared) compared++;
      if (v.reported) reported++;
      if (v.reported && t) tp++;
      if (v.reported && t === false) fp++;
      if (!v.reported && t) fn++;
      const tierName = v.compared ? v.tier : "not compared";
      tiers[tierName] = (tiers[tierName] ?? 0) + 1;
    }
    return { compared, reported, tp, fp, fn, tiers, raceLike: reported > 0, grouping: [...s.values()][0]?.grouping };
  };
  const report = d.report ?? "";
  const reportedLine = report.split("\n").filter((l) => /^(RACE:|No race found|No verdict|Only one baseline|No baseline run|Internal state only|Along the way only|Compared:)/.test(l)).map((l) => l.slice(0, 140));
  rows.push({
    session: tag,
    scenario: d.scenario,
    slow_ms: d.slow_ms,
    seeded: seeded.length,
    domDiffering: [...truth.values()].filter(Boolean).length,
    domUnknown: [...truth.values()].filter((v) => v === null).length,
    forbidden: (d.loads ?? []).filter((l) => l.forbidden && l.schedule?.order === "seeded").length,
    stateFields: Math.max(0, ...runs.map((r) => Object.keys(r.snapshot?.state ?? {}).length)),
    stateLeft: Math.max(0, ...runs.map((r) => r.snapshot?.stateLeft ?? 0)),
    asReported: { raceLike: /RACE:/.test(report), lines: reportedLine },
    // findings in the session's bridge state: race findings (what the agent is told to fix) and the stale-write
    // findings each overwrote-newer witness makes on its own
    raceFindings: st.findings.filter((f) => f.kind === "race").length,
    staleWriteFindings: st.findings.filter((f) => f.kind === "stale-write").length,
    witnessesPerRun: runs.length ? Math.round(runs.reduce((n, r) => n + r.witnesses.length, 0) / runs.length) : 0,
    replay: d.replay ? (/REPRODUCED/.test(d.replay.result) ? "reproduced" : /not reproduced/.test(d.replay.result) ? "not reproduced" : "inconclusive") : null,
    new: tally(sNew),
    old: tally(sOld),
  });
}
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(rows, null, 2));
const cell = (t) => (t ? `${t.reported} of ${t.compared} (${t.tp} true, ${t.fp} false, ${t.fn} missed)` : "");
console.log(`| session | seeded | DOM oracle differing | as reported | ${old ? "old comparison: reported of compared | " : ""}new comparison: reported of compared | new tiers |`);
console.log(`|---|---|---|---|${old ? "---|" : ""}---|---|`);
for (const r of rows) console.log(`| ${r.session} | ${r.seeded} | ${r.domDiffering}${r.domUnknown ? ` (+${r.domUnknown} unknown)` : ""} | ${r.asReported.raceLike ? "race" : r.asReported.lines.find((l) => /^No race found/.test(l)) ? "no race" : "no verdict"} | ${old ? `${cell(r.old)} | ` : ""}${cell(r.new)} | ${Object.entries(r.new.tiers).map(([k, v]) => `${k} ${v}`).join(", ")} |`);
