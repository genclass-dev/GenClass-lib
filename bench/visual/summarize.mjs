#!/usr/bin/env node
// Reduces the visual bench's run files (run.mjs output, one per CI job) to the numbers the repository keeps
// (docs/runtime/VISUAL.md section 15, docs/runtime/RESULTS.md section 9):
//
//   node bench/visual/summarize.mjs <dir with *.json, searched recursively> [--labels bench/visual/labels.json]
//        [--site-verdicts <file outside the repo>] [--out summary.json] [--md summary.md] [--detail detail.md]
//
// summary.json and summary.md hold counts per check kind only. Public sites are never named there: their findings are
// counted per kind and configuration, and verdicts come from --site-verdicts, a file kept with the CI artifact and
// never committed. detail.md lists every finding with its page, message and crop file, for a person to inspect; it
// names public sites and belongs in the CI artifact only.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DIR = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--")) ?? ".";
const LABELS = opt("labels", null);
const VERDICTS = opt("site-verdicts", null);
const OUT = opt("out", "summary.json");
const MD = opt("md", null);
const DETAIL = opt("detail", null);

function files(d) {
  const out = [];
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (n.endsWith(".json") && !n.startsWith("summary")) out.push(p);
  }
  return out;
}

const runs = files(DIR)
  .map((f) => {
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      return Array.isArray(j.loads) ? j : null;
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const loads = runs.flatMap((r) => r.loads.map((l) => ({ ...l, group: l.group ?? r.group })));
const labels = LABELS ? JSON.parse(readFileSync(LABELS, "utf8")).labels ?? [] : [];
const verdicts = VERDICTS ? JSON.parse(readFileSync(VERDICTS, "utf8")).verdicts ?? [] : [];

const inc = (o, k, n = 1) => void (o[k] = (o[k] ?? 0) + n);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** A label for a finding on a local page: page + kind (+ selector, viewport, scheme when given). */
function labelOf(l, f) {
  return labels.find((x) => x.page === l.page && x.kind === f.kind && (!x.selector || x.selector === f.selector) && (!x.viewport || x.viewport === l.viewport) && (!x.scheme || x.scheme === l.scheme));
}
function verdictOf(l, f) {
  return verdicts.find((x) => x.page === l.page && x.kind === f.kind && (!x.selector || x.selector === f.selector) && (!x.viewport || x.viewport === l.viewport) && (!x.scheme || x.scheme === l.scheme));
}

const summary = { at: new Date().toISOString(), commits: [...new Set(runs.map((r) => r.commit).filter(Boolean))], runs: [...new Set(runs.map((r) => r.run).filter(Boolean))], chromium: [...new Set(runs.map((r) => r.chromium))], clean: {}, sites: null, recall: null, cost: null, integration: null };
const detail = [];

// ------------------------------------------------------------------------------------- clean local pages
for (const group of ["demos", "templates", "compat"]) {
  const ls = loads.filter((l) => l.group === group && l.part === "clean");
  if (!ls.length) continue;
  const m = ls.filter((l) => l.measured);
  const g = { pages: new Set(ls.map((l) => l.page)).size, loads: ls.length, measured: m.length, notMeasured: {}, findings: 0, byKind: {}, real: 0, falseReports: 0, unlabelled: 0, falseByKind: {}, fixesApplied: 0, falseFixes: 0, perConfig: {} };
  for (const l of ls) if (!l.measured) inc(g.notMeasured, l.notMeasured);
  for (const l of m) {
    const cfg = `${l.viewport} ${l.scheme}`;
    g.perConfig[cfg] ??= { loads: 0, findings: 0 };
    g.perConfig[cfg].loads++;
    for (const f of l.findings) {
      g.findings++;
      g.perConfig[cfg].findings++;
      inc(g.byKind, f.kind);
      const lab = labelOf(l, f);
      if (lab?.verdict === "real") g.real++;
      else {
        if (lab?.verdict === "false") g.falseReports++;
        else g.unlabelled++;
        inc(g.falseByKind, f.kind);
        if (f.fix?.applied) g.falseFixes++;
      }
      if (f.fix?.applied) g.fixesApplied++;
      detail.push({ group, page: l.page, cfg, kind: f.kind, selector: f.selector, message: f.message, crop: f.crop, label: lab?.verdict ?? "unlabelled", note: lab?.note });
    }
  }
  // unlabelled findings are presumed false (VISUAL.md 15): they count in the false-report rate
  g.falsePerPageView = m.length ? Math.round(((g.falseReports + g.unlabelled) / m.length) * 1000) / 1000 : null;
  summary.clean[group] = g;
}

// ------------------------------------------------------------------------------------------- public sites
{
  const ls = loads.filter((l) => l.group === "sites");
  if (ls.length) {
    const counted = ls.filter((l) => l.measured && (l.scheme === "light" || l.darkDesign));
    const s = {
      sites: new Set(ls.map((l) => l.page)).size,
      sitesMeasured: new Set(counted.map((l) => l.page)).size,
      loads: ls.length,
      loadsCounted: counted.length,
      notMeasured: {},
      darkDropped: ls.filter((l) => l.measured && l.scheme === "dark" && !l.darkDesign).length,
      perConfig: {},
      findings: 0,
      loadsWithFindings: 0,
      sitesWithFindings: 0,
      byKind: {},
      verdicts: { real: 0, checkError: 0, unconfirmed: 0 },
      verdictsByKind: {},
    };
    const nm = {};
    for (const l of ls) if (!l.measured) inc(nm, String(l.notMeasured).replace(/\(.*\)/, "").replace(/HTTP \d+/, "HTTP error").trim());
    s.notMeasured = nm;
    const withF = new Set();
    for (const l of counted) {
      const cfg = `${l.viewport} ${l.scheme}`;
      s.perConfig[cfg] ??= { loads: 0, findings: 0 };
      s.perConfig[cfg].loads++;
      if (l.findings.length) {
        s.loadsWithFindings++;
        withF.add(l.page);
      }
      for (const f of l.findings) {
        s.findings++;
        s.perConfig[cfg].findings++;
        inc(s.byKind, f.kind);
        const v = verdictOf(l, f)?.verdict;
        const key = v === "real" ? "real" : v === "check-error" ? "checkError" : "unconfirmed";
        s.verdicts[key]++;
        s.verdictsByKind[f.kind] ??= { real: 0, checkError: 0, unconfirmed: 0 };
        s.verdictsByKind[f.kind][key]++;
        detail.push({ group: "sites", page: l.page, url: l.url, cfg, kind: f.kind, selector: f.selector, message: f.message, crop: f.crop, view: l.view, label: v ?? "unlabelled" });
      }
    }
    s.sitesWithFindings = withF.size;
    s.findingsPerLoad = counted.length ? Math.round((s.findings / counted.length) * 1000) / 1000 : null;
    s.findingsPer10Sites = s.sitesMeasured ? Math.round((s.findings / s.sitesMeasured) * 100) / 10 : null;
    summary.sites = s;
  }
}

// ------------------------------------------------------------------------------------------------ recall
{
  const ls = loads.filter((l) => l.part === "faults");
  if (ls.length) {
    const byKind = {};
    const notApplicable = {};
    let collateral = 0;
    let collateralNew = 0;
    const cleanSet = new Set(loads.filter((l) => l.part === "clean" && l.measured).flatMap((l) => l.findings.map((f) => `${l.page}|${l.viewport}|${f.kind}|${f.selector}`)));
    for (const l of ls) {
      if (!l.measured) {
        inc(notApplicable, `load not measured: ${String(l.notMeasured).slice(0, 60)}`);
        continue;
      }
      for (const p of l.planted) {
        const k = (byKind[p.kind] ??= { planted: 0, took: 0, found: 0, desktop: { took: 0, found: 0 }, phone: { took: 0, found: 0 }, fix: { held: 0, undone: 0, notApplied: 0 }, missed: [] });
        k.planted++;
        if (!p.ok) {
          inc(notApplicable, `${p.kind}: ${p.reason}`);
          continue;
        }
        if (!p.truth?.ok) {
          inc(notApplicable, `${p.kind}: ${p.truth?.why ?? "no truth"}`);
          continue;
        }
        k.took++;
        k[l.viewport].took++;
        if (p.detected) {
          k.found++;
          k[l.viewport].found++;
        } else k.missed.push(`${l.page} ${l.viewport}`);
        if (p.fix === "held") k.fix.held++;
        else if (p.fix === "undone") k.fix.undone++;
        else if (p.fix === "not applied") k.fix.notApplied++;
      }
      for (const c of l.collateral ?? []) {
        collateral++;
        if (!cleanSet.has(`${l.page}|${l.viewport}|${c.kind}|${c.selector}`)) collateralNew++;
      }
    }
    for (const k of Object.values(byKind)) {
      k.recall = k.took ? Math.round((k.found / k.took) * 1000) / 1000 : null;
      if (!k.fix.held && !k.fix.undone && !k.fix.notApplied) delete k.fix;
      k.missed = k.missed.slice(0, 20);
    }
    const loadsM = ls.filter((l) => l.measured);
    summary.recall = { loads: ls.length, measured: loadsM.length, byKind, notApplicable, otherFindings: collateral, otherFindingsNotOnCleanPage: collateralNew };
  }
}

// --------------------------------------------------------------------------------------------------- cost
{
  const one = loads.filter((l) => l.part === "clean" && l.measured && l.group !== "sites" && l.firstPass);
  const four = loads.filter((l) => l.part === "cost" && l.measured && l.firstPass);
  const sites = loads.filter((l) => l.group === "sites" && l.measured && l.firstPass);
  const stat = (ls) =>
    ls.length
      ? {
          loads: ls.length,
          firstPassMs: { p50: r1(q(ls.map((l) => l.firstPass.ms), 0.5)), p95: r1(q(ls.map((l) => l.firstPass.ms), 0.95)), max: r1(Math.max(...ls.map((l) => l.firstPass.ms))) },
          firstPassWithinBudget: pct(ls.filter((l) => !l.firstPass.partial).length, ls.length),
          maxSliceMs: { p50: r1(q(ls.map((l) => l.firstPass.maxSliceMs), 0.5)), p95: r1(q(ls.map((l) => l.firstPass.maxSliceMs), 0.95)), max: r1(Math.max(...ls.map((l) => l.firstPass.maxSliceMs))) },
          elements: { p50: q(ls.map((l) => l.firstPass.elements), 0.5), max: Math.max(...ls.map((l) => l.firstPass.elements)) },
          sessionMs: { p50: r1(q(ls.map((l) => l.summary?.ms ?? 0), 0.5)), p95: r1(q(ls.map((l) => l.summary?.ms ?? 0), 0.95)) },
        }
      : null;
  summary.cost = { local1x: stat(one), local4x: stat(four), sites1x: stat(sites) };
}

// -------------------------------------------------------------------------------------------- integration
{
  const ls = loads.filter((l) => l.part === "integration");
  if (ls.length) {
    const m = ls.filter((l) => l.measured);
    summary.integration = {
      loads: ls.length,
      measured: m.length,
      afterLoadMs: { p50: q(m.map((l) => l.firstPassAtMs - l.loadEventMs), 0.5), max: m.length ? Math.max(...m.map((l) => l.firstPassAtMs - l.loadEventMs)) : null },
      chunkAfterLoadMs: { p50: q(m.filter((l) => l.chunkRequestMs != null).map((l) => l.chunkRequestMs - l.loadEventMs), 0.5) },
      chunkBytes: q(m.map((l) => l.chunkBytes).filter(Boolean), 0.5),
      findings: m.reduce((a, l) => a + (l.checks?.length ?? 0), 0),
      byKind: m.reduce((o, l) => {
        for (const c of l.checks ?? []) inc(o, c.kind);
        return o;
      }, {}),
      notMeasured: ls.filter((l) => !l.measured).map((l) => l.notMeasured),
    };
  }
}

writeFileSync(OUT, JSON.stringify(summary, null, 2));

// ----------------------------------------------------------------------------------------------- markdown
const lines = [];
const row = (...c) => lines.push(`| ${c.join(" | ")} |`);
lines.push(`# Visual bench summary`, "", `Commits: ${summary.commits.join(", ") || "local"}; Chromium ${summary.chromium.join(", ")}.`, "");
if (Object.keys(summary.clean).length) {
  lines.push("## Clean local pages", "");
  row("group", "pages", "loads measured", "findings", "labelled real", "false or unlabelled", "per page view", "fixes on clean pages");
  row("---", "---", "---", "---", "---", "---", "---", "---");
  for (const [g, s] of Object.entries(summary.clean)) row(g, s.pages, `${s.measured} of ${s.loads}`, s.findings, s.real, s.falseReports + s.unlabelled, s.falsePerPageView, s.fixesApplied);
  lines.push("", `By kind: ${JSON.stringify(Object.fromEntries(Object.entries(summary.clean).map(([g, s]) => [g, s.byKind])))}`, "");
}
if (summary.recall) {
  lines.push("## Recall on planted faults", "");
  row("kind", "planted", "took", "found", "recall", "desktop", "phone", "fix held / undone");
  row("---", "---", "---", "---", "---", "---", "---", "---");
  for (const [k, s] of Object.entries(summary.recall.byKind).sort()) row(k, s.planted, s.took, s.found, s.recall, `${s.desktop.found}/${s.desktop.took}`, `${s.phone.found}/${s.phone.took}`, s.fix ? `${s.fix.held} / ${s.fix.undone}` : "");
  lines.push("", `Other findings on fault loads: ${summary.recall.otherFindings} (${summary.recall.otherFindingsNotOnCleanPage} not seen on the clean load of the same page).`, "");
}
if (summary.sites) {
  const s = summary.sites;
  lines.push("## Public sites (counts per kind only)", "", `${s.sitesMeasured} of ${s.sites} sites measured, ${s.loadsCounted} loads counted (${s.darkDropped} dark loads dropped: no dark design). Findings: ${s.findings} (${s.findingsPerLoad} per load) on ${s.loadsWithFindings} loads; by kind ${JSON.stringify(s.byKind)}; verdicts ${JSON.stringify(s.verdicts)}. Not measured: ${JSON.stringify(s.notMeasured)}.`, "");
}
if (summary.cost) lines.push("## Cost", "", "```json", JSON.stringify(summary.cost, null, 1), "```", "");
if (summary.integration) lines.push("## Real integration (compat apps)", "", "```json", JSON.stringify(summary.integration, null, 1), "```", "");
if (MD) writeFileSync(MD, lines.join("\n"));
if (DETAIL) {
  const d = ["# Visual bench findings (CI artifact only: names public sites)", ""];
  for (const x of detail) d.push(`- [${x.label}] ${x.group} ${x.page} (${x.cfg}) ${x.kind} \`${x.selector}\`${x.crop ? ` crop ${x.crop}` : ""}${x.view ? ` view ${x.view}` : ""}\n  ${x.message}`);
  writeFileSync(DETAIL, d.join("\n"));
}
console.log(lines.join("\n"));
