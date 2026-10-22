// VibeShop, exactly as The Terrible Vibe Coder wrote it. It works every time on a fast network (try it).
// On a slow, shuffled one (a phone on a train) it has three bugs:
//   1. Search shows results for an older query when its answer arrives last.
//   2. Buy now charges twice when someone double-clicks (the button stays enabled while the order is sent).
//   3. Autosave puts the server's copy back into the note box, so a slow save undoes what you typed since.
// This is the file to ask Claude to fix. shop-fixed.js is one careful fix, for comparison.

const rt = window.GenClass?.runtime ?? null;

/** A tiny store. With GenClass on the page the state lives in GenClass.runtime.atom, so GenClass can see it. */
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

// 1. Search as you type
search.addEventListener("input", async () => {
  const q = search.value;
  store.set((s) => ({ ...s, query: q }));
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  store.set((s) => ({ ...s, results: data.items, resultsFor: data.q }));
});

// 2. Buy now
buy.addEventListener("click", async () => {
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item: "VibePods", cart }),
  });
  const order = await res.json();
  store.set((s) => ({ ...s, orders: [...s.orders, order.id] }));
});

// 3. Notes with autosave
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
    store.set((s) => ({ ...s, draft: saved.text, saved: saved.text }));
  }, 300);
});

// render
store.subscribe((s) => {
  $("results-for").textContent = s.resultsFor ? `Results for "${s.resultsFor}"` : "";
  $("results").replaceChildren(...s.results.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  $("orders").textContent = s.orders.length ? `Orders: ${s.orders.join(", ")}` : "";
  if (note.value !== s.draft) note.value = s.draft;
  $("saved").textContent = s.saved ? `Saved: "${s.saved}"` : "";
});
