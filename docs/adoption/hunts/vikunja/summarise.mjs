// The report's verdict table (docs/adoption/hunts/vikunja.md section 3) from the explore session files that hunt.mjs
// writes (<scenario>-<slow_ms>-<variant>.json in HUNT_OUT): explore's own verdict, reduced to counts, next to this
// harness's oracle (the server's task and the page's fields against the last edit), per session.
//
//   node docs/adoption/hunts/vikunja/summarise.mjs [variant]      # unfixed (default) or fixed
//   node docs/adoption/hunts/vikunja/summarise.mjs --json <file>   # every session and repro run, as JSON (results.json)

import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const OUT = process.env.HUNT_OUT ?? "/home/user/vikunja-hunt/out";
const json = process.argv[2] === "--json";
const variant = json ? "" : process.argv[2] ?? "unfixed";
const files = readdirSync(OUT).filter((f) => (json || f.endsWith(`-${variant}.json`)) && /-(300|600|900)-(unfixed|fixed)\.json$/.test(f)).sort();
const sessions = [];
const rows = [];
for (const f of files) {
  const r = JSON.parse(readFileSync(`${OUT}/${f}`, "utf8"));
  const verdict =
    (r.report.match(/RACE: (\d+) of (\d+) reordered run\(s\) ended/) ?? []).slice(1).join(" of ") ||
    (/No race/.test(r.report) ? "no race" : /No baseline run/.test(r.report) ? "no verdict" : "?");
  const witnessOnly = (r.report.match(/(\d+) more witness only|(\d+) witness only/) ?? [])[1] ?? "";
  const groups = (r.report.match(/^## /gm) ?? []).length;
  const fifo = r.loads.filter((l) => l.schedule?.order === "fifo");
  const seeded = r.loads.filter((l) => l.schedule?.order === "seeded");
  const wrong = (ls) => ls.filter((l) => l.oracle?.wrong?.length).length;
  const serverWrong = (ls) => ls.filter((l) => l.oracle?.wrong?.some((w) => w.startsWith("server."))).length;
  const forced = r.loads.reduce((n, l) => n + (l.snapshot?.forced ?? 0), 0);
  const errors = r.loads.filter((l) => l.error).length;
  const replay = r.replay ? (/REPRODUCED/.test(r.replay.result) ? "reproduced" : /not reproduced/i.test(r.replay.result) ? "not reproduced" : "inconclusive") : "-";
  sessions.push({
    scenario: r.scenario, slow_ms: r.slow_ms, variant: r.variant, report: r.report.split("\n").filter((l) => /^(RACE|No race|No baseline|- run|    )/.test(l)).slice(0, 60),
    replay: replay,
    loads: [...r.loads, ...(r.replay ? [{ ...r.replay.load, replay: true }] : [])].map((l) => ({
      i: l.i, replay: l.replay ?? false, schedule: l.schedule, order: (l.snapshot?.order ?? []).filter((k) => /^(PATCH|PUT)/.test(k)),
      witnesses: l.snapshot?.witnesses ?? [], forced: l.snapshot?.forced ?? 0, oracle: l.oracle ?? null, error: l.error ?? null,
    })),
  });
  rows.push(`| ${r.scenario} | ${r.slow_ms} | ${verdict === "?" ? "?" : verdict.includes(" of ") ? `race: ${verdict} ended differently` : verdict}${witnessOnly ? `, ${witnessOnly} witness only` : ""} | ${groups} | ${wrong(seeded)} of ${seeded.length} (server ${serverWrong(seeded)}) | ${wrong(fifo)} of ${fifo.length} (server ${serverWrong(fifo)}) | ${replay} | ${forced} | ${errors} |`);
}
if (json) {
  const repro = Object.fromEntries(["unfixed", "fixed"].map((v) => { try { return [v, JSON.parse(readFileSync(`${OUT}/repro-${v}.json`, "utf8"))]; } catch { return [v, null]; } }));
  writeFileSync(process.argv[3] ?? "results.json", `${JSON.stringify({ schema: "genclass-hunt-vikunja/1", sessions, repro }, null, 1)}\n`);
  process.exit(0);
}
console.log("| scenario | slow_ms | explore verdict (as reported) | groups | oracle: seeded loads wrong (on the server) | oracle: baselines wrong (on the server) | replay | forced | harness errors |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(r);
