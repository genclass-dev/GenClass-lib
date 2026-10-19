import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CDN_SCRIPT, dashboardPage, esc, ownEndpoint, RUNTIME_PKG, startPage } from "../src/pages.js";
import { call, setup } from "./account-helpers.js";

// Private mode (README "Self-host the collector (private mode)"): the same worker on the app owner's own Cloudflare
// account (wrangler.selfhost.toml). Its pages must hand out snippets that send to it, never to genclass.dev: the
// endpoint goes in GenClass.init or window.GENCLASS_CONFIG (a meta tag may only name same-origin URLs), and the CLI's
// init and login, which make their token at genclass.dev, are left out.

const ORIGIN = "https://genclass-collector.acme.workers.dev";
const EP = `${ORIGIN}/v1/events`;

/** The client-side snippets() of a page, as the browser runs it. */
function clientSnippets(html: string): (tok: string, ep: string) => [string, string, string][] {
  const src = /function snippets\(tok, ep\)\{[\s\S]*?\n\}/.exec(html)![0];
  return new Function(`${src}; return snippets;`)();
}

describe("private mode: a self-hosted collector's snippets name its own endpoint", () => {
  it("ownEndpoint: the collector's origin plus /v1/events, unless it is genclass.dev or not a plain origin", () => {
    expect(ownEndpoint({ DASHBOARD_ORIGIN: ORIGIN })).toBe(EP);
    expect(ownEndpoint({ AUTH_ORIGIN: `${ORIGIN}/` })).toBe(EP);
    expect(ownEndpoint({ DASHBOARD_ORIGIN: "http://localhost:8787" })).toBe("http://localhost:8787/v1/events");
    expect(ownEndpoint({})).toBeNull();
    expect(ownEndpoint({ DASHBOARD_ORIGIN: "https://genclass.dev" })).toBeNull();
    expect(ownEndpoint({ DASHBOARD_ORIGIN: "https://genclass.dev/" })).toBeNull();
    for (const bad of ["genclass-collector.acme.workers.dev", "javascript:alert(1)", 'https://a.dev/"><script>', "https://a.dev/path"]) {
      expect(ownEndpoint({ DASHBOARD_ORIGIN: bad }), bad).toBeNull();
    }
  });

  it("/start: every snippet sends to the endpoint, through GENCLASS_CONFIG or GenClass.init; no npx init", () => {
    const html = startPage("n", { endpoint: EP });
    expect(html).toContain(`renderSnippets(document.getElementById("snips"), j.token, ${JSON.stringify(EP)})`);
    const snippets = clientSnippets(html);
    const s = snippets("gc_TestToken0123456789abc", EP);
    expect(s.map((x) => x[0])).toEqual(["Easy: one script tag", "Easy: with a bundler", "Function-specific"]);
    expect(s[0]![2]).toBe(
      `<script>window.GENCLASS_CONFIG = { telemetry: { endpoint: "${EP}" } };</script>\n<script src="${CDN_SCRIPT}" data-token="gc_TestToken0123456789abc"></script>`,
    );
    expect(s[1]![2]).toContain(`<script>window.GENCLASS_CONFIG = { token: "gc_TestToken0123456789abc", telemetry: { endpoint: "${EP}" } };</script>`);
    expect(s[1]![2]).toContain('import "@genclass/runtime/auto";');
    expect(s[1]![2]).not.toContain('<meta name="genclass"');
    expect(s[2]![2]).toContain(`GenClass.init({ token: "gc_TestToken0123456789abc", scope: "functions", telemetry: { endpoint: "${EP}" } });`);
    expect(JSON.stringify(s)).not.toContain(`npx ${RUNTIME_PKG} init`);
    // on genclass.dev (no endpoint): the snippets as before, init included
    const d = clientSnippets(startPage("n"))("gc_TestToken0123456789abc", "");
    expect(d.map((x) => x[0])).toEqual(["Easy: one script tag", "Easy: with a bundler", "Function-specific", "Automatic setup"]);
    expect(d[0]![2]).toBe(`<script src="${CDN_SCRIPT}" data-token="gc_TestToken0123456789abc"></script>`);
    expect(JSON.stringify(d)).not.toContain("GENCLASS_CONFIG");
    expect(startPage("n")).toContain('renderSnippets(document.getElementById("snips"), j.token, "")');
  });

  it("the account Connect panel: the key with the endpoint, no npx login; a private link's setup passes the endpoint", () => {
    const project = { name: "Shop", token: "gc_TestToken0123456789abc", created: "", lastEvent: null };
    const account = { apps: [{ id: "0123456789abcdef", name: "Shop" }], current: "0123456789abcdef", email: "dev@example.com" };
    // the Connect panel itself (every page also carries the client-side snippet code, which names GENCLASS_CONFIG)
    const panel = (h: string) => /<section class="connect[\s\S]*?<\/section>/.exec(h)![0];
    const own = panel(dashboardPage("n", project, { account, id: "0123456789abcdef", endpoint: EP }));
    expect(own).toContain(esc(`GenClass.init({ token: "gc_TestToken0123456789abc", telemetry: { endpoint: "${EP}" } });`));
    expect(own).toContain(esc(`<script>window.GENCLASS_CONFIG = { telemetry: { endpoint: "${EP}" } };</script>`));
    expect(own).toContain("Add the key and this collector's endpoint");
    expect(own).not.toContain(`npx ${RUNTIME_PKG} login`);
    const plain = panel(dashboardPage("n", project, { account, id: "0123456789abcdef" }));
    expect(plain).toContain(`npx ${RUNTIME_PKG} login`);
    expect(plain).not.toContain("GENCLASS_CONFIG");
    // a private link's page embeds the endpoint for its setup snippets
    expect(dashboardPage("n", project, { endpoint: EP })).toContain(`"endpoint":"${EP}"`);
    expect(dashboardPage("n", project)).not.toContain('"endpoint"');
  });

  it("a collector with DASHBOARD_ORIGIN set: /start names its endpoint, new links point to it, and it takes events", async () => {
    const { env } = setup({ DASHBOARD_ORIGIN: ORIGIN });
    const start = await (await call(env, "GET", "/start", {})).text();
    expect(start).toContain(JSON.stringify(EP));
    const j = (await (await call(env, "POST", "/api/projects", { body: { name: "Private app" }, origin: null })).json()) as any;
    expect(j.dashboardUrl.startsWith(`${ORIGIN}/dashboard/`)).toBe(true);
    const r = await call(env, "POST", "/v1/events", {
      body: { schema: "genclass-telemetry/1", sid: "aaaaaaaaaaaa", sent: 1, runtime: "0.3.0", model: "0.2.0", token: j.token, events: [{ t: "session", seq: 0, host: "app.example", route: "/" }] },
      origin: null,
    });
    expect(r.status).toBe(202);
  });

  it("wrangler.selfhost.toml: no genclass.dev routes or site binding, the worker's own origins, the same bindings as production", () => {
    const self = readFileSync(new URL("../wrangler.selfhost.toml", import.meta.url), "utf8");
    const prod = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const code = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code(self)).not.toMatch(/genclass\.dev|^routes\s*=|\[\[services\]\]|account_id/m);
    expect(self).toMatch(/^workers_dev = true$/m);
    for (const v of ["AUTH_ORIGIN", "AUTH_RP_ID", "DASHBOARD_ORIGIN"]) expect(self).toMatch(new RegExp(`^${v} = "`, "m"));
    const names = (t: string, re: RegExp) => [...code(t).matchAll(re)].map((m) => m[1]).sort();
    expect(names(self, /^binding = "(\w+)"/gm)).toEqual(names(prod, /^binding = "(\w+)"/gm).filter((b) => b !== "SITE"));
    expect(names(self, /^name = "([A-Z_]+)"/gm)).toEqual(names(prod, /^name = "([A-Z_]+)"/gm));
    expect(self).toMatch(/^migrations_dir = "migrations"$/m);
    expect(self).toMatch(/^crons = \["17 3 \* \* \*"\]$/m);
  });
});
