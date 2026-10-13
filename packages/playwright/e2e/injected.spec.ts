// The default path of the fixture on a page that does not install GenClass itself: `install: "inject"` with the
// runtime served from this checkout's packages/runtime/dist (`runtime: "local"`), and the fixture's own chaos on
// /api/*. The app is a 30-line typeahead + create form with the two usual latent bugs (no ordering guard, no
// double-submit guard); its "server" is a context.route handler (page routes, where the chaos lives, run first).
import { expect, test as base } from "@playwright/test";
import { genclass, type GenClassFixtures } from "@genclass/playwright";

const ORIGIN = "http://genclass-fixture.localhost";

const test = base.extend<GenClassFixtures>(
  genclass({
    mode: "observe",
    install: "inject",
    runtime: "local",
    chaos: { latencyMs: [50, 800], reorder: true, failRate: 0.05, routes: [/\/api\//], seed: 7 },
    settle: { quietMs: 2000, maxMs: 10_000 },
  }),
);

const CITIES = ["Santiago", "San Diego", "San Jose", "Santa Fe", "Portland", "Porto", "Paris", "Parma", "Perth", "Pau"];

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>fixture app</title></head><body>
<h1>fixture app</h1>
<input id="q" aria-label="Search" autocomplete="off"><ul id="out"></ul>
<form id="f"><input id="title" aria-label="Title" value="Report 1"><button id="create" type="submit">Create</button></form>
<ul id="items"></ul>
<script>
  const out = document.getElementById("out");
  document.getElementById("q").addEventListener("input", async (e) => {
    const r = await fetch("/api/search?q=" + encodeURIComponent(e.target.value));
    if (!r.ok) return;
    const d = await r.json();
    out.textContent = d.items.join(", "); // no ordering guard: an older answer can land last
  });
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await fetch("/api/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: document.getElementById("title").value }) });
    if (!r.ok) return;
    const d = await r.json();
    const li = document.createElement("li"); li.textContent = d.title; document.getElementById("items").append(li);
  });
</script></body></html>`;

test.beforeEach(async ({ context }) => {
  let nextId = 0;
  await context.route(`${ORIGIN}/**`, async (route, request) => {
    const u = new URL(request.url());
    if (u.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML });
    if (u.pathname === "/api/search") {
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: CITIES.filter((c) => c.toLowerCase().startsWith(q)) }) });
    }
    if (u.pathname === "/api/items" && request.method() === "POST") {
      const body = request.postDataJSON() as { title?: string } | null;
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: ++nextId, title: body?.title ?? "" }) });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });
});

test("injected runtime: typeahead with reordered responses, then a double submit", async ({ page, genclass }) => {
  await page.goto(`${ORIGIN}/`);
  await expect(page.locator("h1")).toHaveText("fixture app");
  const state = await genclass.ready({ timeout: 150_000 });
  expect(state, "the injected runtime loads its model from jsDelivr on the runner").toBe("ready");
  await page.getByLabel("Search").click();
  await page.keyboard.type("santa", { delay: 90 });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace", { delay: 50 });
  await page.keyboard.type("port", { delay: 100 });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Create" }).dblclick();
  await page.waitForTimeout(3000);
  await genclass.settle();
  const snap = await genclass.snapshot();
  expect(snap, "window.GenClass.runtime is set by the injected script-tag build").not.toBeNull();
  expect(snap!.handle).toBe("GenClass.runtime");
  expect(snap!.mode).toBe("observe");
  expect(genclass.chaos?.matched ?? 0).toBeGreaterThan(0);
});
