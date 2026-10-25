// The user steps for each hunt scenario, and the DOM oracle: the visible results must be the final term's results.
// Expected lists come from Mealie's own API (same parameters the composable sends), read once.

const API = "http://localhost:9000";
const form = new URLSearchParams({ username: "changeme@example.com", password: "MyPassword" });
const { access_token } = await (await fetch(`${API}/api/auth/token`, { method: "POST", body: form })).json();
export async function expectedFor(term) {
  const u = `${API}/api/recipes?search=${encodeURIComponent(term)}&page=1&orderBy=name&orderDirection=asc&perPage=20`;
  const j = await (await fetch(u, { headers: { authorization: `Bearer ${access_token}` } })).json();
  return j.items.map((r) => r.name);
}

const PAUSE = Number(process.env.HUNT_PAUSE ?? 600); // a hesitation longer than the 500 ms debounce

async function openDialog(page) {
  await page.getByPlaceholder("Press '/'").waitFor({ timeout: 60_000 });
  await page.keyboard.press("/");
  await page.locator("#arrow-search").waitFor();
}
const dialogNames = (page) => page.locator(".v-dialog .arrow-nav").evaluateAll((els) => els.map((e) => e.innerText.split("\n")[0].trim()));

function listOracle(expected) {
  return (shown) => {
    const ok = shown.length === expected.length && shown.every((n, i) => n === expected[i]);
    if (ok) return { ok, why: `${shown.length} results, all for the final term` };
    const extra = shown.filter((n) => !expected.includes(n));
    return { ok, why: `${shown.length} shown vs ${expected.length} expected; not in the final term's results: ${JSON.stringify(extra.slice(0, 4))}` };
  };
}

const chicken = await expectedFor("chicken");
const beef = await expectedFor("beef");

export const SCENARIOS = {
  // continuous typing: one debounced request
  "dialog-type": {
    path: "/g/home",
    route: "/g/home",
    async steps(page, d) {
      await openDialog(page);
      await page.locator("#arrow-search").pressSequentially("chicken", { delay: d });
    },
    read: dialogNames,
    oracle: listOracle(chicken),
  },
  // a hesitation mid-word: two debounced requests ("chi", then "chicken")
  "dialog-pause": {
    path: "/g/home",
    route: "/g/home",
    async steps(page, d) {
      await openDialog(page);
      const box = page.locator("#arrow-search");
      await box.pressSequentially("chi", { delay: d });
      await page.waitForTimeout(PAUSE);
      await box.pressSequentially("cken", { delay: d });
    },
    read: dialogNames,
    oracle: listOracle(chicken),
  },
  // a hesitation with one more key: the shortest gap the debounce allows
  "dialog-pause-short": {
    path: "/g/home",
    route: "/g/home",
    async steps(page, d) {
      await openDialog(page);
      const box = page.locator("#arrow-search");
      await box.pressSequentially("chicke", { delay: d });
      await page.waitForTimeout(PAUSE);
      await box.pressSequentially("n", { delay: d });
    },
    read: dialogNames,
    oracle: listOracle(chicken),
  },
  // type one term, wait past the debounce, then clear and retype a different one quickly
  "dialog-clear-retype": {
    path: "/g/home",
    route: "/g/home",
    async steps(page, d) {
      await openDialog(page);
      const box = page.locator("#arrow-search");
      await box.pressSequentially("salmon", { delay: d });
      await page.waitForTimeout(PAUSE);
      await box.press("Control+a");
      await box.press("Backspace");
      await box.pressSequentially("beef", { delay: d });
    },
    read: dialogNames,
    oracle: listOracle(beef),
  },
  // the ingredient editor's recipe link: focus/click search right away (no debounce), then the typed term
  "ingredient-link": {
    path: "/g/home/r/beef-stew?edit=true",
    route: "/g/home/r/beef-stew",
    async setup(page) {
      await page.locator("input[value='1 Cup Flour']").waitFor({ timeout: 60_000 });
      await page.evaluate(() => [...document.querySelectorAll("input")].find((i) => i.value === "1 Cup Flour")?.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      const pt = await page.evaluate(() => {
        const inp = [...document.querySelectorAll("input")].find((i) => i.value === "1 Cup Flour");
        const y = inp.getBoundingClientRect().y;
        const btns = [...document.querySelectorAll("button")].map((e) => [e, e.getBoundingClientRect()]).filter(([, r]) => Math.abs(r.y - y) < 20 && r.width > 0);
        btns.sort((a, b) => b[1].x - a[1].x);
        const r = btns[0][1];
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.move(pt.x, pt.y);
      await page.waitForTimeout(300);
      if (!(await page.getByText("Toggle Recipe").count())) await page.mouse.click(pt.x, pt.y);
      await page.getByText("Toggle Recipe").dispatchEvent("click");
      await page.getByRole("combobox", { name: "Choose Recipe" }).waitFor();
      await page.evaluate(() => window.__GENCLASS_AGENT__?.whenSettled(20_000));
    },
    async steps(page, d) {
      const field = page.getByRole("combobox", { name: "Choose Recipe" });
      await field.click();
      await field.pressSequentially(process.env.HUNT_TERM ?? "chicken", { delay: d });
    },
    async read(page) {
      const items = await page.locator(".v-overlay--active .v-list-item").allInnerTexts();
      const none = await page.locator(".v-overlay--active").getByText("No data available").count();
      return none ? ["(No data available)"] : items.map((s) => s.trim());
    },
    oracle(shown) {
      const term = (process.env.HUNT_TERM ?? "chicken").toLowerCase();
      const ok = shown.length > 0 && shown.every((n) => n.toLowerCase().includes(term));
      return { ok, why: ok ? `${shown.length} options shown, all match "${term}"` : `shown: ${JSON.stringify(shown.slice(0, 4))}` };
    },
  },
};
