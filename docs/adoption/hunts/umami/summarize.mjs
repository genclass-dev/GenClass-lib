// Prints the hunt's results table (docs/adoption/hunts/umami.md section 5) from the JSON files hunt.mjs wrote.
// Usage: node docs/adoption/hunts/umami/summarize.mjs [results dir] [label filter]
// Per session: loads, how many lost typed text (input oracle) and showed the wrong list (list oracle), how many lost
// it after the last keystroke (the box shows the first burst) or during the second burst (characters dropped mid-word),
// and explore's verdict with the number of scenario groups it split the loads into.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2] ?? join(here, "results"));
const filter = process.argv[3] ?? "";
// The runs explore's report lists under a RACE line, classified by what differed: the search box (form field "Search"),
// the list (the list query's count or rows, or page text naming a seeded website or user), or only other things
// (request counts, relative times, discovered stores present in one run and not another). Read from the report text.
function raceRuns(report) {
  const out = [];
  for (const block of report.split(/\n(?=- run r\d+)/).slice(1)) {
    const body = block.split(/\n(?!\s)/)[0];
    const box = /field "Search"/.test(body);
    const list = /state "[^"]*\.data\.(count|data)"/.test(body) || /page text only[^\n]*"(shop|blog|docs|news|mail) |page text only[^\n]*"(anna|andre|ben|bella|carl)_|\d+ records"/.test(body);
    out.push({ box, list, other: !box && !list });
  }
  return out;
}
const rows = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && x.includes(filter)).sort()) {
  const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
  if (!s.report) continue;
  const loads = s.loads.filter((l) => l.oracle);
  const first = s.parts.find((p) => typeof p === "string");
  const groups = (s.report.match(/^## /gm) ?? []).length;
  const verdict = /RACE: (\d+) of (\d+)/.exec(s.report);
  const fifo = loads.filter((l) => l.agent.schedule?.order === "fifo");
  rows.push({
    file: f.replace(/\.json$/, ""),
    loads: loads.length,
    errors: s.loads.length - loads.length,
    inputFail: loads.filter((l) => l.oracle.input === "FAIL").length,
    listFail: loads.filter((l) => l.oracle.list === "FAIL").length,
    afterTyping: loads.filter((l) => l.value === first).length,
    midTyping: loads.filter((l) => l.value !== first && l.value !== s.typed).length,
    baselinesFail: `${fifo.filter((l) => l.oracle.input === "FAIL").length}/${fifo.length}`,
    explore: verdict ? `RACE ${verdict[1]} of ${verdict[2]}` : /No race found/.test(s.report) ? "no race" : "no verdict",
    groups,
    raceBox: raceRuns(s.report).filter((r) => r.box).length,
    raceList: raceRuns(s.report).filter((r) => r.list).length,
    raceOtherOnly: raceRuns(s.report).filter((r) => r.other).length,
    witnesses: loads.reduce((n, l) => n + l.agent.witnesses.length, 0),
    values: [...new Set(loads.map((l) => l.value))].map((v) => JSON.stringify(v)).join(" "),
  });
}
const cols = Object.keys(rows[0] ?? {});
console.log(`| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|`);
for (const r of rows) console.log(`| ${cols.map((c) => r[c]).join(" | ")} |`);
const t = rows.reduce((a, r) => ({ loads: a.loads + r.loads, inputFail: a.inputFail + r.inputFail, listFail: a.listFail + r.listFail }), { loads: 0, inputFail: 0, listFail: 0 });
console.log(`\ntotal: ${rows.length} sessions, ${t.loads} loads, input oracle failed in ${t.inputFail}, list oracle failed in ${t.listFail}`);
