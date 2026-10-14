import { beforeAll, describe, expect, it } from "vitest";
import { planForPrice } from "../src/plans.js";
import { STRIPE_VERSION, WEBHOOK_EVENTS } from "../src/stripe.js";

// scripts/stripe-setup.mjs against a fake of daybot.ca's Stripe account, which also holds Polar Parts' products,
// prices, webhook endpoint and default Billing Portal configuration. The script must create, find and edit only
// GenClass's own objects, never list or change anything of Polar Parts', and never touch account-wide settings.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any;
beforeAll(async () => {
  setup = await import("../../scripts/stripe-setup.mjs");
});

type Obj = Record<string, any>;

/** Stripe's form fields as an object, nested keys kept flat ("metadata[genclass]"), arrays gathered ("enabled_events"). */
function fields(body: string): Obj {
  const out: Obj = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const arr = /^([a-z_]+)\[\d+\]$/.exec(k);
    if (arr) (out[arr[1]!] ??= []).push(v);
    else out[k] = v;
  }
  return out;
}
const meta = (f: Obj): Obj => Object.fromEntries(Object.entries(f).flatMap(([k, v]) => (/^metadata\[(.+)\]$/.test(k) ? [[/^metadata\[(.+)\]$/.exec(k)![1]!, v]] : [])));

/** A fake shared Stripe account: Polar Parts' objects in it, and whatever the script creates. */
function account() {
  const products = new Map<string, Obj>([["prod_polar0000001", { id: "prod_polar0000001", object: "product", name: "Snow tires", active: true, metadata: { sku: "PP-TIRE" }, statement_descriptor: "POLAR PARTS" }]]);
  const prices = new Map<string, Obj>([
    ["price_polar0000001", { id: "price_polar0000001", object: "price", product: "prod_polar0000001", lookup_key: "polar_tires_monthly", active: true, unit_amount: 18900, currency: "cad", recurring: { interval: "month" }, metadata: {} }],
  ]);
  const endpoints = new Map<string, Obj>([
    ["we_polar0000001", { id: "we_polar0000001", object: "webhook_endpoint", url: "https://polarparts.ca/api/stripe/webhook", description: "Polar Parts orders", enabled_events: ["*"], status: "enabled", metadata: {} }],
  ]);
  const portal = new Map<string, Obj>([["bpc_polardefault1", { id: "bpc_polardefault1", object: "billing_portal.configuration", is_default: true, active: true, metadata: {}, business_profile: { headline: "Polar Parts" } }]]);
  const customers = new Map<string, Obj>([["cus_polar0000001", { id: "cus_polar0000001", email: "ada@example.com", metadata: {} }]]);
  const calls: { method: string; url: URL; body: Obj }[] = [];
  let n = 0;
  const snapshot = () => JSON.stringify({ p: products.get("prod_polar0000001"), pr: prices.get("price_polar0000001"), w: endpoints.get("we_polar0000001"), c: portal.get("bpc_polardefault1"), cu: [...customers.values()] });
  const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
  const missing = (what: string) => ok({ error: { code: "resource_missing", message: `No such ${what}` } }, 404);
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = method === "POST" ? fields(String(init.body ?? "")) : {};
    calls.push({ method, url, body });
    expect(url.origin).toBe("https://api.stripe.com");
    expect(new Headers(init.headers).get("stripe-version")).toBe(STRIPE_VERSION);
    const p = url.pathname;
    const q = url.searchParams;
    let m: RegExpExecArray | null;
    if (method === "GET" && p === "/v1/products/search") {
      const want = /^metadata\['genclass_plan'\]:'([a-z]+)'$/.exec(q.get("query") ?? "");
      expect(want).not.toBeNull();
      return ok({ data: [...products.values()].filter((x) => x.metadata?.genclass_plan === want![1]), has_more: false });
    }
    if ((m = /^\/v1\/products\/([^/]+)$/.exec(p))) {
      const x = products.get(m[1]!);
      if (!x) return missing("product");
      if (method === "POST") {
        Object.assign(x, { name: body.name ?? x.name, description: body.description ?? x.description, statement_descriptor: body.statement_descriptor ?? x.statement_descriptor });
        if (body.active) x.active = body.active === "true";
        Object.assign(x.metadata, meta(body));
      }
      return ok(x);
    }
    if (method === "POST" && p === "/v1/products") {
      const id = body.id ?? `prod_made${++n}`;
      if (products.has(id)) return ok({ error: { message: "Product already exists." } }, 400);
      const x = { id, object: "product", active: true, name: body.name, description: body.description, statement_descriptor: body.statement_descriptor, metadata: meta(body) };
      products.set(id, x);
      return ok(x);
    }
    if (method === "GET" && p === "/v1/prices") {
      const key = q.get("lookup_keys[0]")!;
      expect(key.startsWith("genclass_")).toBe(true);
      return ok({ data: [...prices.values()].filter((x) => x.lookup_key === key).slice(0, 1), has_more: false });
    }
    if (method === "POST" && p === "/v1/prices") {
      if ([...prices.values()].some((x) => x.lookup_key === body.lookup_key)) return ok({ error: { message: "A price with this lookup_key already exists." } }, 400);
      const x = { id: `price_gc${String(++n).padStart(6, "0")}`, object: "price", product: body.product, unit_amount: Number(body.unit_amount), currency: body.currency, recurring: { interval: body["recurring[interval]"] }, lookup_key: body.lookup_key, active: true, metadata: meta(body) };
      prices.set(x.id, x);
      return ok(x);
    }
    if (method === "POST" && (m = /^\/v1\/prices\/([^/]+)$/.exec(p))) {
      const x = prices.get(m[1]!);
      if (!x) return missing("price");
      if ("lookup_key" in body) x.lookup_key = body.lookup_key;
      if ("active" in body) x.active = body.active === "true";
      return ok(x);
    }
    if (method === "GET" && p === "/v1/webhook_endpoints") return ok({ data: [...endpoints.values()], has_more: false });
    if (method === "POST" && p === "/v1/webhook_endpoints") {
      const x = { id: `we_gc${String(++n).padStart(6, "0")}`, object: "webhook_endpoint", url: body.url, description: body.description, enabled_events: body.enabled_events, api_version: body.api_version, metadata: meta(body), status: "enabled" };
      endpoints.set(x.id, x);
      return ok({ ...x, secret: `whsec_fresh_secret_${n}` });
    }
    if ((m = /^\/v1\/webhook_endpoints\/([^/]+)$/.exec(p))) {
      const x = endpoints.get(m[1]!);
      if (!x) return missing("webhook endpoint");
      if (method === "DELETE") {
        endpoints.delete(x.id);
        return ok({ id: x.id, deleted: true });
      }
      if (body.enabled_events) x.enabled_events = body.enabled_events;
      if (body.disabled === "false") x.status = "enabled";
      return ok(x);
    }
    if (method === "GET" && p === "/v1/billing_portal/configurations") {
      const d = q.get("is_default");
      return ok({ data: [...portal.values()].filter((c) => d === null || String(c.is_default) === d), has_more: false });
    }
    if (method === "POST" && p === "/v1/billing_portal/configurations") {
      const x = { id: `bpc_gc${String(++n).padStart(6, "0")}`, object: "billing_portal.configuration", is_default: false, active: true, metadata: meta(body), form: body };
      portal.set(x.id, x);
      return ok(x);
    }
    if (method === "POST" && (m = /^\/v1\/billing_portal\/configurations\/([^/]+)$/.exec(p))) {
      const x = portal.get(m[1]!);
      if (!x) return missing("configuration");
      Object.assign(x.metadata, meta(body));
      x.form = body;
      return ok(x);
    }
    return ok({ error: { message: `fake Stripe has no ${method} ${p}` } }, 404);
  };
  return { products, prices, endpoints, portal, customers, calls, fetch, snapshot };
}

async function run(a: ReturnType<typeof account>, o: { key?: string; argv?: string[] } = {}) {
  const out: string[] = [];
  const secrets: [string, string][] = [];
  const from = a.calls.length;
  await setup.main({
    argv: o.argv ?? [],
    env: { STRIPE_SECRET_KEY: o.key ?? "sk_test_fake" },
    fetch: a.fetch,
    log: (s: string) => out.push(s),
    putSecret: async (name: string, value: string) => {
      secrets.push([name, value]);
      return true;
    },
  });
  const calls = a.calls.slice(from);
  return { out: out.join("\n"), secrets, calls, writes: calls.filter((c) => c.method !== "GET") };
}

/** No request names a Polar Parts object, lists products or prices, or reads a customer or the default portal. */
function onlyGenClass(calls: { method: string; url: URL; body: Obj }[]) {
  for (const c of calls) {
    const text = `${c.method} ${c.url} ${JSON.stringify(c.body)}`;
    for (const x of ["polar", "Polar", "PP-", "bpc_polardefault1", "cus_"]) expect(text, text).not.toContain(x);
    expect(c.url.pathname.startsWith("/v1/customers"), text).toBe(false);
    if (c.method === "GET" && c.url.pathname === "/v1/products") throw new Error(`listed every product: ${text}`);
    if (c.method === "GET" && c.url.pathname === "/v1/prices") expect(c.url.searchParams.get("lookup_keys[0]")!.startsWith("genclass_"), text).toBe(true);
    if (c.method === "GET" && c.url.pathname === "/v1/billing_portal/configurations") expect(c.url.searchParams.get("is_default"), text).toBe("false");
    if (c.method === "DELETE") expect(c.url.pathname.startsWith("/v1/webhook_endpoints/we_gc"), text).toBe(true);
  }
}

describe("scripts/stripe-setup.mjs on the shared Stripe account (daybot.ca, also Polar Parts)", () => {
  it("first run: two GenClass products, their prices, one endpoint, one portal configuration; nothing of Polar Parts' read or changed", async () => {
    const a = account();
    const before = a.snapshot();
    const r = await run(a);
    expect(a.snapshot()).toBe(before);
    onlyGenClass(r.calls);
    expect(r.calls.some((c) => c.method === "DELETE")).toBe(false);

    // products: GenClass's ids, metadata and statement descriptor
    expect(a.products.get("genclass_pro")).toMatchObject({ name: "GenClass Pro", statement_descriptor: "GENCLASS", metadata: { genclass: "1", genclass_plan: "pro" } });
    expect(a.products.get("genclass_custom")).toMatchObject({ name: "GenClass Custom", statement_descriptor: "GENCLASS", metadata: { genclass: "1", genclass_plan: "custom" } });
    expect(a.products.size).toBe(3);
    // prices under GenClass's lookup keys, which the worker reads as the plans
    const made = [...a.prices.values()].filter((x) => x.id !== "price_polar0000001");
    expect(made.map((x) => [x.lookup_key, x.product, x.unit_amount, x.currency, x.recurring.interval])).toEqual([
      ["genclass_pro_monthly", "genclass_pro", 9900, "usd", "month"],
      ["genclass_custom_monthly", "genclass_custom", 59900, "usd", "month"],
    ]);
    for (const x of made) expect(planForPrice({ ...x, product: a.products.get(x.product) })?.id).toBe(x.lookup_key === "genclass_pro_monthly" ? "pro" : "custom");

    // one webhook endpoint: GenClass's URL and description, the worker's events and API version only
    const ours = [...a.endpoints.values()].filter((w) => w.id !== "we_polar0000001");
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ url: setup.WEBHOOK_URL, description: "GenClass billing", enabled_events: WEBHOOK_EVENTS, api_version: STRIPE_VERSION, metadata: { genclass: "1" } });
    expect(setup.WEBHOOK_URL).toBe("https://genclass.dev/api/billing/webhook");
    // its secret went to wrangler under the test-mode name, and was never printed
    expect(r.secrets).toEqual([["STRIPE_WEBHOOK_SECRET_TEST", expect.stringMatching(/^whsec_fresh_secret_/)]]);
    expect(r.out).not.toContain(r.secrets[0]![1]);

    // one portal configuration of GenClass's own: metadata, headline, GenClass's products only; the default untouched
    const configs = [...a.portal.values()].filter((c) => c.id !== "bpc_polardefault1");
    expect(configs).toHaveLength(1);
    const f = configs[0]!.form as Obj;
    expect(configs[0]).toMatchObject({ is_default: false, metadata: { genclass: "1" } });
    expect(f["business_profile[headline]"]).toMatch(/GenClass/);
    const listed = Object.entries(f).filter(([k]) => /^features\[subscription_update\]\[products\]\[\d+\]\[product\]$/.test(k)).map(([, v]) => v);
    expect(listed).toEqual(["genclass_pro", "genclass_custom"]);
    expect(Object.keys(f).some((k) => /is_default/.test(k))).toBe(false);

    // no account-wide setting is asked for; the ones that touch Polar Parts are named as the owner's call
    expect(r.out).not.toMatch(/Cancel the subscription/);
    expect(r.out).toMatch(/shared with Polar Parts/);
    expect(r.out).toMatch(/past due for 14 days/);
  });

  it("a second run changes nothing but rewriting its own portal configuration; --dry-run only reads", async () => {
    const a = account();
    await run(a);
    const config = [...a.portal.keys()].find((id) => id !== "bpc_polardefault1");
    const again = await run(a);
    expect(again.writes.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`POST /v1/billing_portal/configurations/${config}`]);
    expect(again.out).toMatch(/product GenClass Pro: genclass_pro, unchanged/);
    expect(again.out).toMatch(/webhook endpoint we_gc\d+: unchanged/);
    const fresh = account();
    const dry = await run(fresh, { argv: ["--dry-run"] });
    expect(dry.writes).toEqual([]);
    onlyGenClass(dry.calls);
    expect(dry.out).toMatch(/would create product GenClass Pro \(genclass_pro, statement descriptor GENCLASS\)/);
    expect(dry.out).toMatch(/would create GenClass's Billing Portal configuration/);
  });

  it("a price change retires the old price under a genclass_ key, so its subscribers keep their plan", async () => {
    const a = account();
    await run(a);
    const old = [...a.prices.values()].find((x) => x.lookup_key === "genclass_pro_monthly")!;
    old.unit_amount = 4900; // as if plans.json had said US$49 when it was made
    const r = await run(a);
    onlyGenClass(r.calls);
    expect(old).toMatchObject({ active: false, lookup_key: `genclass_pro_monthly_retired_${old.id}` });
    const current = [...a.prices.values()].find((x) => x.lookup_key === "genclass_pro_monthly")!;
    expect(current).toMatchObject({ unit_amount: 9900, product: "genclass_pro", active: true });
    expect(planForPrice({ ...old, product: a.products.get("genclass_pro") })?.id).toBe("pro");
    // Polar Parts' price is never archived
    expect(a.prices.get("price_polar0000001")!.active).toBe(true);
  });

  it("--new-webhook replaces only GenClass's endpoint (its exact URL and description); live mode stores the live secret", async () => {
    const a = account();
    await run(a, { key: "sk_live_fake" });
    const first = [...a.endpoints.keys()].find((id) => id !== "we_polar0000001")!;
    const r = await run(a, { key: "sk_live_fake", argv: ["--new-webhook"] });
    onlyGenClass(r.calls);
    expect(r.calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname)).toEqual([`/v1/webhook_endpoints/${first}`]);
    expect(a.endpoints.has("we_polar0000001")).toBe(true);
    expect([...a.endpoints.values()].filter((w) => w.url === setup.WEBHOOK_URL)).toHaveLength(1);
    expect(r.secrets.map(([name]) => name)).toEqual(["STRIPE_WEBHOOK_SECRET"]);
    expect(r.out).not.toMatch(/Revenue recovery, Retries: set/);
  });

  it("an endpoint for GenClass's URL that is not GenClass's stops the script before anything changes", async () => {
    const a = account();
    a.endpoints.set("we_someone00001", { id: "we_someone00001", url: "https://genclass.dev/api/billing/webhook", description: "added by hand", enabled_events: ["*"], status: "enabled", metadata: {} });
    const before = JSON.stringify([...a.endpoints.values()]);
    await expect(run(a, { argv: ["--new-webhook"] })).rejects.toThrow(/we_someone00001 also points at https:\/\/genclass.dev\/api\/billing\/webhook but is not described "GenClass billing"/);
    expect(a.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(JSON.stringify([...a.endpoints.values()])).toBe(before);
  });

  it("a product with GenClass's id but not its metadata, or a GenClass lookup key on another product, stops the script unchanged", async () => {
    const a = account();
    a.products.set("genclass_pro", { id: "genclass_pro", name: "Someone else's", active: true, metadata: {} });
    await expect(run(a)).rejects.toThrow(/a product with the id genclass_pro exists without metadata genclass_plan=pro/);
    expect(a.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(a.products.get("genclass_pro")).toEqual({ id: "genclass_pro", name: "Someone else's", active: true, metadata: {} });

    const b = account();
    b.prices.get("price_polar0000001")!.lookup_key = "genclass_pro_monthly";
    await expect(run(b)).rejects.toThrow(/the lookup key genclass_pro_monthly is on price price_polar0000001 of product prod_polar0000001/);
    expect(b.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(b.prices.get("price_polar0000001")).toMatchObject({ active: true, lookup_key: "genclass_pro_monthly" });
  });

  it("an earlier run's product (an id Stripe chose) is found by its metadata; the default portal configuration is never used", async () => {
    const a = account();
    a.products.set("prod_earlier00001", { id: "prod_earlier00001", name: "GenClass Pro", description: "old", active: true, metadata: { genclass_plan: "pro" } });
    // the account's default configuration carrying GenClass's metadata (copied by hand, say) is still not GenClass's
    a.portal.get("bpc_polardefault1")!.metadata = { genclass: "1" };
    const before = JSON.stringify(a.portal.get("bpc_polardefault1"));
    const r = await run(a);
    expect(a.products.has("genclass_pro")).toBe(false);
    expect(a.products.get("prod_earlier00001")).toMatchObject({ statement_descriptor: "GENCLASS", metadata: { genclass: "1", genclass_plan: "pro" } });
    expect([...a.prices.values()].find((x) => x.lookup_key === "genclass_pro_monthly")!.product).toBe("prod_earlier00001");
    expect(JSON.stringify(a.portal.get("bpc_polardefault1"))).toBe(before);
    expect(r.calls.some((c) => c.url.pathname.includes("bpc_polardefault1"))).toBe(false);
    expect([...a.portal.values()].filter((c) => !c.is_default)).toHaveLength(1);
  });
});
