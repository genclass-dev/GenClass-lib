// README claims that code or a measurement pins (Troy Bot check of 0.3.0-beta.0, 2026-10-17): the first-load limits
// the README quotes are the ones test/bundle.test.ts enforces, the Costs section keeps every main-thread result next
// to its own control, and Install's Next.js build-time switch is linked, placed after the numbered steps and shaped
// so a bundler can drop it. Text checks only: no build, no browser, no network. The wording is not pinned beyond the
// anchors that find each part: the section and subsection headings, the "**N. " step leads and "**ESM only.**".
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PKG = resolve(__dirname, "..");
const REPO = resolve(PKG, "..", "..");
const README = readFileSync(join(PKG, "README.md"), "utf8");

/** Markdown without its fenced code blocks (a `#` comment in a bash block is not a heading). */
const prose = (md: string): string => md.replace(/```[\s\S]*?```/g, "");

/** The `## <title>` section of the README, its heading line excluded, up to the next `## ` heading. */
function section(title: string): string {
  const start = README.indexOf(`\n## ${title}\n`);
  expect(start, `README has a "## ${title}" section`).toBeGreaterThan(-1);
  const body = README.slice(start + title.length + 5);
  const end = body.search(/\n## /);
  return end === -1 ? body : body.slice(0, end);
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading: string): string =>
  heading
    .replace(/`/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The markdown tables in `md`: runs of lines starting with "|", the header first. */
function tables(md: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const line of md.split("\n")) {
    if (line.startsWith("|")) cur.push(line);
    else if (cur.length) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

describe("README Performance and Costs: what is measured, with its own control (CONTRACT §0.5, performance)", () => {
  it("the first-load limits the README quotes are the ones test/bundle.test.ts enforces", () => {
    const src = readFileSync(join(PKG, "test", "bundle.test.ts"), "utf8");
    const m = src.match(/LIMIT_KB[^=]*=\s*\{\s*"auto\.js":\s*([\d.]+),\s*"index\.js":\s*([\d.]+)\s*\}/);
    expect(m, "LIMIT_KB in test/bundle.test.ts").not.toBeNull();
    const perf = section("Performance").replace(/\s+/g, " ");
    const quoted = [...perf.matchAll(/keeps them under (.*?)(?: \(|\. )/g)].map((q) => q[1]);
    for (const kb of [m![1], m![2]]) expect(new RegExp(`(?<![\\d.])${escape(kb)} KB`).test(perf), `README Performance names the ${kb} KB limit (it says: ${quoted.join("; ") || "no limit"})`).toBe(true);
  });

  it("no main-thread result in Costs stands alone: a 'no measurable change' sits in a table that also has the 0.3.0 measurement", () => {
    const stale = tables(section("Costs")).filter((t) => /no measurable change/i.test(t));
    for (const t of stale) {
      const header = t.split("\n")[0];
      // the 0.1.0-beta.3 control (?genclass=off) still loaded GenClass's code; 0.3.0-beta.0 was measured against a
      // build without it, so the two are shown side by side, each named
      expect(header, header).toContain("0.1.0-beta.3");
      expect(header, header).toContain("0.3.0-beta.0");
    }
  });
});

describe("README Install: only in some builds (Next.js), a build-time switch that ships nothing when off", () => {
  const HEADING = "Only in some builds (Next.js)";
  const ANCHOR = `#${slug(HEADING)}`;

  /** The subsection's text, up to the end of Install. */
  const subsection = (): string => {
    const install = section("Install");
    const at = install.indexOf(`\n### ${HEADING}\n`);
    expect(at, `Install has a "### ${HEADING}" subsection`).toBeGreaterThan(-1);
    return install.slice(at);
  };

  it("is the last part of Install, after the numbered steps and the ESM-only note, and they link to it", () => {
    const install = section("Install");
    const at = install.indexOf(`\n### ${HEADING}\n`);
    expect(at, `Install has a "### ${HEADING}" subsection`).toBeGreaterThan(-1);
    // the numbered steps by their "**N. " leads (their titles are not pinned) and the ESM-only note
    const steps = [...install.matchAll(/^\*\*\d+\. /gm)].map((m) => m.index!);
    expect(steps.length, "Install's numbered steps (**1. , **2. , ...)").toBeGreaterThanOrEqual(2);
    const esm = install.indexOf("**ESM only.**");
    expect(esm, "**ESM only.**").toBeGreaterThan(-1);
    const leads = [...steps, esm];
    for (const i of leads) expect(i, `${install.slice(i, i + 24)}... comes before the subsection`).toBeLessThan(at);
    // a ### heading before a step or the ESM-only note would put them under it; one after the subsection would make
    // it no longer the last part
    const h3 = [...install.matchAll(/\n### /g)].map((m) => m.index!);
    expect(h3.filter((i) => i < Math.max(...leads)), "no ### heading before the last step or the ESM-only note").toEqual([]);
    expect(h3[h3.length - 1], "the last ### heading in Install").toBe(at);
    // linked from the one-line install at the top, from step 2 and from the ESM-only note (which say "no require")
    expect(README.slice(0, README.indexOf("\n## Contents")), "the top of the README links to it").toContain(`(${ANCHOR})`);
    const paragraphs = install.slice(0, at).split(/\n\n/);
    for (const [what, lead] of [["step 2", /^\*\*2\. /], ["the ESM-only note", /^\*\*ESM only\.\*\*/]] as const) {
      const p = paragraphs.find((x) => lead.test(x));
      expect(p, what).toBeDefined();
      expect(p, what).toContain(`(${ANCHOR})`);
    }
    // the Next.js starter points at it from "Turning it off"
    const tpl = join(REPO, "templates", "nextjs", "README.md");
    if (existsSync(tpl)) expect(readFileSync(tpl, "utf8")).toContain(`packages/runtime/README.md${ANCHOR}`);
  });

  it("its snippets fold away when off: an always-defined env value, a static comparison, a synchronous require of a local module", () => {
    const blocks = [...subsection().matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
    // next.config: the variable is defined even when unset (Next inlines a NEXT_PUBLIC_* value only when it is set)
    const config = blocks.find((b) => /\benv\s*:/.test(b));
    expect(config, "a next.config block with env").toBeDefined();
    expect(config).toMatch(/env\s*:\s*\{\s*NEXT_PUBLIC_GENCLASS\s*:/);
    expect(config, "never undefined").toMatch(/NEXT_PUBLIC_GENCLASS\s*:[^,}\n]*(\?\?\s*""|:\s*"")/);
    // instrumentation-client: a comparison with a literal, and inside that if-block (comments aside) a synchronous
    // require of the app's own module; a require after the block's closing brace would ship and run in every build
    const client = blocks.find((b) => /\brequire\(/.test(b));
    expect(client, "an instrumentation-client block with require").toBeDefined();
    const code = client!.replace(/\/\/[^\n]*/g, "");
    expect(code, "the require sits inside the build-time if").toMatch(/if\s*\(\s*process\.env\.NEXT_PUBLIC_GENCLASS\s*===\s*"[^"]+"\s*\)\s*\{[^{}]*\brequire\(\s*"\.\.?\/[^"]+"\s*\)[^{}]*\}/);
    expect(client, "the package is ESM only: never required by name").not.toMatch(/require\(\s*["']@genclass/);
    // the local module imports the runtime with import, first
    const local = blocks.find((b) => /from "@genclass\/runtime\/auto"|import "@genclass\/runtime\/auto"/.test(b) && !/\brequire\(/.test(b));
    expect(local, "a local module that imports @genclass/runtime/auto").toBeDefined();
  });

  it("every in-page link in the README resolves to a heading", () => {
    const text = prose(README);
    const headings = new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
    const links = [...new Set([...text.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => m[1]))];
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((l) => !headings.has(l))).toEqual([]);
  });
});
