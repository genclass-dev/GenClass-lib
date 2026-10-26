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

// Search: every keystroke fetches; only the response to the latest query may write the results (the fix: a sequence
// number per request; an older response that arrives later is ignored).
const search = genclass.atom("search", { query: "", results: [] });
let searchSeq = 0;
$("#q").addEventListener("input", async (e) => {
  const q = e.target.value;
  const mine = ++searchSeq;
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await r.json();
  if (mine !== searchSeq) return; // a newer query is in flight or done: this response is stale
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

// Cart: the button is disabled while its request is in flight (the fix: a double click adds once).
for (const b of document.querySelectorAll("button.add")) {
  b.addEventListener("click", async () => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      const r = await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item: b.dataset.item }) });
      const data = await r.json();
      write("cart.count", data.count);
    } finally {
      b.disabled = false;
    }
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
$("#reviews").addEventListener("click", async () => {
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
  $("#profilemsg").textContent = profile.address ? `Ships to ${profile.address.city}` : "No address on file yet."; // the fix
});

// Newsletter: the form posts; a 503 now and then is shown as is.
$("#newsletter").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = new FormData(e.target).get("email");
  const r = await fetch("/api/newsletter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  $("#newsmsg").textContent = r.ok ? "Subscribed." : `Failed (${r.status}).`;
});

$("#ok").addEventListener("click", () => $("dialog.cookie").close());

// Development builds only: the agent link records what happens on this page for @genclass/mcp (the port is set
// because another GenClass MCP server already owns the default one on this machine; GENCLASS_AGENT_PORT matches).
if (import.meta.env.DEV) connectAgent(genclass, { url: "http://127.0.0.1:47400" }); // genclass:agent
if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass)); // genclass:init
