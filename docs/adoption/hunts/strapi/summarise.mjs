// Summarises the explore sessions hunt.mjs wrote (HUNT_OUT/<scenario>-<slow_ms>[-<tag>].json) into one table and
// docs/adoption/hunts/strapi/results.json: per session the explore verdict as reported (runs that ended in a
// different state; runs that only had a witness the baselines did not), the DOM oracle (this script's own, secondary),
// the replay result, forced deliveries, runs that failed, and the per-load timings.
//
//   node docs/adoption/hunts/strapi/summarise.mjs [HUNT_OUT]

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? process.env.HUNT_OUT ?? "/home/user/strapi-hunt/out";
const rows = [];
for (const f of readdirSync(OUT).filter((f) => /^[a-z-]+-\d+(-[a-z]+)?\.json$/.test(f)).sort()) {
  const d = JSON.parse(readFileSync(join(OUT, f), "utf8"));
  // the verdict line, in its three wordings: "RACE: 2 of 6 reordered run(s) ended in a different state ...",
  // "... ended in a different state ...; 5 more ended right but had an older response overwrite newer data ...",
  // "RACE: no reordered run ended differently, but 6 of 6 had an older response overwrite newer data ..."
  const m = /RACE: (\d+) of (\d+) reordered run\(s\) ended in a different state[^.;]*[.;](?:[^.]*?(\d+) more ended right but had an older response overwrite newer data)?/.exec(d.report);
  const witnessOnly = /RACE: no reordered run ended differently, but (\d+) of (\d+) had an older response overwrite newer data/.exec(d.report);
  const noRace = /no race|No race|ended as the baseline/i.test(d.report) && !m && !witnessOnly;
  const loads = d.loads ?? [];
  const seeded = loads.filter((l) => l.schedule?.order === "seeded");
  const fifo = loads.filter((l) => l.schedule?.order === "fifo");
  const failed = loads.filter((l) => l.error).length;
  const forbiddenRuns = loads.filter((l) => l.forbidden).map((l) => `${l.schedule?.order ?? "?"}${l.schedule?.seed !== undefined ? ` ${l.schedule.seed}` : ""}`);
  const forced = loads.reduce((n, l) => n + (l.snapshot?.forced ?? 0), 0);
  const unsettled = loads.filter((l) => l.settled === false).length;
  const replay = d.replay ? (/not reproduced/.test(d.replay.result.split("\n").slice(-3).join("\n")) ? "not reproduced" : /REPRODUCED/.test(d.replay.result) ? "reproduced" : "inconclusive") : "";
  const replayWhy = d.replay ? (d.replay.result.match(/- r\d+: ([^\n]*)/)?.[1] ?? "") : "";
  const ms = loads.map((l) => l.ms).filter(Boolean);
  rows.push({
    file: f,
    scenario: d.scenario,
    slow_ms: d.slow_ms,
    tag: (f.match(/-\d+-([a-z]+)\.json$/) ?? [])[1] ?? "",
    loads: loads.length,
    baselines: fifo.length,
    seeded: seeded.length,
    failed,
    unsettled,
    forced,
    forbiddenRuns,
    verdict: m ? `race: ${m[1]} of ${m[2]} ended differently${m[3] ? `, ${m[3]} more witness only` : ""}` : witnessOnly ? `race: 0 of ${witnessOnly[2]} ended differently, ${witnessOnly[1]} witness only` : d.report.includes("RACE:") ? "race (see report)" : noRace ? "no race" : "no verdict",
    witnessOnly: m?.[3] ? Number(m[3]) : witnessOnly ? Number(witnessOnly[1]) : 0,
    oracleBaselinesAgree: d.oracle?.baselinesAgree,
    oracleSeededDiffering: (d.oracle?.seededDiffering ?? []).map((x) => `seed ${x.seed}`),
    replay,
    replayWhy,
    findings: [...new Set([...(d.report.matchAll(/\b(f\d+)\b/g))].map((x) => x[1]))],
    msMedian: ms.length ? ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] : null,
    reportHead: d.report.split("\n").filter((l) => /RACE:|no run ended|No race|ended as the baseline|insufficient|no verdict/i.test(l)).slice(0, 3),
  });
}
writeFileSync(join(here, "results.json"), JSON.stringify(rows, null, 2));
const cell = (v) => String(v ?? "").replace(/\|/g, "\\|");
console.log("| scenario | slow_ms | variant | explore verdict (as reported) | DOM oracle: seeded loads differing | replay | 403 loads | failed loads | forced |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${cell(r.scenario)} | ${r.slow_ms} | ${cell(r.tag)} | ${cell(r.verdict)} | ${r.oracleSeededDiffering.length} of ${r.seeded}${r.oracleBaselinesAgree === false ? " (baselines differ)" : ""} | ${cell(r.replay)}${r.replayWhy ? ` (${cell(r.replayWhy)})` : ""} | ${r.forbiddenRuns.join(", ") || "none"} | ${r.failed} | ${r.forced} |`);
