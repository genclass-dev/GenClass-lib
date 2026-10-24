// Command-line options for hunt.mjs: `--key value`, `--key=value`, bare `--flag`, repeated list options. No
// dependency. Unknown options are an error, so a typo never silently changes a run.

const SPEC = {
  url: "string",
  scenario: "list",
  param: "list",
  runs: "number",
  slow: "number",
  seed: "number",
  focus: "list",
  route: "string",
  out: "string",
  timeout: "number",
  settle: "number",
  "storage-state": "string",
  login: "string",
  headful: "boolean",
  model: "boolean",
  "model-dir": "string",
  "hold-protected": "boolean",
  "app-commit": "string",
  chromium: "string",
  port: "number",
  "no-run-tests": "boolean",
  "no-rewrite": "boolean",
  expect: "string",
  viewport: "string",
  render: "string",
  help: "boolean",
};

export const USAGE = `node bench/hunt/hunt.mjs --url <app url> --scenario <file.mjs> [options]

  --url <url>              the page under test (the scenario's url, when relative, is resolved against it)
  --scenario <file>        a scenario module (repeatable; see README "How to write a scenario")
  --param k=v              a parameter the scenario reads (repeatable), e.g. --param input='input[name=q]'
  --runs <n>               seeded orders after the two baselines (default 6, max 50)
  --slow <ms>              extra latency per response, 0 to maxMs, like a slow network (default 600; 0 for none)
  --seed <n>               first seed (default 1)
  --focus <sig>            request signature delivered last in seeded orders (repeatable), e.g. "GET /api/search"
  --route <path>           arm only page loads of this path (default: the page the first armed load reports)
  --out <dir>              results directory (default bench/hunt/results/<first scenario name>)
  --timeout <ms>           per step: navigation, connection, the scenario's steps, the quiet point (default 30000)
  --settle <ms>            quiet time before a snapshot (default: the scenario's settleMs, else 400)
  --storage-state <file>   Playwright storageState JSON for a logged-in app (written by --login when given)
  --login <file>           a module exporting login(page, ctx); runs once, saves --storage-state
  --headful                show the browser
  --model                  load the on-device model (13 MB from jsDelivr); default: skipped, explore does not need it
  --model-dir <dir>        serve a fetch-model directory to the page instead of the CDN (implies --model)
  --hold-protected         also schedule responses of protected requests (payments, auth); default: never held
  --app-commit <sha>       the app's commit, recorded in the report (name it when you publish a result)
  --chromium <path>        Chromium executable (default: Playwright's)
  --port <n>               bridge port (default 0: a free port)
  --no-run-tests           do not run the generated regression tests after saving them
  --no-rewrite             never rewrite the HTML document; inject from the init script only (later than head)
  --expect race|no-race    exit 2 when the explore verdict is not this (for scripted checks)
  --viewport WxH           browser viewport (default 1280x800)
  --render <report.json>   only write report.md again from an existing report.json (no browser, no app)
  --help
`;

/** Parse argv into { options, errors }. Lists collect every occurrence; numbers are validated. */
export function parseArgs(argv) {
  const o = { scenario: [], param: [], focus: [] };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      errors.push(`unexpected argument ${a}`);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const kind = SPEC[key];
    if (!kind) {
      errors.push(`unknown option --${key}`);
      continue;
    }
    if (kind === "boolean") {
      o[camel(key)] = val === undefined ? true : !/^(false|0|no|off)$/i.test(val);
      continue;
    }
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined) {
        errors.push(`--${key} needs a value`);
        continue;
      }
    }
    if (kind === "number") {
      const n = Number(val);
      if (!Number.isFinite(n)) {
        errors.push(`--${key} needs a number, got ${val}`);
        continue;
      }
      o[camel(key)] = n;
    } else if (kind === "list") o[camel(key)].push(val);
    else o[camel(key)] = val;
  }
  return { options: o, errors };
}

/** `--param k=v` pairs as an object (a later value replaces an earlier one). */
export function paramsOf(list) {
  const out = {};
  for (const p of list) {
    const eq = p.indexOf("=");
    if (eq < 0) out[p] = "true";
    else out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

function camel(k) {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
