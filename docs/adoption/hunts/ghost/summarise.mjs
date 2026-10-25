// Prints the results table of docs/adoption/hunts/ghost.md from results/*.json (one file per explore session).
// Usage: node docs/adoption/hunts/ghost/summarise.mjs [results dir]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "results");
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes("-once") && !f.startsWith("smoke")).sort();

const okApi = (l) => {
  if (!l.api || !l.expect) return null;
  if (l.api.A) return l.api.A.title === l.expect.A.title && l.api.B.title === l.expect.B.title && (!l.expect.B.plaintext || l.api.B.plaintext === l.expect.B.plaintext);
  return Object.entries(l.expect).every(([k, v]) => k === "domTitle" || k === "note" || JSON.stringify(l.api[k]) === JSON.stringify(v));
};
const okDom = (l) => {
  if (!l.dom || !l.expect) return null;
  if (l.expect.domTitle) return l.dom.title === l.expect.domTitle;
  if (l.expect.title) return l.dom.title === l.expect.title;
  return null;
};
// the list rows without their relative times ("a few seconds ago", "7 minutes ago"), compared across the loads
const rows = (l) => (l.dom?.titles ?? []).map((t) => t.replace(/ - (?:in [^-]+ - )?[^-]*ago/, "")).join("\n");
// what kinds of difference the report lists under RACE
const kinds = (report) => {
  const k = new Set();
  if (/^\s+state "/m.test(report)) k.add("state");
  if (/^\s+page text only/m.test(report)) k.add("page text");
  if (/^\s+requests sent to/m.test(report)) k.add("request count");
  if (/^\s+(field|form) "/m.test(report)) k.add("form value");
  if (/witness only here/m.test(report)) k.add("witness");
  if (/^\s+error only/m.test(report)) k.add("error");
  return [...k].join(", ") || "none";
};
const detail = (report) => {
  const lines = [...report.matchAll(/^\s+(state "[^"]+"|requests sent to "[^"]+"|page text only in this run: "[^"]{0,60}|witness only here: [^\n]{0,70})/gm)].map((m) => m[1]);
  const uniq = [...new Set(lines.map((l) => l.replace(/\s+/g, " ").slice(0, 90)))];
  return uniq.slice(0, 3).join("; ") + (uniq.length > 3 ? `; +${uniq.length - 3} more` : "");
};

console.log("| scenario | slow_ms | discovery | explore verdict (as reported) | what differed | API read-back | DOM | forced holds | file |");
console.log("|---|---|---|---|---|---|---|---|---|");
let total = 0;
for (const f of files) {
  const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
  if (!s.report) continue; // a session still running
  const report = s.report;
  const m = /RACE: (\d+) of (\d+) reordered/.exec(report);
  const none = /No race found: all (\d+)/.exec(report);
  const witnessOnly = /RACE: no reordered run ended differently, but (\d+) of (\d+) had an older response/.exec(report);
  const verdict = m ? `RACE: ${m[1]} of ${m[2]}` : none ? `no race, 0 of ${none[1]}` : witnessOnly ? `RACE: 0 of ${witnessOnly[2]} ended differently (${witnessOnly[1]} witness only)` : /· 1 run\(s\) ·/.test(report) ? "(no verdict: runs not grouped)" : "(no verdict)";
  const extra = /(\d+) more ended right but had an older response overwrite/.exec(report);
  const loads = s.loads ?? [];
  const api = loads.map(okApi).filter((x) => x !== null);
  const dom = loads.map(okDom).filter((x) => x !== null);
  const withRows = loads.filter((l) => l.dom?.titles);
  const sameRows = withRows.length ? `${withRows.filter((l) => rows(l) === rows(withRows[0])).length}/${withRows.length} same rows (times stripped)` : "n/a";
  const forced = loads.reduce((n, l) => n + (l.dom?.agent?.forced ?? 0), 0);
  const errors = loads.filter((l) => l.error).length;
  total += loads.filter((l) => !l.error && l.dom?.agent?.schedule?.order === "seeded").length;
  console.log(
    `| ${s.scenario} | ${s.slow_ms} | ${s.autoState ? "on" : "off"} | ${verdict}${extra ? ` (+${extra[1]} witness only)` : ""} | ${m ? kinds(report) + ": " + detail(report) : "nothing"} | ${api.length ? `${api.filter(Boolean).length}/${api.length} as typed` : "n/a (no post)"} | ${dom.length ? `${dom.filter(Boolean).length}/${dom.length} as typed` : sameRows} | ${forced}${errors ? ` (${errors} load(s) failed)` : ""} | \`${f}\` |`,
  );
}
console.log(`\nSeeded loads in all: ${total}`);
