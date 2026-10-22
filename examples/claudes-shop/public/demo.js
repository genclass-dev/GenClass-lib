// The GenClass button and, on /genclass-on, a small panel with what GenClass found and fixed on this visit (its own
// reports: measured visual checks, detections and actions). Loaded after shop.js; never changes the shop.

// only the GenClass this page put there (a scanner may inject its own)
const rt = window.SHOP_GENCLASS ? (window.GenClass?.runtime ?? null) : null;
const btn = document.getElementById("gc-btn");
const scan = (path) => `https://genclass.dev/scan?url=${encodeURIComponent(location.origin + path)}`;

if (!rt) {
  document.getElementById("gc-note").innerHTML = `<a href="${scan("/")}">Scan this page</a> · <a href="/genclass-on">The same shop with GenClass</a>`;
} else {
  btn.textContent = "GenClass is on";
  btn.classList.add("on");
  btn.href = "/";
  btn.title = "Back to the shop without GenClass";
  document.getElementById("gc-note").innerHTML = `This page runs GenClass with diagnostics on (<a href="https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md">what is sent</a>). <a href="${scan("/genclass-on")}">Scan this page</a> · <a href="/">Without GenClass</a>`;

  const css = `
    .gcp { position: fixed; right: 16px; bottom: 16px; z-index: 30; width: min(380px, calc(100vw - 32px)); background: var(--surface); color: var(--text);
      border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.18); font-size: 13px; }
    .gcp summary { list-style: none; cursor: pointer; padding: 12px 14px; display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .gcp summary::-webkit-details-marker { display: none; }
    .gcp .dot { width: 8px; height: 8px; border-radius: 50%; background: #1f9d5c; }
    .gcp .count { margin-left: auto; color: var(--muted); font-weight: 400; }
    .gcp ul { list-style: none; margin: 0; padding: 0 14px 14px; display: grid; gap: 8px; max-height: 45vh; overflow: auto; }
    .gcp li { padding: 8px 10px; border-radius: 10px; background: var(--bg); overflow-wrap: anywhere; }
    .gcp li b { display: block; font-size: 12px; margin-bottom: 2px; }
    .gcp li.fixed b { color: #1f9d5c; }
    .gcp li.seen b { color: #b7791f; }
    .gcp .empty { color: var(--muted); padding: 0 14px 14px; }`;
  document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
  const panel = document.createElement("details");
  panel.className = "gcp";
  panel.setAttribute("data-genclass-ignore", "");
  panel.innerHTML = `<summary><span class="dot"></span>GenClass <span class="count">watching</span></summary><p class="empty">Nothing yet. Problems appear here as GenClass finds them.</p><ul></ul>`;
  document.body.append(panel);
  const list = panel.querySelector("ul");
  let n = 0;
  let fixed = 0;
  const seen = new Set();
  const add = (key, cls, title, text) => {
    if (seen.has(key)) return;
    seen.add(key);
    n++;
    if (cls === "fixed") fixed++;
    panel.querySelector(".empty")?.remove();
    const li = document.createElement("li");
    li.className = cls;
    li.append(Object.assign(document.createElement("b"), { textContent: title }), String(text).replace(/^\[GenClass\]\s*/, ""));
    list.prepend(li);
    panel.querySelector(".count").textContent = `${n} found${fixed ? `, ${fixed} fixed` : ""}`;
    if (n === 1) panel.open = true;
  };
  rt.on("check", (f) => add(f.id + (f.fix?.applied ? "+" : ""), f.fix?.applied ? "fixed" : "seen", f.fix?.applied ? "Fixed on this page" : "Found", f.message));
  rt.on("decide", (d) => d.detection && add(d.id, "seen", "Found", rt.explain(d.id)?.message ?? d.diagnosis));
  rt.on("act", (a) => add(a.id, "fixed", "Prevented", rt.explain(a.id)?.message ?? a.changed));

  // the coding-agent link, on your own machine only (an inert no-op on a public host)
  import(`${window.GenClass.base}agent.js`).then((m) => m.connectAgent(rt)).catch(() => {});
}
