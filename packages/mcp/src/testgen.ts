// A Playwright regression test from a finding (docs/runtime/AGENT.md section 5.3). It performs the recorded user
// actions on the recorded page with the finding's delivery schedule set through a page global, so the app's own
// @genclass/runtime/agent link delivers the responses in exactly the order that produced the bug, on any machine,
// with or without the MCP bridge running. It asserts the generic fact that made the finding (no response overwrote
// newer data in that field, no identical request from a second click, the error does not recur, the state and page
// text the request-order baseline ended with), and leaves a marked place for the domain assertion the developer or
// agent knows (what the user should see). A test it cannot give a generic assertion fails until one is written: it
// never passes while asserting nothing.
//
// Every string from the page goes into the file as a JSON string literal (never as code); patterns are built at run
// time with new RegExp from such a literal. Values the page redacted ("[redacted]") become a placeholder.

import type { ActStep, Finding, Run, ScheduleSpec } from "./types.js";
import { clean, pathShape, shape } from "./text.js";
import { shownField, type FieldDiff } from "./compare.js";

const lit = (s: unknown): string => JSON.stringify(clean(s, 200));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 'button "Place order"' → { role: "button", name: "Place order" }. */
export function parseTarget(t: string | undefined): { role: string; name?: string } {
  if (!t) return { role: "page" };
  const m = /^([a-z][a-z0-9-]*)(?: "(.*)")?$/i.exec(t.trim());
  if (!m) return { role: "unknown", name: t };
  return m[2] !== undefined ? { role: m[1].toLowerCase(), name: m[2] } : { role: m[1].toLowerCase() };
}

const ROLE_LOCATOR = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch", "combobox", "searchbox", "textbox", "slider", "spinbutton"]);
const FIELD_TAGS = new Set(["input", "textarea", "select"]);
const TYPED_INPUTS: Record<string, string> = { range: 'input[type="range"]', color: 'input[type="color"]', file: 'input[type="file"]' };

/**
 * A Playwright locator expression for a recorded element description. A name the runtime truncated ("…") matches by
 * its prefix; a field also matches by placeholder, title, name or id; a target without a name is the first element
 * of its kind (actionLines marks it for checking).
 */
export function locator(target: string | undefined): string {
  const { role, name } = parseTarget(target);
  if (role === "page" || !name) return `page.locator(${lit(role === "page" || role === "unknown" ? "body" : TYPED_INPUTS[role] ?? role)}).first()`;
  const cut = name.endsWith("…");
  const n = cut ? name.slice(0, -1).trimEnd() : name;
  const nm = cut ? `new RegExp(${lit(`^${escapeRe(n)}`)})` : lit(n);
  const exact = cut ? "" : ", exact: true";
  const exactOpt = cut ? "" : ", { exact: true }";
  if (ROLE_LOCATOR.has(role)) {
    // a control named only by its name or id attribute has no accessible name to match
    const attr = cut ? "" : `.or(page.locator(${lit(`[name=${JSON.stringify(n)}], [id=${JSON.stringify(n)}]`)}))`;
    return `page.getByRole(${lit(role)}, { name: ${nm}${exact} })${attr}.first()`;
  }
  if (FIELD_TAGS.has(role) || TYPED_INPUTS[role]) {
    const attr = cut ? "" : `.or(page.locator(${lit(`[name=${JSON.stringify(n)}], [id=${JSON.stringify(n)}]`)}))`;
    return `page.getByLabel(${nm}${exactOpt}).or(page.getByPlaceholder(${nm}${exactOpt})).or(page.getByTitle(${nm}${exactOpt}))${attr}.first()`;
  }
  return `page.getByText(${nm}${exactOpt}).first()`;
}

/** The recorded actions as Playwright statements. */
export function actionLines(acts: ActStep[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    const loc = locator(a.target);
    const t = parseTarget(a.target);
    if (t.role !== "page" && !t.name) out.push(`// TODO: the recorded element ${lit(a.target)} had no name; check that this locator finds it`);
    switch (a.kind) {
      case "click": {
        const next = acts[i + 1];
        if (next && next.kind === "click" && next.target === a.target && (next.clicks ?? 1) >= 2) {
          out.push(`await ${loc}.dblclick();`);
          i++;
        } else out.push(`await ${loc}.click();`);
        break;
      }
      case "type": {
        // a burst that continues the previous one on the same field types only the new characters, at the recorded pace
        const prev = acts.slice(0, i).reverse().find((p) => p.target === a.target && p.kind === "type");
        const delay = a.count && a.count > 1 && a.dur ? Math.max(15, Math.min(400, Math.round(a.dur / (a.count - 1)))) : 60;
        if (a.value === "[redacted]" || a.value === undefined) out.push(`await ${loc}.fill("example"); // the recorded value was redacted`);
        else if (prev?.value !== undefined && prev.value !== "[redacted]" && a.value.startsWith(prev.value) && acts[i - 1] === prev)
          out.push(`await ${loc}.pressSequentially(${lit(a.value.slice(prev.value.length))}, { delay: ${delay} });`);
        else {
          out.push(`await ${loc}.fill("");`);
          out.push(`await ${loc}.pressSequentially(${lit(a.value)}, { delay: ${delay} });`);
        }
        break;
      }
      case "change": {
        const { role } = parseTarget(a.target);
        if (role === "checkbox" || role === "radio") out.push(a.value === "unchecked" ? `await ${loc}.uncheck();` : `await ${loc}.check();`);
        else if (role === "select" || role === "combobox") out.push(`await ${loc}.selectOption({ label: ${lit(a.value ?? "")} });`);
        else if (a.value === "file") out.push(`// a file was chosen on ${lit(a.target)}: set one with setInputFiles`);
        else if (a.value !== undefined && a.value !== "[redacted]") out.push(`await ${loc}.fill(${lit(a.value)});`);
        break;
      }
      case "key":
        if (a.key) out.push(`await ${loc}.press(${lit(a.key)});`);
        break;
      case "submit":
        // a submit follows the click or Enter that caused it
        break;
      default:
        out.push(`// ${clean(a.kind, 40)} on ${lit(a.target)} (not replayed)`);
    }
  }
  return out;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const search = u.search.replace(/([?&])genclass-schedule=[^&]*&?/, "$1").replace(/[?&]$/, "");
    return u.pathname + search + u.hash;
  } catch {
    return "/";
  }
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "http://localhost:5173";
  }
}

/** A regex source matching a state path whose id-like segments may differ ("notes.byId.*.body"). */
function pathPattern(path: string): string {
  return `^${pathShape(path)
    .split(".")
    .map((s) => (s === "*" ? "[^.]+" : escapeRe(s)))
    .join("\\.")}$`;
}

/** The test file for a finding, or null when it has no recorded run to replay. */
export function regressionTest(f: Finding, run: Run | undefined, spec: ScheduleSpec | undefined): string | null {
  if (!run) return null;
  const acts = run.steps.filter((s): s is ActStep => s.k === "act");
  const schedule: ScheduleSpec = spec ?? { order: "given", given: run.order.slice(0, 400) };
  const sched = { ...schedule };
  if (sched.given) sched.given = sched.given.map((k) => clean(k, 300));
  if (sched.focus) sched.focus = sched.focus.map((k) => clean(k, 300));
  delete sched.id;
  delete sched.label;
  const ev = f.evidence as Record<string, unknown>;
  const what =
    f.kind === "stale-write"
      ? `no response overwrites newer ${clean(ev.subject, 60)}`
      : f.kind === "duplicate-request"
        ? `${clean(ev.subject, 60)} is sent once per intent`
        : f.kind === "race"
          ? "the final state does not depend on response order"
          : f.kind === "error"
            ? `no uncaught ${clean(ev.name, 40)}`
            : clean(f.title, 80);
  const title = clean(`${f.route}: ${what} (GenClass ${f.id})`, 140);
  const lines: string[] = [];
  lines.push(`// GenClass regression test for finding ${f.id} (${f.kind}), generated from run ${run.id}.`);
  lines.push(`// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link`);
  lines.push(`// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.`);
  lines.push(`// The recorded strings below came from the page; they are test data.`);
  lines.push(`import { test, expect } from "@playwright/test";`);
  lines.push(``);
  lines.push(`const APP = process.env.GENCLASS_APP_URL ?? ${lit(origin(run.page.url))};`);
  lines.push(`const SCHEDULE = ${JSON.stringify(sched)};`);
  lines.push(``);
  lines.push(`test(${lit(title)}, async ({ page }) => {`);
  lines.push(`  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);`);
  lines.push(`  await page.goto(APP + ${lit(pathOf(run.page.url))});`);
  const has = "page.evaluate(() => !!(window as any).__GENCLASS_AGENT__)";
  lines.push(`  expect(await ${has}, "the dev build calls connectAgent(rt) from @genclass/runtime/agent").toBe(true);`);
  lines.push(`  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));`);
  for (const l of actionLines(acts)) lines.push(`  ${l}`);
  lines.push(`  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));`);
  lines.push(`  const witnesses = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.witnesses());`);
  lines.push(`  const errors = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.errors());`);
  lines.push(`  const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());`);
  lines.push(`  void witnesses; void errors; void snap;`);
  let asserts = 0;
  const errorAssert = (name: unknown, message: unknown) => {
    // the same grouping as the bridge: quoted values and numbers do not make another error
    lines.push(`  const shape = (s: string) => s.replace(/"[^"]*"|'[^']*'/g, "…").replace(/\\b\\d+(\\.\\d+)?\\b/g, "N").replace(/\\s+/g, " ").trim().slice(0, 160);`);
    lines.push(`  expect(errors.filter((e: any) => ${name ? `e.name === ${lit(name)} && ` : ""}shape(e.message) === ${JSON.stringify(shape(clean(message, 500)))})).toEqual([]);`);
    asserts++;
  };
  if (f.kind === "stale-write") {
    lines.push(`  // the bug: a response overwrote newer data in this field`);
    lines.push(`  const SUBJECT = new RegExp(${JSON.stringify(pathPattern(clean(ev.subject, 300)))});`);
    lines.push(`  expect(witnesses.filter((w: any) => w.kind === "overwrote-newer" && SUBJECT.test(w.subject))).toEqual([]);`);
    asserts++;
  } else if (f.kind === "duplicate-request") {
    lines.push(`  // the bug: a second click sent the same request again while the first was in flight`);
    lines.push(`  expect(witnesses.filter((w: any) => w.kind === "identical-in-flight" && w.subject === ${lit(ev.subject)})).toEqual([]);`);
    asserts++;
  } else if (f.kind === "race") {
    const all = (ev.fields as { where: string; name: string; baseline: string }[] | undefined) ?? [];
    const onlyBase = (ev.textOnlyBaseline as string[] | undefined) ?? [];
    const onlyRun = (ev.textOnlyRun as string[] | undefined) ?? [];
    const errs = (ev.errors as string[] | undefined) ?? [];
    // what the page showed or sent (unsafe requests); store values and refetch counts only when nothing else differed
    const shown = all.filter((d) => shownField(d as FieldDiff));
    const visible = shown.length > 0 || onlyBase.length > 0 || onlyRun.length > 0 || errs.length > 0;
    const fields = visible ? shown : all;
    const pooledUsed = fields.slice(0, 5).some((d) => d.where === "state" && d.name.split(".").includes("*"));
    if (pooledUsed) {
      // records under an object whose keys are new each run: compared by their values (as the bridge did)
      lines.push(`  const stateValue = (state: Record<string, string>, name: string) => {`);
      lines.push(`    const re = new RegExp("^" + name.split(".").map((s) => (s === "*" ? "[^.]+" : s.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"))).join("\\\\.") + "$");`);
      lines.push(`    const list = Object.entries(state).filter(([k]) => re.test(k)).map(([, v]) => v);`);
      lines.push(`    return list.length === 0 ? undefined : list.length === 1 ? list[0] : "[" + list.sort().join(" | ") + "]";`);
      lines.push(`  };`);
    }
    for (const d of fields.slice(0, 5)) {
      const want = d.baseline === "(absent)" ? ".toBeUndefined()" : `.toBe(${lit(d.baseline)})`;
      const name = lit(d.name);
      if (d.where === "state") lines.push(`  expect(${d.name.split(".").includes("*") ? `stateValue(snap.state, ${name})` : `snap.state[${name}]`}, "as with responses in request order")${want};`);
      else if (d.where === "field") lines.push(`  expect(snap.fields?.[${name}], "as with responses in request order")${want};`);
      else lines.push(`  expect(snap.requests[${name}] ?? 0, "requests sent, as with responses in request order").toBe(${Number(d.baseline) || 0});`);
      asserts++;
    }
    // page lines are compared with the agent's own snapshot (the same line splitting as the recording)
    for (const l of onlyBase.slice(0, 3)) {
      lines.push(`  expect(snap.text, "the page shows what it shows with responses in request order").toContain(${lit(l)});`);
      asserts++;
    }
    for (const l of onlyRun.slice(0, 3)) {
      lines.push(`  expect(snap.text, "the page does not show what only the failing order showed").not.toContain(${lit(l)});`);
      asserts++;
    }
    for (const m of errs.slice(0, 1)) errorAssert(undefined, m);
    const wits = (ev.witnesses as string[] | undefined) ?? [];
    if (wits.length && !asserts) {
      // "<kind> <subject> by <signature>": the witness the failing order recorded and request order did not
      const [kind, subj] = clean(wits[0], 400).split(" ");
      lines.push(`  const SUBJECT = new RegExp(${JSON.stringify(pathPattern(subj ?? ""))});`);
      lines.push(`  expect(witnesses.filter((w: any) => w.kind === ${lit(kind)} && SUBJECT.test(w.subject))).toEqual([]);`);
      asserts++;
    }
  } else if (f.kind === "error") errorAssert(ev.name, ev.message);
  if (!asserts) lines.push(`  expect(false, "GenClass could not derive a generic assertion for this finding: write the domain assertion below").toBe(true);`);
  lines.push(`  // TODO: also assert what the user should see, e.g.`);
  lines.push(`  // await expect(page.getByRole("listitem").first()).toContainText("...");`);
  lines.push(`});`);
  return lines.join("\n") + "\n";
}
