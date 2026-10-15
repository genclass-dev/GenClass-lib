// Experiment only (branch ci-exp/device-poll-race, never merged): delays the browser's approve/deny request in the
// device-flow tests by <ms> of real time (setInterval, which these tests do not fake), as a slow thread pool would,
// and logs each CLI poll as [fake ms since the first poll, answer].
import { readFileSync, writeFileSync } from "node:fs";

const [file, ms] = process.argv.slice(2);
let s = readFileSync(file, "utf8");
const decide =
  'const decide = (env: Env, userCode: string, cookie: string, approve: boolean) => call(env, "POST", "/api/device/approve", { body: { user_code: userCode, approve }, cookie });';
if (!s.includes(decide)) throw new Error("decide() not found");
s = s.replace(
  decide,
  `const decide = (env: Env, userCode: string, cookie: string, approve: boolean) => new Promise<void>((r) => { const h = setInterval(() => { clearInterval(h); r(); }, ${Number(ms)}); }).then(() => call(env, "POST", "/api/device/approve", { body: { user_code: userCode, approve }, cookie }));`,
);
const polls = 'const polls = log.filter((e) => e.path === "/api/device/token");';
if (s.split(polls).length !== 3) throw new Error("expected two poll filters");
s = s.replaceAll(polls, `${polls} console.log("POLLS delay=${Number(ms)}ms", JSON.stringify(polls.map((e) => [e.at - polls[0]!.at, e.answer?.error ?? "token"])));`);
writeFileSync(file, s);
