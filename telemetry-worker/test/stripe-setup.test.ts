import { beforeAll, describe, expect, it } from "vitest";
import { CONTACT_PLANS, PAID_PLANS, planForPrice } from "../src/plans.js";
import { STRIPE_VERSION, WEBHOOK_EVENTS } from "../src/stripe.js";

// scripts/stripe-setup.mjs against a fake Stripe account that also holds another business's objects (Polar Parts'
// products, prices, webhook endpoint, default Billing Portal configuration and another, non-default, one), as
// daybot.ca's shared account did. GenClass now has an account of its own; the script still must create, find and edit
// only GenClass's own objects, never change anything else, and never touch account-wide settings. One plan is sold
// through Stripe (billing/plans.json sale "stripe": Individual); the contact plan (Enterprise) never becomes a product.

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
  const portal = new Map<string, Obj>([
    ["bpc_polardefault1", { id: "bpc_polardefault1", object: "billing_portal.configuration", is_default: true, active: true, metadata: {}, business_profile: { headline: "Polar Parts" } }],
    // Polar Parts' own API-made configuration (one per storefront, say): not the default, and not GenClass's
    ["bpc_polarstore01", { id: "bpc_polarstore01", object: "billing_portal.configuration", is_default: false, active: true, metadata: { storefront: "winter" }, business_profile: { headline: "Polar Parts winter store" } }],
  ]);
  const customers = new Map<string, Obj>([["cus_polar0000001", { id: "cus_polar0000001", email: "ada@example.com", metadata: {} }]]);
  const calls: { method: string; url: URL; body: Obj }[] = [];
  let n = 0;
  const snapshot = () =>
    JSON.stringify({ p: products.get("prod_polar0000001"), pr: prices.get("price_polar0000001"), w: endpoints.get("we_polar0000001"), c: portal.get("bpc_polardefault1"), s: portal.get("bpc_polarstore01"), cu: [...customers.values()] });
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
        Object.assign(x, { name: body.name ?? x.name, description: body.description ?? x.description, statement_descriptor: body.statement_descriptor ?? x.statement_descriptor, tax_code: body.tax_code ?? x.tax_code });
        if (body.active) x.active = body.active === "true";
        Object.assign(x.metadata, meta(body));
      }
      return ok(x);
    }
    if (method === "POST" && p === "/v1/products") {
      const id = body.id ?? `prod_made${++n}`;
      if (products.has(id)) return ok({ error: { message: "Product already exists." } }, 400);
      const x = { id, object: "product", active: true, name: body.name, description: body.description, statement_descriptor: body.statement_descriptor, tax_code: body.tax_code ?? null, metadata: meta(body) };
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
    for (const x of ["polar", "Polar", "PP-", "bpc_polardefault1", "bpc_polarstore01", "winter", "cus_"]) expect(text, text).not.toContain(x);
    expect(c.url.pathname.startsWith("/v1/customers"), text).toBe(false);
    if (c.method === "GET" && c.url.pathname === "/v1/products") throw new Error(`listed every product: ${text}`);
    if (c.method === "GET" && c.url.pathname === "/v1/prices") expect(c.url.searchParams.get("lookup_keys[0]")!.startsWith("genclass_"), text).toBe(true);
    if (c.method === "GET" && c.url.pathname === "/v1/billing_portal/configurations") expect(c.url.searchParams.get("is_default"), text).toBe("false");
    if (c.method === "DELETE") expect(c.url.pathname.startsWith("/v1/webhook_endpoints/we_gc"), text).toBe(true);
  }
}

describe("scripts/stripe-setup.mjs on the shared Stripe account (daybot.ca, also Polar Parts)", () => {
  it("first run: one GenClass product (the plan sold through Stripe), its price, one endpoint, one portal configuration; nothing of Polar Parts' read or changed", async () => {
    const a = account();
    const before = a.snapshot();
    const r = await run(a);
    expect(a.snapshot()).toBe(before);
    onlyGenClass(r.calls);
    expect(r.calls.some((c) => c.method === "DELETE")).toBe(false);

    // the product: GenClass's id, metadata, statement descriptor and tax code (SaaS, business use: eligible for
    // Managed Payments); one per plan sold through Stripe, and none for a contact plan
    expect(PAID_PLANS.map((p) => p.id)).toEqual(["individual"]);
    expect(CONTACT_PLANS.map((p) => p.id)).toEqual(["enterprise"]);
    expect(a.products.get("genclass_individual")).toMatchObject({ name: "GenClass Individual", statement_descriptor: "GENCLASS", tax_code: "txcd_10103001", metadata: { genclass: "1", genclass_plan: "individual" } });
    expect(a.products.size).toBe(2);
    expect([...a.products.values()].some((x) => /enterprise|free/i.test(`${x.id} ${x.name} ${x.metadata?.genclass_plan}`))).toBe(false);
    expect(r.calls.some((c) => /enterprise/i.test(`${c.url} ${JSON.stringify(c.body)}`))).toBe(false);
    // the price under GenClass's lookup key, which the worker reads as the plan
    const made = [...a.prices.values()].filter((x) => x.id !== "price_polar0000001");
    expect(made.map((x) => [x.lookup_key, x.product, x.unit_amount, x.currency, x.recurring.interval])).toEqual([["genclass_individual_monthly", "genclass_individual", 2000, "usd", "month"]]);
    for (const x of made) expect(planForPrice({ ...x, product: a.products.get(x.product) })?.id).toBe("individual");

    // one webhook endpoint: GenClass's URL and description, the worker's events and API version only
    const ours = [...a.endpoints.values()].filter((w) => w.id !== "we_polar0000001");
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ url: setup.WEBHOOK_URL, description: "GenClass billing", enabled_events: WEBHOOK_EVENTS, api_version: STRIPE_VERSION, metadata: { genclass: "1" } });
    expect(setup.WEBHOOK_URL).toBe("https://genclass.dev/api/billing/webhook");
    // one portal configuration of GenClass's own: metadata, headline, no plan switch; Polar Parts' untouched
    const configs = [...a.portal.values()].filter((c) => !c.id.startsWith("bpc_polar"));
    expect(configs).toHaveLength(1);
    const f = configs[0]!.form as Obj;
    expect(configs[0]).toMatchObject({ is_default: false, metadata: { genclass: "1" } });
    expect(f["business_profile[headline]"]).toMatch(/GenClass/);
    // no plan switch in the portal: a Managed Payments subscription cannot take another price (and there is one plan)
    expect(f["features[subscription_update][enabled]"]).toBe("false");
    expect(Object.keys(f).some((k) => /^features\[subscription_update\]\[(products|default_allowed_updates|proration_behavior)/.test(k))).toBe(false);
    expect(Object.keys(f).some((k) => /is_default/.test(k))).toBe(false);
    // a buyer may change the email and tax id of their GenClass customer, never an address (GenClass needs none)
    const updates = Object.entries(f).filter(([k]) => /^features\[customer_update\]\[allowed_updates\]\[\d+\]$/.test(k)).map(([, v]) => v);
    expect(updates).toEqual(["email", "tax_id"]);
    // Polar Parts' configurations were listed (to find GenClass's) but never written
    expect(r.calls.filter((c) => c.method === "POST" && c.url.pathname.startsWith("/v1/billing_portal/configurations/")).map((c) => c.url.pathname)).toEqual([]);

    // the webhook secret went to wrangler under the test-mode name and was never printed; the configuration's id
    // under its test-mode name, for the worker to fetch it by id
    expect(r.secrets).toEqual([
      ["STRIPE_WEBHOOK_SECRET_TEST", expect.stringMatching(/^whsec_fresh_secret_/)],
      ["STRIPE_PORTAL_CONFIGURATION_TEST", configs[0]!.id],
    ]);
    expect(r.out).not.toContain(r.secrets[0]![1]);

    // no account-wide setting is changed by the script; the owner's dashboard steps for GenClass's own account are
    // printed instead, and the Polar Parts checks of the shared account are gone
    expect(r.out).toMatch(/Settings, Managed Payments: accept the terms and turn it on/);
    expect(r.out).toMatch(/Smart Retries on, failed-payment emails on, and when all retries for a payment fail,\s+cancel the subscription/);
    expect(r.out).toMatch(/past due for 14 days/);
    expect(r.out).toMatch(/receipts for successful payments on/);
    expect(r.out).toMatch(/Settings, Branding/);
    expect(r.out).toMatch(/Stripe Tax: the head office address, and threshold monitoring on/);
    expect(r.out).toMatch(/choose Upgrade to Individual and pay with card/);
    expect(r.out).toMatch(/only while billing\/plans.json\s+has Individual on sale/);
    expect(r.out).not.toMatch(/Polar Parts|custom_requests|Switch to/);
    expect(r.out).toMatch(/SELECT COUNT\(\*\) AS n FROM accounts WHERE stripe_customer_id IS NOT NULL OR subscription_id IS NOT NULL/);
  });

  it("a second run changes nothing but rewriting its own portal configuration; --dry-run only reads", async () => {
    const a = account();
    await run(a);
    const config = [...a.portal.keys()].find((id) => !id.startsWith("bpc_polar"));
    const again = await run(a);
    expect(again.writes.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`POST /v1/billing_portal/configurations/${config}`]);
    // its id is stored again (the worker may have lost it); no new webhook secret
    expect(again.secrets).toEqual([["STRIPE_PORTAL_CONFIGURATION_TEST", config]]);
    expect(again.out).toMatch(/product GenClass Individual: genclass_individual, unchanged/);
    expect(again.out).toMatch(/webhook endpoint we_gc\d+: unchanged/);
    const fresh = account();
    const dry = await run(fresh, { argv: ["--dry-run"] });
    expect(dry.writes).toEqual([]);
    expect(dry.secrets).toEqual([]);
    onlyGenClass(dry.calls);
    expect(dry.out).toMatch(/would store its id as STRIPE_PORTAL_CONFIGURATION_TEST/);
    expect(dry.out).toMatch(/would create product GenClass Individual \(genclass_individual, statement descriptor GENCLASS, tax code txcd_10103001\)/);
    expect(dry.out).toMatch(/would create GenClass's Billing Portal configuration/);
  });

  it("a product whose tax code differs gets plans.json's; an expanded tax code that matches is left alone", async () => {
    const a = account();
    await run(a);
    // Stripe may return the tax code expanded: the same code is no change
    a.products.get("genclass_individual")!.tax_code = { id: "txcd_10103001", object: "tax_code" };
    const same = await run(a);
    expect(same.writes.filter((c) => c.url.pathname.startsWith("/v1/products"))).toEqual([]);
    expect(same.out).toMatch(/product GenClass Individual: genclass_individual, unchanged/);
    a.products.get("genclass_individual")!.tax_code = "txcd_10000000";
    const r = await run(a);
    onlyGenClass(r.calls);
    expect(r.writes.filter((c) => c.url.pathname.startsWith("/v1/products")).map((c) => [c.url.pathname, c.body.tax_code])).toEqual([["/v1/products/genclass_individual", "txcd_10103001"]]);
    expect(a.products.get("genclass_individual")!.tax_code).toBe("txcd_10103001");
    expect(r.out).toMatch(/update product GenClass Individual \(genclass_individual, tax code txcd_10103001\)/);
  });

  it("a price change retires the old price under a genclass_ key, so its subscribers keep their plan", async () => {
    const a = account();
    await run(a);
    const old = [...a.prices.values()].find((x) => x.lookup_key === "genclass_individual_monthly")!;
    old.unit_amount = 1500; // as if plans.json had said US$15 when it was made
    const r = await run(a);
    onlyGenClass(r.calls);
    expect(old).toMatchObject({ active: false, lookup_key: `genclass_individual_monthly_retired_${old.id}` });
    const current = [...a.prices.values()].find((x) => x.lookup_key === "genclass_individual_monthly")!;
    expect(current).toMatchObject({ unit_amount: 2000, product: "genclass_individual", active: true });
    expect(planForPrice({ ...old, product: a.products.get("genclass_individual") })?.id).toBe("individual");
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
    expect(r.secrets.map(([name]) => name)).toEqual(["STRIPE_WEBHOOK_SECRET", "STRIPE_PORTAL_CONFIGURATION"]);
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
    a.products.set("genclass_individual", { id: "genclass_individual", name: "Someone else's", active: true, metadata: {} });
    await expect(run(a)).rejects.toThrow(/a product with the id genclass_individual exists without metadata genclass_plan=individual/);
    expect(a.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(a.products.get("genclass_individual")).toEqual({ id: "genclass_individual", name: "Someone else's", active: true, metadata: {} });

    const b = account();
    b.prices.get("price_polar0000001")!.lookup_key = "genclass_individual_monthly";
    await expect(run(b)).rejects.toThrow(/the lookup key genclass_individual_monthly is on price price_polar0000001 of product prod_polar0000001/);
    expect(b.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(b.prices.get("price_polar0000001")).toMatchObject({ active: true, lookup_key: "genclass_individual_monthly" });
  });

  it("an earlier run's product (an id Stripe chose) is found by its metadata; the default portal configuration is never used", async () => {
    const a = account();
    a.products.set("prod_earlier00001", { id: "prod_earlier00001", name: "GenClass Individual", description: "old", active: true, metadata: { genclass_plan: "individual" } });
    // the account's default configuration carrying GenClass's metadata (copied by hand, say) is still not GenClass's
    a.portal.get("bpc_polardefault1")!.metadata = { genclass: "1" };
    const before = JSON.stringify(a.portal.get("bpc_polardefault1"));
    const r = await run(a);
    expect(a.products.has("genclass_individual")).toBe(false);
    expect(a.products.get("prod_earlier00001")).toMatchObject({ statement_descriptor: "GENCLASS", metadata: { genclass: "1", genclass_plan: "individual" } });
    expect([...a.prices.values()].find((x) => x.lookup_key === "genclass_individual_monthly")!.product).toBe("prod_earlier00001");
    expect(JSON.stringify(a.portal.get("bpc_polardefault1"))).toBe(before);
    expect(r.calls.some((c) => c.url.pathname.includes("bpc_polardefault1"))).toBe(false);
    expect([...a.portal.values()].filter((c) => !c.is_default && !c.id.startsWith("bpc_polar"))).toHaveLength(1);
  });

  it("a Polar Parts configuration that is not the default is read in the list but never adopted or written", async () => {
    const a = account();
    const before = JSON.stringify(a.portal.get("bpc_polarstore01"));
    await run(a);
    const r = await run(a);
    expect(JSON.stringify(a.portal.get("bpc_polarstore01"))).toBe(before);
    expect(r.calls.some((c) => c.method !== "GET" && c.url.pathname.includes("bpc_polarstore01"))).toBe(false);
    expect(r.secrets.map(([, v]) => v)).not.toContain("bpc_polarstore01");
  });

  it("when wrangler cannot store the configuration's id, the script stops and prints the command to set it", async () => {
    const a = account();
    const out: string[] = [];
    await expect(
      setup.main({ argv: [], env: { STRIPE_SECRET_KEY: "sk_test_fake" }, fetch: a.fetch, log: (s: string) => out.push(s), putSecret: async (name: string) => name !== "STRIPE_PORTAL_CONFIGURATION_TEST" }),
    ).rejects.toThrow(/wrangler did not store STRIPE_PORTAL_CONFIGURATION_TEST .* echo bpc_gc\d+ \| npx --yes wrangler@4 secret put STRIPE_PORTAL_CONFIGURATION_TEST/);
  });
});
