// VibeShop after a careful fix (what Claude should end up with; open the page with ?code=fixed to compare).
//   1. Search keeps only the answer to the latest query (and cancels the older request).
//   2. Buy now is disabled while an order is on its way, and the order carries an idempotency key.
//   3. Autosave records what was saved, but never writes the server's copy over text typed since.

const rt = window.GenClass?.runtime ?? null;

function plainStore(value) {
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      value = typeof next === "function" ? next(value) : next;
      for (const f of subs) f(value);
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}
const initial = { query: "", results: [], resultsFor: "", orders: [], draft: "", saved: "" };
export const store = rt ? rt.atom("shop", initial) : plainStore(initial);
export const cart = `cart_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const $ = (id) => document.getElementById(id);
const search = $("search");
const buy = $("buy");
const note = $("note");

// 1. Search as you type: only the latest query's answer is shown
let latest = 0;
let inflight = null;
search.addEventListener("input", async () => {
  const q = search.value;
  const mine = ++latest;
  inflight?.abort();
  inflight = new AbortController();
  store.set((s) => ({ ...s, query: q }));
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: inflight.signal });
    const data = await res.json();
    if (mine !== latest) return;
    store.set((s) => ({ ...s, results: data.items, resultsFor: data.q }));
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  }
});

// 2. Buy now: one order per click, however impatient the click
let ordering = false;
buy.addEventListener("click", async () => {
  if (ordering) return;
  ordering = true;
  buy.disabled = true;
  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `${cart}-1` },
      body: JSON.stringify({ item: "VibePods", cart }),
    });
    const order = await res.json();
    store.set((s) => ({ ...s, orders: [...s.orders, order.id] }));
  } finally {
    ordering = false;
    buy.disabled = false;
  }
});

// 3. Notes with autosave: the box is the user's; the server's answer only updates "Saved"
let timer;
note.addEventListener("input", () => {
  store.set((s) => ({ ...s, draft: note.value }));
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const res = await fetch("/api/note", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: store.get().draft }),
    });
    const saved = await res.json();
    store.set((s) => ({ ...s, saved: saved.text }));
  }, 300);
});

store.subscribe((s) => {
  $("results-for").textContent = s.resultsFor ? `Results for "${s.resultsFor}"` : "";
  $("results").replaceChildren(...s.results.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  $("orders").textContent = s.orders.length ? `Orders: ${s.orders.join(", ")}` : "";
  if (note.value !== s.draft) note.value = s.draft;
  $("saved").textContent = s.saved ? `Saved: "${s.saved}"` : "";
});
