// Claude's Shop: search, bag, delivery note, checkout, theme and the welcome offer.

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
const initial = { query: "", results: [], resultsFor: "", item: { id: "headphones", name: "Over-ear Headphones", price: 129 }, orders: [], draft: "", saved: "" };
export const store = rt ? rt.atom("shop", initial) : plainStore(initial);
export const cart = `cart_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const $ = (id) => document.getElementById(id);
const search = $("search");
const buy = $("buy");
const note = $("note");

const ART = {
  lamp: '<path d="M14 40h20M24 40V24M24 24l-9-12h18z"/><path d="M24 24l7-6"/>',
  mug: '<rect x="11" y="15" width="21" height="23" rx="3"/><path d="M32 20h4a5 5 0 0 1 0 10h-4"/>',
  headphones: '<path d="M11 31v-7a13 13 0 0 1 26 0v7"/><rect x="8" y="29" width="7" height="11" rx="2"/><rect x="33" y="29" width="7" height="11" rx="2"/>',
  notebook: '<rect x="12" y="8" width="24" height="32" rx="2"/><path d="M17 8v32M22 16h9M22 21h9"/>',
  plant: '<path d="M15 29h18l-2.5 11h-13z"/><path d="M24 29V17M24 22c-6 0-9-4-9-9 5 0 9 3 9 9zM24 19c0-6 4-9 9-9 0 5-3 9-9 9z"/>',
  keyboard: '<rect x="6" y="16" width="36" height="17" rx="3"/><path d="M11 21h2M16 21h2M21 21h2M26 21h2M31 21h2M36 21h1M14 27h20"/>',
  bottle: '<path d="M20 7h8v5l3 4v21a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3V16l3-4z"/><path d="M17 22h14"/>',
  clock: '<circle cx="24" cy="24" r="15"/><path d="M24 15v9l6 4"/>',
  tote: '<path d="M11 18h26l-2 22H13z"/><path d="M19 18v-3a5 5 0 0 1 10 0v3"/>',
  candle: '<rect x="16" y="21" width="16" height="19" rx="2"/><path d="M24 21v-4M24 8c2.5 2.5 2.5 5 0 7-2.5-2-2.5-4.5 0-7z"/>',
  chair: '<path d="M16 7h16v17H16zM12 24h24v5H12zM15 29v12M33 29v12"/>',
  throw: '<path d="M9 13h30v22H9z"/><path d="M9 20h30M9 27h30M15 35v4M22 35v4M29 35v4"/>',
};

function card(p) {
  const li = document.createElement("li");
  li.className = "product";
  li.innerHTML = `<div class="art" style="background:${p.tone}"><svg viewBox="0 0 48 48" aria-hidden="true">${ART[p.kind] ?? ""}</svg></div>
    <div class="info"><span class="name"></span><span class="price">$${p.price}</span><button class="add">Add to bag</button></div>`;
  li.querySelector(".name").textContent = p.name;
  li.querySelector(".add").addEventListener("click", () => store.set((s) => ({ ...s, item: { id: p.id, name: p.name, price: p.price } })));
  return li;
}

async function load(q) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  store.set((s) => ({ ...s, results: data.q ? data.items : data.items.slice(0, 6), resultsFor: data.q }));
}

search.addEventListener("input", async () => {
  const q = search.value;
  store.set((s) => ({ ...s, query: q }));
  await load(q);
});

buy.addEventListener("click", async () => {
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item: store.get().item.id, cart }),
  });
  const order = await res.json();
  store.set((s) => ({ ...s, orders: [...s.orders, order.id] }));
});

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

store.subscribe((s) => {
  $("results-for").textContent = s.resultsFor ? `${s.results.length} result${s.results.length === 1 ? "" : "s"} for "${s.resultsFor}"` : "Featured this week";
  $("results").replaceChildren(...s.results.map(card));
  $("bag-item").textContent = s.item.name;
  $("bag-price").textContent = `$${s.item.price}`;
  $("orders").textContent = s.orders.length ? `Order${s.orders.length === 1 ? "" : "s"} placed: ${s.orders.join(", ")}` : "";
  if (note.value !== s.draft) note.value = s.draft;
  $("saved").textContent = s.saved ? "Note saved" : "";
});

load("");

// theme
$("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* private window */
  }
});

// welcome offer, once per visit, a few seconds in
const offer = () => setTimeout(() => {
  const back = document.createElement("div");
  back.className = "promo-back";
  back.innerHTML = `<div class="promo" role="dialog" aria-modal="true" aria-labelledby="promo-t"><h2 id="promo-t">Free delivery this week</h2>
    <p>On everything, no minimum. It is already in your bag.</p><button>Start shopping</button></div>`;
  document.body.append(back);
  document.body.style.overflow = "hidden";
  const close = () => back.remove();
  back.querySelector("button").addEventListener("click", close);
  setTimeout(close, 1200);
}, 1800);
if (document.readyState === "complete") offer();
else addEventListener("load", offer);
