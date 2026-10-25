import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { accessOf } from "../src/plans.js";
import { resetStripeCache } from "../src/stripe.js";
import {
  call,
  deliver,
  fakeStripe,
  GENCLASS_PORTAL,
  invoice,
  now,
  resetClock,
  setPlan,
  setup,
  signedIn,
  stripeEvent,
  subscription,
  WEBHOOK_SECRET,
} from "./account-helpers.js";

// Selling one paid plan, on the plans as they were on 2026-10-21 (test/fixtures/plans-individual.json: Free,
// Individual at US$29 a month on Stripe Checkout with a classifier a person trains, Enterprise by email and by
// GenClass's own grant). The real plans sell nothing on the site (test/plans.test.ts); this keeps the one-plan
// Checkout, the billing page's Upgrade button and the purchase a person follows up exercised.
vi.mock("../../billing/plans.json", async () => ({ default: (await import("./fixtures/plans-individual.json")).default }));

// a live-mode key: Individual on sale to everyone (fetch is always the fake Stripe)
const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});

const text = async (r: Promise<Response> | Response) => (await r).text();
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!doctype html>/gi, "");

describe("Individual on Stripe Checkout, Enterprise by email", () => {
  it("accessOf: a paid Individual, and GenClass's grant (Enterprise, listed after it) over it while the grant runs", () => {
    const at = new Date("2026-10-19T12:00:00Z");
    const row = (o: Record<string, unknown> = {}) => ({ plan: "free", stripe_mode: null, comp_until: null, ...o });
    expect(accessOf(row({ plan: "individual" }), "live", at)).toMatchObject({ source: "paid", plan: { id: "individual" } });
    expect(accessOf(row({ plan: "individual", comp_until: "2026-12-31T00:00:00.000Z" }), "live", at)).toMatchObject({ source: "comp", plan: { id: "enterprise" } });
  });

  it("checkout sells Individual by its lookup key on standard Checkout; Enterprise and the old plans have no Checkout", async () => {
    const { env } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    const s = fakeStripe();
    const r = await call(env, "POST", "/api/billing/checkout", { body: { plan: "individual" }, cookie, fetch: s.fetch });
    expect(r.status).toBe(200);
    const prices = s.calls.find((c) => c.method === "GET" && c.url.pathname === "/v1/prices")!;
    expect(prices.url.searchParams.get("lookup_keys[0]")).toBe("genclass_individual_monthly");
    const session = s.calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions")!;
    expect(Object.fromEntries(session.form!)).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_indiv00001",
      "metadata[genclass_plan]": "individual",
      "metadata[genclass_account]": account.id,
      payment_method_collection: "always",
      "subscription_data[billing_mode][type]": "flexible",
    });
    for (const k of session.form!.keys()) expect(k).not.toMatch(/trial|managed_payments/);
    for (const plan of ["enterprise", "free", "pro", "custom"]) {
      const no = await call(env, "POST", "/api/billing/checkout", { body: { plan }, cookie, fetch: s.fetch });
      expect(no.status, plan).toBe(400);
      expect(((await no.json()) as any).error).toBe("choose a plan: individual");
    }
  });

  it("the billing page: Free with the dashboard, Upgrade to Individual, Talk to us for Enterprise, no switch", async () => {
    const off = setup();
    const a = await signedIn(off.env);
    const closed = await text(call(off.env, "GET", "/account/billing", { cookie: a.cookie }));
    // not on sale (no key): no Upgrade button, but Enterprise's Talk to us is a mailto link whatever the key
    expect(closed).not.toContain("data-plan=");
    expect(closed).toContain('<a class="btn ghost" href="mailto:mehar@daybot.ca?subject=GenClass%20Enterprise"><span>Talk to us</span></a>');

    const on = setup(LIVE);
    const b = await signedIn(on.env);
    const page = await text(call(on.env, "GET", "/account/billing", { cookie: b.cookie }));
    expect(page).toContain("the runtime, its on-device model and the dashboard, with 90 days of history (you have 0 apps).");
    expect(page).toContain('<button class="btn" type="button" data-plan="individual"><span>Upgrade to Individual</span></button>');
    expect(page).not.toContain('data-plan="enterprise"');
    expect(page).toContain("$29 / month");
    expect(page).toContain('<p class="price">By agreement</p>');
    expect(page).toContain('Questions about Enterprise, self-hosting or invoices? Email <a href="mailto:mehar@daybot.ca">mehar@daybot.ca</a>.');
    expect(page).not.toMatch(/Switching between|To switch between/);
    expect(visible(page)).not.toMatch(/—|!/);

    // paying for Individual: a person emails the buyer; still no switch with one paid plan
    setPlan(on.sql, b.account.id, "individual", { stripe_customer_id: "cus_b000000001", subscription_id: "sub_b000000001", subscription_status: "active", current_period_end: "2026-11-19T12:00:00.000Z" });
    const paid = await text(call(on.env, "GET", "/account/billing", { cookie: b.cookie }));
    expect(paid).toContain("You are on the <b>Individual</b> plan, $29 / month.");
    expect(paid).toContain("emails ada@example.com within 1 business day of your purchase");
    expect(paid).not.toContain("data-plan=");
    expect(paid).not.toMatch(/To switch between/);

    // GenClass's grant gives Enterprise
    setPlan(on.sql, b.account.id, "free", { stripe_customer_id: null, subscription_id: null, subscription_status: null, current_period_end: null, comp_until: "9999-12-31T00:00:00.000Z" });
    const granted = await text(call(on.env, "GET", "/account/billing", { cookie: b.cookie }));
    expect(granted).toContain("You have <b>Enterprise</b>, set up by GenClass.");
    expect(granted).toContain('<span class="tag">Set up by GenClass</span>');
    expect(((await (await call(on.env, "GET", "/api/billing", { cookie: b.cookie })).json()) as any).access).toBe("comp");
  });

  it("a paid Individual purchase is recorded once for a person to follow up, and the owner's notice names the plan", async () => {
    const t = setup({ ...LIVE, NOTIFY_WEBHOOK: "https://hooks.example.com/notify" });
    const a = await signedIn(t.env);
    const s = fakeStripe();
    t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001', stripe_mode = 'live' WHERE id = ?").run(a.account.id);
    s.genclassCustomer("cus_ada0000001", a.account.id);
    s.subs.set("sub_ada0000001", subscription("sub_ada0000001", a.account.id, "cus_ada0000001", "genclass_individual_monthly"));
    const sub = s.subs.get("sub_ada0000001")!;
    s.invoices.set("in_ada0000001", invoice("in_ada0000001", "cus_ada0000001", "sub_ada0000001", [["price_indiv00001", 2900]], "paid"));
    sub.latest_invoice = "in_ada0000001";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await deliver(t.env, stripeEvent("customer.subscription.created", sub), s.fetch)).status).toBe(200);
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), s.fetch)).status).toBe(200);
    log.mockRestore();
    expect(t.sql.rows("SELECT plan FROM accounts")).toEqual([{ plan: "individual" }]);
    const rows = t.sql.rows("SELECT id, account_id, subscription_id, mode FROM custom_requests");
    expect(rows).toEqual([{ id: rows[0]!.id, account_id: a.account.id, subscription_id: "sub_ada0000001", mode: "live" }]);
    expect(s.other).toHaveLength(1);
    const notice = JSON.parse(s.other[0]!.body);
    expect(notice).toMatchObject({ event: "custom_purchase", request_id: rows[0]!.id, account_id: a.account.id });
    expect(notice.text).toBe(`GenClass Individual plan bought: request ${rows[0]!.id}, account ${a.account.id}. The buyer's email is in custom_requests; write to them within 1 business day.`);
    expect(now().toISOString()).toBe(t.sql.rows("SELECT notified FROM custom_requests")[0]!.notified);
  });
});
