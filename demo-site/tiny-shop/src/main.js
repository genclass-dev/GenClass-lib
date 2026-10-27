import "./genclass.config"; // genclass:init
import genclass from "@genclass/runtime/auto"; // genclass:init
import { connectAgent } from "@genclass/runtime/agent"; // genclass:agent
// Tiny Shop's page script, as a small shop might write it: fetch on every keystroke with no cancellation, add-to-cart
// without an idempotency key, a checkout that does not handle a failure well, and a profile handler that trusts the
// response's shape. The store is a plain object with get/set so the page has one place its state lives.
import { store } from "./store.js";

const $ = (s) => document.querySelector(s);

// The shop's state goes through GenClass: each key of the store is wrapped once, and the handlers write through the
// wrapped handle, so every write is recorded with the response or click that caused it, and in guard mode a stale
// response's write can be dropped.
const state = Object.fromEntries(store.keys().filter((k) => !k.startsWith("search.")).map((k) => [k, genclass.guard(k, { get: () => store.get(k), set: (v) => store.set(k, v) })]));
const write = (k, v) => state[k].set(v);

// Search: every keystroke fetches; whichever response arrives last wins, even if it answers an older query.
// The search state is a GenClass atom (the one line from the README): every write is recorded with the response that
// caused it, and in guard mode a stale response's write can be dropped.
const search = genclass.atom("search", { query: "", results: [] });
$("#q").addEventListener("input", async (e) => {
  const q = e.target.value;
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await r.json();
  search.set((s) => ({ ...s, results: data.results, query: data.q }));
});
search.subscribe(({ results }) => {
  const ul = $("#results");
  ul.textContent = "";
  for (const name of results) {
    const li = document.createElement("li");
    li.textContent = name;
    ul.appendChild(li);
  }
});

// Cart: each click posts; two quick clicks post twice.
for (const b of document.querySelectorAll("button.add")) {
  b.addEventListener("click", async () => {
    const r = await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item: b.dataset.item, count: store.get("cart.count") }) });
    const data = await r.json();
    write("cart.count", data.count);
  });
}
store.subscribe("cart.count", (n) => ($("#cartcount").textContent = String(n)));

// Checkout: the API answers 500; the page shows a generic line and keeps the button enabled.
$("#checkout").addEventListener("click", async () => {
  $("#checkout-msg").textContent = "Placing your order…";
  const r = await fetch("/api/checkout", { method: "POST", body: "{}" });
  const data = await r.json();
  $("#checkout-msg").textContent = r.ok ? "Thank you!" : `Could not place the order (${data.error}).`;
});

// Reviews: a slow endpoint with no loading state.
// Reviews: a slow endpoint. While it loads, the page blocks clicks "so nobody double-loads", and forgets to unblock.
$("#reviews").addEventListener("click", async () => {
  document.body.style.pointerEvents = "none";
  const r = await fetch("/api/reviews");
  const data = await r.json();
  write("reviews", data.reviews);
});
store.subscribe("reviews", (list) => {
  const ul = $("#reviewlist");
  ul.textContent = "";
  for (const rv of list) {
    const li = document.createElement("li");
    li.textContent = `${rv.who}: ${rv.text}`;
    ul.appendChild(li);
  }
});

// Profile: the response has no `address`, so reading `.city` throws inside the click handler.
$("#profile").addEventListener("click", async () => {
  const r = await fetch("/api/profile");
  const profile = await r.json();
  $("#profilemsg").textContent = `Ships to ${profile.address.city}`;
});

// Newsletter: the form posts; a 503 now and then is shown as is.
let attempt = 0;
$("#newsletter").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = new FormData(e.target).get("email");
  const r = await fetch("/api/newsletter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, attempt: ++attempt }) });
  $("#newsmsg").textContent = r.ok ? "Subscribed." : `Failed (${r.status}).`;
});

// Cookie notice: the page locks scrolling while the notice is up, and the OK handler closes the notice without
// unlocking it.
document.body.style.overflow = "hidden";
$("#ok").addEventListener("click", () => $("dialog.cookie").close());

// Development builds only: the agent link records what happens on this page for @genclass/mcp (never in production).
if (import.meta.env.DEV) connectAgent(genclass); // genclass:agent
// Demo site: the devtools overlay stays on in production too (17 KB gzip), so what GenClass does is visible to anyone
// who opens the page. A normal app loads it in development only: if (import.meta.env.DEV) import(...)
import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass)); // genclass:init
