// The demo around VibeShop: the switches, a bug meter that checks the shop from the outside (what the page shows and
// what the server charged, never the shop's own state), an impatient user robot, and the GenClass and Claude panels.
// Nothing here changes how the shop behaves; window.vibe.run() and window.vibe.verdict() are what trials.mjs drives.

const V = window.VIBE;
const rt = window.GenClass?.runtime ?? null;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 3500; // slowest answer (1.5 s) + the longest hold GenClass may add (1.5 s) + margin

// ---------- switches ----------
function seg(id, value, onPick) {
  for (const b of $(id).querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.v === value));
    b.addEventListener("click", () => onPick(b.dataset.v));
  }
}
const reloadWith = (k, v) => {
  const u = new URL(location.href);
  u.searchParams.set(k, v);
  location.href = u.href;
};
seg("gc", V.gc, (v) => reloadWith("gc", v));
seg("code", V.code, (v) => reloadWith("code", v));
let slow = false;
async function setNetwork(v) {
  const r = await fetch("/api/network", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slow: v === "slow" }) });
  slow = (await r.json()).slow;
  for (const b of $("net").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === (slow ? "slow" : "fast")));
  tally();
}
for (const b of $("net").querySelectorAll("button")) b.addEventListener("click", () => setNetwork(b.dataset.v));
fetch("/api/state").then((r) => r.json()).then((s) => {
  slow = s.slow;
  for (const b of $("net").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === (slow ? "slow" : "fast")));
  tally();
});
$("cart-id").textContent = V.cart;

// ---------- the bug meter ----------
const search = $("search");
const buy = $("buy");
const note = $("note");
const m = { lastSearchAt: 0, searchChecked: true, searchBug: null, clicks: [], ordersAtStart: 0, orders: 0, noteTyped: null, noteBug: null };

function show(k, state, text) {
  const li = document.querySelector(`#meter li[data-k="${k}"]`);
  li.dataset.s = state;
  li.querySelector("i").textContent = state === "bug" ? "✕" : state === "ok" ? "✓" : "·";
  li.querySelector("small").textContent = text;
}

document.addEventListener("input", (e) => {
  if (e.target === search) {
    m.lastSearchAt = performance.now();
    m.searchChecked = false;
    show("search", "wait", "Waiting for the answers…");
  }
  if (e.target === note) m.noteTyped = note.value; // runs before the shop's own listener
}, true);
document.addEventListener("click", (e) => {
  if (e.target === buy) {
    m.clicks.push(performance.now());
    show("buy", "wait", "Waiting for the server…");
    pollOrders();
  }
}, true);

/** Clicks less than a second apart are one intent (a double-click). */
const intents = () => m.clicks.filter((t, i) => i === 0 || t - m.clicks[i - 1] > 1000).length;

async function checkOrders() {
  const s = await (await fetch(`/api/state?cart=${encodeURIComponent(V.cart)}`)).json();
  m.orders = s.orders.length - m.ordersAtStart;
  const want = intents();
  const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  if (m.orders > want) show("buy", "bug", `Charged ${n(m.orders, "time")} for ${n(want, "purchase")}.`);
  else if (m.orders === want && want) show("buy", "ok", `Charged ${n(m.orders, "time")} for ${n(want, "purchase")}.`);
}
let polling = null;
function pollOrders() {
  polling ??= (async () => {
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      await checkOrders();
    }
    polling = null;
  })();
}

const shownFor = () => /^Results for "(.*)"$/.exec($("results-for").textContent)?.[1] ?? "";
setInterval(() => {
  // search: once the answers had time to arrive, the results must be for what is in the box
  if (!m.searchChecked && performance.now() - m.lastSearchAt > SETTLE_MS) {
    m.searchChecked = true;
    const want = search.value.trim().toLowerCase();
    const got = shownFor();
    m.searchBug = want !== got ? `The box says "${want}", the results are for "${got}".` : null;
    show("search", m.searchBug ? "bug" : "ok", m.searchBug ?? `Results for "${want}", as typed.`);
  }
  // note: the box must only ever change because the user typed
  if (m.noteTyped !== null && note.value !== m.noteTyped && !m.noteBug) {
    m.noteBug = `You typed "${m.noteTyped}", the box went back to "${note.value}".`;
    show("note", "bug", m.noteBug);
  }
}, 50);
note.addEventListener("input", () => {
  if (!m.noteBug) show("note", "ok", "Nothing you typed was replaced.");
});

// ---------- the impatient user ----------
function typeInto(el, text, gap) {
  return (async () => {
    el.focus();
    for (const ch of text) {
      el.value += ch;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      await sleep(gap);
    }
  })();
}
function clear(el) {
  el.value = "";
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
}

/** One impatient visit. Resolves with the verdict once everything had time to arrive. */
async function run() {
  if (search.value || note.value) {
    clear(search);
    clear(note);
    await sleep(SETTLE_MS); // the answers to the clears land before the visit starts
  }
  const s = await (await fetch(`/api/state?cart=${encodeURIComponent(V.cart)}`)).json();
  Object.assign(m, { clicks: [], ordersAtStart: s.orders.length, orders: 0, noteTyped: null, noteBug: null, searchBug: null });
  for (const k of ["search", "buy", "note"]) show(k, "wait", "Watching…");
  // types a search fast, double-clicks Buy, then writes a note and keeps typing while it saves
  await typeInto(search, "vibe wa", 70);
  await sleep(200);
  buy.click();
  await sleep(90);
  buy.click();
  await sleep(200);
  await typeInto(note, "Leave it at the door", 60);
  await sleep(700);
  await typeInto(note, ", thanks!", 60);
  await sleep(SETTLE_MS + 500);
  await checkOrders();
  return verdict();
}

/** What went wrong in the last visit (null: nothing). */
function verdict() {
  const want = intents();
  return {
    search: m.searchBug,
    buy: m.orders > want ? `charged ${m.orders} times for ${want}` : null,
    note: m.noteBug,
    gc: rt ? { mode: V.gc, model: rt.status?.state, interventions: rt.interventions().length } : null,
  };
}

const KEY = "vibe-tally-v1";
function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}
function tally(add) {
  const t = load();
  const k = `${V.gc === "off" ? "GenClass off" : V.gc === "watch" ? "GenClass watching" : "GenClass eager"}, ${V.code === "fixed" ? "fixed code" : "vibe-coded"}, ${slow ? "train" : "Wi-Fi"}`;
  if (add) {
    t[k] = t[k] ?? { runs: 0, broke: 0 };
    t[k].runs++;
    if (add.search || add.buy || add.note) t[k].broke++;
    try {
      localStorage.setItem(KEY, JSON.stringify(t));
    } catch {
      /* private window: the tally lasts for this page only */
    }
  }
  const rows = Object.entries(t).map(([name, r]) => `${name}: ${r.broke} of ${r.runs} visits broke`);
  $("tally").textContent = rows.length ? rows.join(" · ") : "";
}

const robot = $("robot");
robot.addEventListener("click", async () => {
  robot.disabled = true;
  $("robot-status").textContent = slow ? "Shopping…" : "Shopping… (switch the network to Phone on a train to see the bugs)";
  const v = await run();
  tally(v);
  const n = [v.search, v.buy, v.note].filter(Boolean).length;
  const gcSaid = rt && V.gc === "eager" && !v.gc?.interventions ? " GenClass did not step in this time: it acts only when its model is sure." : "";
  $("robot-status").textContent = (n ? `${n} of 3 things went wrong.` : "Nothing went wrong.") + gcSaid;
  robot.disabled = false;
});

window.vibe = { run, verdict, setNetwork };

// ---------- GenClass ----------
const pill = (id, on, text) => {
  const p = $(id);
  p.className = `pill ${on ? "on" : "off"}`;
  p.textContent = text;
};
if (!rt) {
  pill("gc-pill", false, V.loaded ? "off" : "not loaded");
  $("gc-about").textContent = V.loaded
    ? "Not on this page. Switch it to Watching or Eager."
    : "The GenClass script did not load (offline, or this version is not on the CDN yet: run the server with GENCLASS_LOCAL=1).";
} else {
  const label = V.gc === "eager" ? "eager" : "watching";
  const status = () => {
    const s = rt.status?.state;
    pill("gc-pill", s === "ready", s === "ready" ? label : `${label}, model ${s ?? "…"}`);
  };
  status();
  rt.on("status", status);
  $("gc-about").textContent = V.gc === "eager"
    ? "Guard mode at its most willing: when the on-device model is sure a response would undo newer data or repeat a purchase, GenClass holds, drops or reuses it. Anything it is not sure about goes through untouched."
    : "Report only: GenClass changes nothing and says what it noticed. Claude can read the same record.";
  const lines = new Map(); // decision id -> li
  const add = (key, text, cls) => {
    let li = lines.get(key);
    if (!li) {
      li = document.createElement("li");
      lines.set(key, li);
      $("feed").prepend(li);
    }
    li.className = cls;
    li.replaceChildren(Object.assign(document.createElement("b"), { textContent: cls === "act" ? "Stepped in. " : "Noticed. " }), text.replace(/^\[GenClass\]\s*/, ""));
  };
  rt.on("decide", (d) => {
    if (!d.detection || lines.get(d.id)?.className === "act") return;
    add(d.id, rt.explain(d.id)?.message ?? d.diagnosis, d.detection === "possible" ? "possible" : "");
  });
  rt.on("act", (a) => add(a.decisionId, rt.explain(a.id)?.message ?? a.changed, "act"));
}

// ---------- Claude ----------
if (!rt) {
  pill("claude-pill", false, "needs GenClass");
  $("claude-about").textContent = "Claude sees this page through GenClass. Switch GenClass to Watching or Eager.";
} else if (!V.claude) {
  pill("claude-pill", false, "off (?claude=0)");
} else {
  const base = window.GenClass.base;
  import(`${base}agent.js`)
    .then((mod) => {
      const conn = mod.connectAgent(rt);
      if (conn.reason === "not-dev-host") {
        // the agent link only runs on pages served from your own machine
        pill("claude-pill", false, "runs on your machine");
        $("claude-about").replaceChildren(
          "Claude connects to the copy of this shop on your own computer (GenClass never lets a public page talk to it). Run it with: ",
          Object.assign(document.createElement("pre"), { textContent: "git clone https://github.com/genclass-dev/GenClass-lib\nnode GenClass-lib/examples/terrible-vibe-coder/server.mjs" }),
          "then open http://localhost:4545 and follow these steps there.",
        );
        return;
      }
      const tick = () => {
        const a = window.__GENCLASS_AGENT__;
        const on = !!a?.connected;
        pill("claude-pill", on, on ? "connected" : "waiting for Claude");
        $("claude-about").textContent = on
          ? "Claude can see this page: every click, request and answer, and the order the answers arrived in."
          : "Start Claude Code with the GenClass MCP server (below), then reload this page.";
      };
      tick();
      setInterval(tick, 1000);
    })
    .catch(() => {
      pill("claude-pill", false, "agent link missing");
      $("claude-about").textContent = "This GenClass build has no agent link (needs @genclass/runtime 0.3.0-beta.1 or later).";
    });
}
