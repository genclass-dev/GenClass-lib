// Turns the raw runs (results/raw/<condition>/<strategy>-<profile>.json) into results/summary.json and RESULTS.md.
// Generated output only: change this script, not RESULTS.md. Every rate carries its count and a 95% Wilson interval,
// and every GenClass detection rate on the buggy fixes sits next to its false-report rate on the correct ones.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONDITIONS, PROFILES, QUERIES, RACE_DIAGNOSES, SETTLE_CAP_MS, SETTLE_QUIET_MS, STRATEGIES, USER } from "./lib/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// `node report.mjs [rawDir] [outDir]`: by default results/raw in, RESULTS.md and results/summary.json out; with outDir,
// outDir/RESULTS.md and outDir/summary.json.
const RAW = join(HERE, "results/raw");

/** 95% Wilson score interval for k of n. */
export function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

const pct = (k, n, digits = 1) => (n ? `${((100 * k) / n).toFixed(digits)}%` : "n/a");
const ci = (k, n) => {
  if (!n) return "";
  const [lo, hi] = wilson(k, n);
  return ` [${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]`;
};
const rate = (k, n) => (n ? `${pct(k, n)} (${k}/${n})` : "n/a");
const rateCi = (k, n) => (n ? `${pct(k, n)} (${k}/${n})${ci(k, n)}` : "n/a");

function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const ms = (v) => (v === null || v === undefined ? "n/a" : `${Math.round(v)} ms`);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function load(raw) {
  const cells = [];
  if (!existsSync(raw)) return cells;
  for (const cond of readdirSync(raw)) {
    for (const f of readdirSync(join(raw, cond))) {
      if (!f.endsWith(".json")) continue;
      cells.push(JSON.parse(readFileSync(join(raw, cond, f), "utf8")));
    }
  }
  return cells;
}

/** Race-class detections of a run at a tier: "likely", or "any" (likely + possible). */
function raceDetections(run, tier) {
  if (!run.gc) return [];
  return run.gc.decisions.filter((d) => RACE_DIAGNOSES.includes(d.diagnosis) && (tier === "likely" ? d.detection === "likely" : d.detection === "likely" || d.detection === "possible"));
}
function otherDetections(run, tier) {
  if (!run.gc) return [];
  return run.gc.decisions.filter((d) => !RACE_DIAGNOSES.includes(d.diagnosis) && d.diagnosis !== "expected" && (tier === "likely" ? d.detection === "likely" : d.detection === "likely" || d.detection === "possible"));
}

function summarizeCell(cell) {
  const strategy = STRATEGIES.find((s) => s.id === cell.strategy);
  const runs = cell.runs;
  const n = runs.length;
  const out = { condition: cell.condition, strategy: cell.strategy, profile: cell.profile, kind: strategy.kind, correct: strategy.correct, n, harnessErrors: cell.harnessErrors.length, capped: runs.filter((r) => r.capped).length, pageErrors: runs.filter((r) => r.pageErrors > 0).length };
  out.wrong = runs.filter((r) => r.wrong).length;
  out.requests = { mean: mean(runs.map((r) => r.requests)), p50: quantile(runs.map((r) => r.requests), 0.5) };
  if (strategy.kind === "search") {
    for (const c of ["correct", "stale", "wrong-error", "missing", "error"]) out[c] = runs.filter((r) => r.category === c).length;
    out.overwriteRuns = runs.filter((r) => r.overwrites > 0).length;
    out.aborted = { mean: mean(runs.map((r) => r.aborted)) };
    const t = runs.map((r) => r.timeToCorrectMs).filter((v) => v !== null);
    out.timeToCorrect = { n: t.length, p50: quantile(t, 0.5), p95: quantile(t, 0.95) };
    out.keyDrift = { p95: quantile(runs.map((r) => r.keyDriftMaxMs), 0.95), max: Math.max(0, ...runs.map((r) => r.keyDriftMaxMs)) };
  } else {
    for (const c of ["one", "duplicate", "none"]) out[c] = runs.filter((r) => r.category === c).length;
    out.posts = { mean: mean(runs.map((r) => r.posts)) };
    const t = runs.map((r) => r.timeToConfirmMs).filter((v) => v !== null);
    out.timeToConfirm = { n: t.length, p50: quantile(t, 0.5), p95: quantile(t, 0.95) };
    out.gapDrift = { p95: quantile(runs.map((r) => Math.abs((r.gapActualMs ?? r.gapMs) - r.gapMs)), 0.95) };
  }
  if (runs.some((r) => r.gc)) {
    const bug = runs.filter((r) => r.wrong);
    const clean = runs.filter((r) => !r.wrong);
    const hit = (rs, tier) => rs.filter((r) => raceDetections(r, tier).length > 0).length;
    out.gc = {
      states: Object.entries(runs.reduce((m, r) => ((m[r.gc.status.state] = (m[r.gc.status.state] ?? 0) + 1), m), {})),
      bugRuns: bug.length,
      cleanRuns: clean.length,
      detectedLikely: hit(bug, "likely"),
      detectedAny: hit(bug, "any"),
      falseLikely: hit(clean, "likely"),
      falseAny: hit(clean, "any"),
      overwriteRuns: runs.filter((r) => r.overwrites > 0).length,
      overwriteDetectedLikely: hit(runs.filter((r) => r.overwrites > 0), "likely"),
      overwriteDetectedAny: hit(runs.filter((r) => r.overwrites > 0), "any"),
      otherLikelyRuns: runs.filter((r) => otherDetections(r, "likely").length > 0).length,
      byDiagnosis: runs.flatMap((r) => r.gc.decisions.filter((d) => d.detection)).reduce((m, d) => {
        const k = `${d.diagnosis} (${d.detection})`;
        m[k] = (m[k] ?? 0) + 1;
        return m;
      }, {}),
      decisionsPerRun: mean(runs.map((r) => r.gc.decisions.length)),
      decisionLatencyP50: quantile(runs.flatMap((r) => r.gc.decisions.map((d) => d.latencyMs)), 0.5),
      loadMsP50: quantile(runs.map((r) => r.gc.status.loadMs).filter((v) => v !== null), 0.5),
      dropped: runs.reduce((a, r) => a + (r.gc.dropped ?? 0), 0),
    };
  }
  return out;
}

/** Final state per seed under a GenClass condition against the run without GenClass (same strategy, profile, seed). */
function agreement(cells, cond) {
  const key = (c, r) => `${c.strategy}|${c.profile}|${r.seed}`;
  const off = new Map();
  for (const c of cells.filter((c) => c.condition === "off")) for (const r of c.runs) off.set(key(c, r), r);
  let same = 0;
  let total = 0;
  const diffs = [];
  for (const c of cells.filter((c) => c.condition === cond)) {
    for (const r of c.runs) {
      const o = off.get(key(c, r));
      if (!o) continue;
      total++;
      const a = c.strategy >= "k" ? o.tickets : o.category === "correct" || o.category === "error" ? o.category : `${o.category}:${o.finalTerm}`;
      const b = c.strategy >= "k" ? r.tickets : r.category === "correct" || r.category === "error" ? r.category : `${r.category}:${r.finalTerm}`;
      if (a === b) same++;
      else diffs.push({ strategy: c.strategy, profile: c.profile, seed: r.seed, off: a, with: b, offWrong: o.wrong, withWrong: r.wrong });
    }
  }
  const byCorrect = (pred) => diffs.filter((d) => pred(STRATEGIES.find((s) => s.id === d.strategy).correct));
  return {
    total,
    same,
    diffs,
    onCorrect: byCorrect((c) => c).length,
    onBuggy: byCorrect((c) => !c).length,
    becameWrong: diffs.filter((d) => !d.offWrong && d.withWrong).length,
    becameRight: diffs.filter((d) => d.offWrong && !d.withWrong).length,
  };
}

function pooled(summaries, cond, pred) {
  const xs = summaries.filter((s) => s.condition === cond && s.gc && pred(s));
  const sum = (f) => xs.reduce((a, s) => a + f(s), 0);
  return {
    cells: xs.length,
    runs: sum((s) => s.n),
    bugRuns: sum((s) => s.gc.bugRuns),
    cleanRuns: sum((s) => s.gc.cleanRuns),
    detectedLikely: sum((s) => s.gc.detectedLikely),
    detectedAny: sum((s) => s.gc.detectedAny),
    falseLikely: sum((s) => s.gc.falseLikely),
    falseAny: sum((s) => s.gc.falseAny),
    overwriteRuns: sum((s) => s.gc.overwriteRuns),
    overwriteDetectedLikely: sum((s) => s.gc.overwriteDetectedLikely),
    overwriteDetectedAny: sum((s) => s.gc.overwriteDetectedAny),
  };
}

const label = (s) => `(${s.id}) ${s.stack}: ${s.name}`;

export function report(raw = RAW, outDir = null) {
  const mdFile = outDir ? join(outDir, "RESULTS.md") : join(HERE, "RESULTS.md");
  const summaryFile = outDir ? join(outDir, "summary.json") : join(HERE, "results/summary.json");
  const cells = load(raw);
  if (!cells.length) {
    console.log(`no results in ${raw}`);
    return;
  }
  const summaries = cells.map(summarizeCell).sort((a, b) => (a.condition + a.strategy + a.profile).localeCompare(b.condition + b.strategy + b.profile));
  const get = (cond, sid, profile) => summaries.find((s) => s.condition === cond && s.strategy === sid && s.profile === profile);
  const conds = Object.keys(CONDITIONS).filter((c) => summaries.some((s) => s.condition === c));
  const profiles = Object.keys(PROFILES);
  const meta = cells[0];
  const seeds = meta.seeds;
  const search = STRATEGIES.filter((s) => s.kind === "search");
  const submit = STRATEGIES.filter((s) => s.kind === "submit");

  const pools = {};
  for (const cond of conds.filter((c) => c !== "off")) {
    pools[cond] = {
      staleBuggy: pooled(summaries, cond, (s) => s.kind === "search" && !s.correct),
      staleCorrect: pooled(summaries, cond, (s) => s.kind === "search" && s.correct),
      submitBuggy: pooled(summaries, cond, (s) => s.kind === "submit" && !s.correct),
      submitCorrect: pooled(summaries, cond, (s) => s.kind === "submit" && s.correct),
      submitCorrectNoIdem: pooled(summaries, cond, (s) => s.kind === "submit" && s.correct && s.strategy !== "m"),
      allCorrect: pooled(summaries, cond, (s) => s.correct),
      buggyAll: pooled(summaries, cond, (s) => !s.correct),
    };
  }
  const agree = Object.fromEntries(conds.filter((c) => c !== "off").map((c) => [c, agreement(cells, c)]));

  writeFileSync(
    summaryFile,
    JSON.stringify({ generatedAt: new Date().toISOString(), versions: meta.versions, seeds, profiles: PROFILES, user: USER, settle: { quietMs: SETTLE_QUIET_MS, capMs: SETTLE_CAP_MS }, cells: summaries, pooled: pools, agreement: Object.fromEntries(Object.entries(agree).map(([k, v]) => [k, { ...v, diffs: v.diffs.slice(0, 200) }])) }, null, 1) + "\n",
  );

  const L = [];
  const v = meta.versions;
  L.push("# Measured: the usual fixes for stale search results and double submits");
  L.push("");
  const seedText = conds.map((c) => { const xs = cells.filter((x) => x.condition === c); const lo = Math.min(...xs.map((x) => x.seeds[0])); const hi = Math.max(...xs.map((x) => x.seeds[1])); return `${c} ${lo} to ${hi}`; }).join(", ");
  const profText = conds.map((c) => `${c}: ${profiles.filter((p) => cells.some((x) => x.condition === c && x.profile === p)).join(", ")}`).join("; ");
  L.push(`Generated by \`report.mjs\` from \`results/raw/\` (do not edit by hand). Seeds per strategy and profile: ${seedText}. Profiles run: ${profText}.`);
  L.push("How to run it again: [README.md](README.md).");
  L.push("");
  L.push("## Setup");
  L.push("");
  L.push(`- **Pages.** One small page per strategy, written for this bench (\`src/\`), production builds (esbuild). Search pages send one request per keystroke unless the strategy says otherwise; the API echoes the query, and the page shows the results with the query they are for. Submit pages load the open tickets, then show a form with a Create button.`);
  L.push(`- **Server** (\`server.mjs\`): HTTP/2 on 127.0.0.1. Each request's latency is drawn from the run's seed, the profile and the request itself, so the request for a given query takes the same time whatever fix the page uses. Profiles: ${profiles.map((p) => `**${p}**, latency uniform ${PROFILES[p].latency[0]} to ${PROFILES[p].latency[1]} ms${PROFILES[p].inOrder ? ", answered in request order" : ", each request on its own, so answers can arrive in any order"}${PROFILES[p].failRate ? `, ${PROFILES[p].failRate * 100}% of requests answered 503 and not processed` : ""}${PROFILES[p].slow ? `, except ${PROFILES[p].slow.rate * 100}% of requests, which take ${PROFILES[p].slow.latency[0]} to ${PROFILES[p].slow.latency[1]} ms` : ""}`).join("; ")}.`);
  L.push(`- **User** (Playwright, Chromium): types a two-word query (${QUERIES.length} queries) with ${USER.keyDelayMs[0]} to ${USER.keyDelayMs[1]} ms between keys and a pause of ${USER.wordPauseMs[0]} to ${USER.wordPauseMs[1]} ms before the second word, as people do when they glance at the first results; or double-clicks Create with ${USER.doubleClickGapMs[0]} to ${USER.doubleClickGapMs[1]} ms between the clicks (real mouse events at the button's position, so a disabled button really ignores the second click). All drawn from the seed: every strategy and condition sees the same user in a seed.`);
  L.push(`- **End of a run**: nothing in flight, no new request and no change on the page for ${SETTLE_QUIET_MS} ms, and nothing marked busy (a library waiting to retry counts as busy); at most ${SETTLE_CAP_MS / 1000} s after the last key or click.`);
  L.push(`- **Wrong final state.** Search: the results shown are for another query than the one typed (stale), an error is shown although the typed query's last answer succeeded (stale error), or nothing is shown. An error after the typed query's own request failed is the truth and counts as "error shown", not wrong. Submit: more than one ticket created.`);
  L.push(`- **Time to correct results**: from the last keystroke to the moment the results for the typed query appear for good (runs that end correct). Submit: from the first click to the first "Created" message.`);
  L.push(`- **GenClass conditions**: the one script tag first in \`<head>\` (the runtime built from this repository), \`mode: "observe"\`, \`telemetry: false\`, measured visual checks off (127.0.0.1 is a development host, where they would start; they never feed a detection). **model**: the default model loaded from this machine (\`preload: "eager"\`), and the user starts once it is ready; the default \`aggressiveness\` (balanced). **skipped**: \`model: { loadIf: () => false }\`, which is what a device with 2 GB of memory or less, or a Save-Data connection, gets by default.`);
  L.push(`- **Versions**: @genclass/runtime ${v.runtime} at commit \`${v.commit}\`, model ${v.model ?? "n/a"}, React ${v.react}, TanStack Query ${v["@tanstack/react-query"]}, SWR ${v.swr}, RxJS ${v.rxjs}, Vue ${v.vue}, Svelte ${v.svelte}, Playwright ${v.playwright}, Chromium ${v.chromium}, Node ${v.node}.`);
  L.push("");

  const offOk = conds.includes("off");
  if (offOk) {
    L.push("## Stale search results (no GenClass)");
    L.push("");
    for (const p of profiles) {
      L.push(`### ${p} (${PROFILES[p].label})`);
      L.push("");
      L.push("| strategy | wrong final state [95% CI] | stale / stale error / nothing | error shown (truthful) | requests per run | time to correct p50 / p95 |");
      L.push("|---|---|---|---|---|---|");
      for (const s of search) {
        const c = get("off", s.id, p);
        if (!c) continue;
        L.push(`| ${label(s)} | ${rateCi(c.wrong, c.n)} | ${c.stale} / ${c["wrong-error"]} / ${c.missing} | ${rate(c.error, c.n)} | ${c.requests.mean.toFixed(1)} | ${ms(c.timeToCorrect.p50)} / ${ms(c.timeToCorrect.p95)} |`);
      }
      L.push("");
    }
    L.push("## Double submits (no GenClass)");
    L.push("");
    L.push("| strategy | profile | more than one ticket [95% CI] | no ticket | POSTs per run | time to confirmation p50 / p95 |");
    L.push("|---|---|---|---|---|---|");
    for (const s of submit) for (const p of profiles) {
      const c = get("off", s.id, p);
      if (!c) continue;
      L.push(`| ${label(s)} | ${p} | ${rateCi(c.duplicate, c.n)} | ${rate(c.none, c.n)} | ${c.posts.mean.toFixed(2)} | ${ms(c.timeToConfirm.p50)} / ${ms(c.timeToConfirm.p95)} |`);
    }
    L.push("");
  }

  for (const cond of conds.filter((c) => c !== "off")) {
    const P = pools[cond];
    L.push(`## GenClass: ${CONDITIONS[cond].label}`);
    L.push("");
    L.push("A run counts as detected when GenClass reported at least one race diagnosis (stale, duplicate, conflict, inconsistent) during it: **likely** is what observe reports by default (console, `rt.on(\"detect\")`), **likely + possible** adds the lower tier observe prints with `console.debug`. A report on a run that did not end wrong is a false report: on a correct fix every report is false.");
    L.push("");
    L.push("**Pooled.**");
    L.push("");
    L.push("| pages | runs | runs that ended wrong | detected, likely | detected, likely + possible | false reports on the other runs, likely | likely + possible |");
    L.push("|---|---|---|---|---|---|---|");
    const row = (name, x) => `| ${name} | ${x.runs} | ${x.bugRuns} | ${rateCi(x.detectedLikely, x.bugRuns)} | ${rateCi(x.detectedAny, x.bugRuns)} | ${rateCi(x.falseLikely, x.cleanRuns)} | ${rateCi(x.falseAny, x.cleanRuns)} |`;
    L.push(row("search, buggy fixes (a, b)", P.staleBuggy));
    L.push(row("search, correct fixes (c to j)", P.staleCorrect));
    L.push(row("submit, buggy fix (k)", P.submitBuggy));
    L.push(row("submit, correct fixes (l, m, n)", P.submitCorrect));
    L.push(row("submit, correct fixes without the idempotency key (l, n)", P.submitCorrectNoIdem));
    L.push(row("all correct fixes", P.allCorrect));
    L.push("");
    if (P.staleBuggy.overwriteRuns) {
      L.push(`Search runs of the buggy fixes in which older results replaced newer ones on screen at least once (even if a later answer put the right ones back): ${P.staleBuggy.overwriteRuns}; detected ${rate(P.staleBuggy.overwriteDetectedLikely, P.staleBuggy.overwriteRuns)} likely, ${rate(P.staleBuggy.overwriteDetectedAny, P.staleBuggy.overwriteRuns)} likely + possible.`);
      L.push("");
    }
    L.push("**Per strategy and profile.**");
    L.push("");
    L.push("| strategy | profile | runs that ended wrong | detected, likely | likely + possible | false reports, likely | likely + possible | runs with a likely non-race report (slow, failing, ...) |");
    L.push("|---|---|---|---|---|---|---|---|");
    for (const s of STRATEGIES) for (const p of profiles) {
      const c = get(cond, s.id, p);
      if (!c?.gc) continue;
      const g = c.gc;
      L.push(`| ${label(s)} | ${p} | ${g.bugRuns}/${c.n} | ${g.bugRuns ? rate(g.detectedLikely, g.bugRuns) : "-"} | ${g.bugRuns ? rate(g.detectedAny, g.bugRuns) : "-"} | ${rate(g.falseLikely, g.cleanRuns)} | ${rate(g.falseAny, g.cleanRuns)} | ${rate(g.otherLikelyRuns, c.n)} |`);
    }
    L.push("");
    const gcs = summaries.filter((s) => s.condition === cond && s.gc);
    const states = {};
    for (const s of gcs) for (const [k, n] of s.gc.states) states[k] = (states[k] ?? 0) + n;
    const diag = {};
    for (const s of gcs) for (const [k, n] of Object.entries(s.gc.byDiagnosis)) diag[k] = (diag[k] ?? 0) + n;
    L.push(`Model state at the end of the runs: ${Object.entries(states).map(([k, n]) => `${k} ${n}`).join(", ")}. Reports by diagnosis and tier, all runs: ${Object.keys(diag).length ? Object.entries(diag).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") : "none"}.`);
    if (cond === "model") {
      const loads = gcs.map((s) => s.gc.loadMsP50).filter((x) => x !== null);
      const lat = gcs.map((s) => s.gc.decisionLatencyP50).filter((x) => x !== null);
      const mc = cells.find((c) => c.condition === cond);
      L.push(`Cost on the bench machine (${mc?.versions?.cpus ?? 4} vCPU, up to ${mc?.workers ?? 4} pages at once): model load p50 per page ${ms(quantile(loads, 0.5))} (median of the cells' medians, from the browser cache after a context's first page), decision latency p50 ${ms(quantile(lat, 0.5))}, ${mean(gcs.map((s) => s.gc.decisionsPerRun)).toFixed(1)} model decisions per run, ${gcs.reduce((a, s) => a + s.gc.dropped, 0)} dropped by the per-minute budget.`);
    }
    L.push("");
    const a = agree[cond];
    if (a?.total) {
      L.push(`**Final state against the run without GenClass** (same strategy, profile and seed): the same in ${a.same} of ${a.total} runs. Of the ${a.diffs.length} that differ, ${a.onCorrect} are on correct fixes and ${a.onBuggy} on buggy ones; ${a.becameWrong} went from right to wrong and ${a.becameRight} from wrong to right. The two runs are separate page loads with real timers, so a race that is close can land either way; this is not a controlled comparison of GenClass against no GenClass.`);
      L.push("");
    }
  }

  const errs = summaries.reduce((a, s) => a + s.harnessErrors, 0);
  const capped = summaries.reduce((a, s) => a + s.capped, 0);
  const pageErr = summaries.reduce((a, s) => a + s.pageErrors, 0);
  const drift = summaries.filter((s) => s.keyDrift).map((s) => s.keyDrift.p95);
  L.push("## Run health");
  L.push("");
  L.push(`Runs: ${summaries.reduce((a, s) => a + s.n, 0).toLocaleString("en")}; left out after three tries (harness errors): ${errs}; ended at the ${SETTLE_CAP_MS / 1000} s cap: ${capped}; with a page error: ${pageErr}. Typing: the gap between keystrokes as the page saw it differed from the planned one by at most ${ms(quantile(drift, 0.5))} in the median cell's 95th percentile run (worst cell: ${ms(Math.max(...drift))}).`);
  L.push("");
  writeFileSync(mdFile, L.join("\n"));
  console.log(`wrote ${mdFile} and ${summaryFile} from ${cells.length} cells`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) report(process.argv[2] ?? RAW, process.argv[3] ?? null);
