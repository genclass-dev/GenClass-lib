(() => {
const $ = id => document.getElementById(id);

document.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); } catch {}
  const k = b.querySelector(".k"); b.classList.add("done"); if (k) k.textContent = "Copied";
  setTimeout(() => { b.classList.remove("done"); if (k) k.textContent = "Copy"; }, 1600);
}));

const tabs = [...document.querySelectorAll('.code [role="tab"]')];
function select(i, focus) {
  tabs.forEach((b, j) => { b.setAttribute("aria-selected", i === j); b.tabIndex = i === j ? 0 : -1; $(b.getAttribute("aria-controls")).hidden = i !== j; });
  if (focus) tabs[i].focus();
}
tabs.forEach((b, i) => {
  b.addEventListener("click", () => select(i));
  b.addEventListener("keydown", e => {
    if (e.key === "ArrowRight") select((i + 1) % tabs.length, true);
    if (e.key === "ArrowLeft") select((i + tabs.length - 1) % tabs.length, true);
  });
});
if (tabs.length) select(0);

// the Menu sheet closes on Escape, on a tap outside it, and when one of its links is followed
const mnav = document.querySelector(".mnav");
if (mnav) {
  document.addEventListener("keydown", e => { if (e.key === "Escape" && mnav.open) { mnav.open = false; mnav.querySelector("summary").focus(); } });
  document.addEventListener("pointerdown", e => { if (mnav.open && !mnav.contains(e.target)) mnav.open = false; });
  mnav.querySelector(".panel").addEventListener("click", e => { if (e.target.closest("a")) mnav.open = false; });
}

// home "Set up in a minute": each step shows its own terminal, typed in
document.querySelectorAll("[data-setup]").forEach(box => {
  const items = [...box.querySelectorAll(".steps2 li")], srcs = [...box.querySelectorAll("[data-step-src]")];
  const term = box.querySelector("[data-term]"), title = box.querySelector("[data-term-title]");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let run = 0;
  function show(i) {
    items.forEach((li, j) => { li.classList.toggle("on", i === j); li.querySelector("button").setAttribute("aria-expanded", i === j); });
    const src = srcs[i]; if (!src || !term) return;
    if (title) title.textContent = src.dataset.title || "";
    const id = ++run, lines = src.innerHTML.split("\n");
    if (still) { term.innerHTML = src.innerHTML; return; }
    term.innerHTML = "";
    const caret = document.createElement("span"); caret.className = "caret"; caret.setAttribute("aria-hidden", "true");
    let n = 0;
    const next = () => {
      if (id !== run) return;
      if (n >= lines.length) { term.append(caret); return; }
      const line = lines[n++], tmp = document.createElement("div"); tmp.innerHTML = line;
      const prompt = tmp.firstElementChild?.classList.contains("p") ? tmp.firstElementChild : null;
      if (n > 1) term.append("\n");
      if (!prompt) { term.insertAdjacentHTML("beforeend", line); term.append(caret); setTimeout(next, 90); return; }
      const text = line.slice(line.indexOf("</span>") + 7).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      term.append(prompt);
      const typed = document.createTextNode(""); term.append(typed, caret);
      let c = 0;
      const type = () => { if (id !== run) return; typed.data = text.slice(0, ++c); if (c < text.length) setTimeout(type, 28); else setTimeout(next, 260); };
      setTimeout(type, 200);
    };
    next();
  }
  items.forEach((li, i) => li.querySelector("button").addEventListener("click", () => show(i)));
  let started = false;
  new IntersectionObserver(es => { if (!started && es.some(e => e.isIntersecting)) { started = true; show(0); } }, { threshold: 0.4 }).observe(box);
});


const CITIES = ["San Francisco","San Diego","San Jose","San Antonio","Santa Fe","Santiago","Sapporo","Salvador","Paris","Panama City","Palermo","Perth","Porto","Prague","Lisbon","London","Los Angeles","Lima","Lagos","Toronto","Tokyo","Tallinn","Taipei","Berlin","Bergen","Bern","Boston","Bogotá","Mumbai","Munich","Montreal","Madrid","Melbourne","Seoul","Seattle","Singapore","Stockholm","Sydney","Vancouver","Vienna","Venice","Waterloo"];
const q = $("q");
if (!q) return;
let seq = 0, base = 0, offShown = -1, onShown = -1, offQ = "", onQ = "", typed = "", sOff = 0, sDisc = 0, timer = null;
const latency = n => { const r = Math.abs((Math.sin(n * 12.9898) * 43758.5453) % 1); return n % 3 === 1 ? 900 + r * 500 : 140 + r * 260; };
const search = s => { const k = s.trim().toLowerCase(); return k ? CITIES.filter(c => c.toLowerCase().startsWith(k)).slice(0, 5) : []; };
function render(lane, forQ, list) {
  $(lane + "For").textContent = forQ ? `"${forQ}"` : "nothing yet";
  const ul = $(lane + "Res"); ul.replaceChildren();
  for (const c of (list.length ? list : ["No matches"])) { const li = document.createElement("li"); li.textContent = c; ul.append(li); }
}
function status(id, cls, text) { const el = $(id); el.replaceChildren(); const s = document.createElement("span"); s.className = cls; s.textContent = text; el.append(s); }
function onType() {
  const s = q.value; typed = s;
  if (!s.trim()) return;
  const id = ++seq, ms = latency(id - base);
  const row = document.createElement("div"); row.className = "req";
  const lq = document.createElement("span"); lq.className = "q"; lq.textContent = `#${id - base} q=${s}`;
  const t = document.createElement("div"); t.className = "t"; const bar = document.createElement("i"); t.append(bar);
  const lm = document.createElement("span"); lm.className = "ms"; lm.textContent = `${Math.round(ms)} ms`;
  row.append(lq, t, lm);
  const reqs = $("reqs"); reqs.prepend(row); while (reqs.children.length > 6) reqs.lastChild.remove();
  bar.style.transition = `width ${ms}ms linear`;
  requestAnimationFrame(() => requestAnimationFrame(() => bar.style.width = "100%"));
  setTimeout(() => {
    if (id <= base) return;
    const res = search(s), late = id < offShown;
    if (late) row.classList.add("late");
    offShown = id; offQ = s; render("off", s, res);
    if (late && s !== typed) { sOff++; $("sOff").textContent = sOff; }
    const stale = offQ !== typed;
    $("laneOff").classList.toggle("stale", stale);
    if (stale) status("offSt", "no", `Stale: the box says "${typed}", the results are for "${offQ}"`);
    else status("offSt", "", "In sync");
    if (id < onShown) {
      sDisc++; $("sDisc").textContent = sDisc;
      status("onSt", "ok", `[GenClass] Prevented a stale write: "${s}" landed after "${onQ}" was shown (stale; discard)`);
    } else {
      onShown = id; onQ = s; render("on", s, res);
      status("onSt", "", `In sync, delivered #${id - base}`);
    }
  }, ms);
}
q.addEventListener("input", onType);
function reset() {
  clearInterval(timer); timer = null; $("auto").textContent = "Auto-type";
  base = seq; offShown = onShown = -1; offQ = onQ = typed = ""; sOff = sDisc = 0;
  q.value = ""; $("sOff").textContent = 0; $("sDisc").textContent = 0; $("reqs").replaceChildren();
  $("offRes").replaceChildren(); $("onRes").replaceChildren(); $("offFor").textContent = $("onFor").textContent = "nothing yet";
  $("laneOff").classList.remove("stale"); $("offSt").textContent = $("onSt").textContent = "Waiting for input.";
}
$("reset").addEventListener("click", reset);
$("auto").addEventListener("click", () => {
  reset();
  const words = ["san francisco", "paris", "toronto", "melbourne"]; let w = 0, c = 0;
  $("auto").textContent = "Typing…";
  timer = setInterval(() => {
    const word = words[w];
    if (c <= word.length) { q.value = word.slice(0, c++); if (q.value) onType(); }
    else if (c++ > word.length + 9) { c = 0; w++; q.value = ""; if (w >= words.length) { clearInterval(timer); timer = null; $("auto").textContent = "Auto-type"; } }
  }, 170);
});
})();

// GenClass Cloud preview: sidebar sections
(() => {
  document.querySelectorAll("[data-app]").forEach(app => {
    const btns = [...app.querySelectorAll("[data-view]")];
    btns.forEach(b => b.addEventListener("click", () => {
      btns.forEach(x => x.setAttribute("aria-current", x === b ? "true" : "false"));
      app.querySelectorAll("[data-panel]").forEach(p => { p.hidden = p.dataset.panel !== b.dataset.view; });
    }));
  });
})();

// Early-access form
(() => {
  document.querySelectorAll("form[data-waitlist]").forEach(form => {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const msg = form.querySelector(".msg"), btn = form.querySelector("button[type=submit]");
      const data = Object.fromEntries(new FormData(form));
      data.page = location.pathname;
      msg.className = "msg"; msg.textContent = "Sending…"; btn.disabled = true;
      try {
        const r = await fetch("/forms/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Something went wrong. Please try again.");
        msg.className = "msg ok"; msg.textContent = "You're on the list. We'll be in touch soon."; form.reset();
      } catch (err) {
        msg.className = "msg err"; msg.textContent = err.message;
      } finally { btn.disabled = false; }
    });
  });
})();

// Scroll: a progress line under the nav, sections and grids that arrive as they come into view (grids one card at a
// time), result numbers that count up, and the home hero drifting away. Everything already on screen at load is shown
// at once, so nothing blinks; under prefers-reduced-motion only the content shows, with no motion.
(() => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nav = document.querySelector(".nav"), hero = document.querySelector(".hero4");
  let bar = null;
  if (nav && !still) { bar = document.createElement("span"); bar.className = "prog"; bar.setAttribute("aria-hidden", "true"); nav.append(bar); }
  let ticking = false;
  const onScroll = () => {
    ticking = false;
    const y = scrollY;
    if (nav) nav.classList.toggle("scrolled", y > 8);
    if (bar) bar.style.setProperty("--p", Math.min(1, y / Math.max(1, document.documentElement.scrollHeight - innerHeight)).toFixed(4));
    if (hero && !still) hero.style.setProperty("--hp", Math.min(1, y / Math.max(1, hero.offsetHeight * 0.9)).toFixed(4));
  };
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  onScroll();
  if (still) return;

  // tag what should arrive: section heads, intros, notes, panels; grids get their children staggered
  const SOLO = "main section .sh, main section .intro, main section .note, main section .disclose, .lab, .app, .code, .ba-fig, .vspec-fig, .vnums-fig, .vfam-fig, .scanbox, .formcard, .arch";
  const GRID = ".bento, .four, .fgrid, .cards3, .stats, .faq2 .list, .vspec, .vfam, .plans, .tiers, .pnotes, .ent, .principles, .duo, .flow";
  const near = (el) => el.getBoundingClientRect().top < innerHeight * 0.92;
  document.querySelectorAll(GRID).forEach((g) => { g.classList.add("reveal"); g.dataset.stagger = ""; [...g.children].forEach((c, i) => c.style.setProperty("--i", Math.min(i, 8))); });
  document.querySelectorAll(SOLO).forEach((el) => { if (!el.closest("[data-stagger]")) el.classList.add("reveal"); });
  const all = [...document.querySelectorAll(".reveal, .race")];
  all.forEach((el) => { if (near(el)) el.classList.add("in"); });

  // numbers count up the first time they arrive: "0.13%", "75%", "3 in 4", "10 MB" keep their format
  const count = (el) => {
    if (el.dataset.counted || el.children.length) return;
    const m = el.textContent.match(/^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
    if (!m) return;
    el.dataset.counted = "1";
    const [, pre, num, post] = m, target = parseFloat(num.replace(/,/g, "")), dec = (num.split(".")[1] || "").length, comma = num.includes(",");
    if (!target) return;
    const t0 = performance.now(), dur = 1100;
    const fmt = (v) => { let s = v.toFixed(dec); if (comma) s = Number(s).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }); return pre + s + post; };
    const step = (now) => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(target * e); if (k < 1) requestAnimationFrame(step); else el.textContent = pre + num + post; };
    el.textContent = fmt(0); requestAnimationFrame(step);
  };
  const NUMS = ".four .big, .stat .big, .vnums b";
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add("in"); io.unobserve(e.target);
    e.target.querySelectorAll(NUMS).forEach(count);
    if (e.target.matches(NUMS)) count(e.target);
  }), { rootMargin: "0px 0px -10% 0px" });
  all.forEach((el) => { if (!el.classList.contains("in")) io.observe(el); });
  // belt and braces: if the observer is late (a throttled or backgrounded page), a plain scroll check shows what is in view
  let pending = all.filter((el) => !el.classList.contains("in")), last = 0;
  const sweep = () => {
    const now = Date.now(); if (now - last < 120 || !pending.length) return; last = now;
    pending = pending.filter((el) => {
      if (el.getBoundingClientRect().top > innerHeight * 0.9) return true;
      el.classList.add("in"); io.unobserve(el); el.querySelectorAll(NUMS).forEach(count); if (el.matches(NUMS)) count(el);
      return false;
    });
  };
  addEventListener("scroll", sweep, { passive: true });
})();
