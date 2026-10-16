// Slide viewer for /pitch-deck: one slide at a time, keys, swipe, click/tap zones, full screen, deep links (#n), and the
// time each slide is on screen. Time counts only while the page is visible AND the window has focus; it is sent to
// /pitch-deck/beacon (src/deck.js) as per-slide milliseconds since the previous beacon with a sequence number, on slide
// change, every 10 s while counting, and when the page is hidden, loses focus or closes. No cookies. A random viewer id
// in localStorage groups repeat visits by the same browser; without storage the page works the same and sends none.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const slides = Array.from(document.querySelectorAll(".slide"));
  const N = slides.length;
  const stage = $("stage"), count = $("count"), prevBtn = $("prev"), nextBtn = $("next"), fsBtn = $("fs"), dl = $("dl");
  const live = $("announce"), progress = $("progress"), bar = $("bar");
  if (!N || !stage) return;
  const clamp = (n) => Math.min(N, Math.max(1, n));
  const fromHash = () => { const m = /^#(\d{1,3})$/.exec(location.hash); return m ? clamp(Number(m[1])) : 0; };
  const imgOf = (n) => slides[n - 1].querySelector("img");

  // ------------------------------------------------------------------------------------------------- reading time
  const track = (() => {
    const ENDPOINT = "/pitch-deck/beacon", TICK = 1000, EVERY = 10000, GAP = 4000;
    const off = navigator.webdriver === true; // automation and headless renderers: no view
    const store = (() => { try { return window.localStorage; } catch { return null; } })();
    const get = (k) => { try { return store ? store.getItem(k) : null; } catch { return null; } };
    const put = (k, v) => { try { if (store) store.setItem(k, v); } catch { /* storage blocked */ } };
    const rid = () => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      let s = "";
      for (const x of b) s += String.fromCharCode(x);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const ID = /^[A-Za-z0-9_-]{22}$/;
    const vid = rid();
    let viewer = get("deck.viewer");
    if (!ID.test(viewer || "")) { viewer = rid(); put("deck.viewer", viewer); if (get("deck.viewer") !== viewer) viewer = null; }
    const own = get("deck.owner") === "1";
    // A named share link (?k=<token>): read once, remembered in this browser (a reload or a later visit from history or a
    // bookmark still counts for that link) and taken out of the address bar, so a URL copied from the address bar and
    // passed on carries no token: its views count as the direct link instead of looking like the recipient's.
    const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
    let token = null, ref = null;
    try {
      const q = new URLSearchParams(location.search);
      const k = q.get("k");
      if (k !== null) {
        if (TOKEN.test(k)) { token = k; put("deck.k", k); }
        q.delete("k");
        const rest = q.toString();
        history.replaceState(history.state, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
      }
    } catch { /* keep the address as it is */ }
    if (!token) { const k = get("deck.k"); if (k && TOKEN.test(k)) token = k; }
    try { if (document.referrer) ref = new URL(document.referrer).hostname.slice(0, 253); } catch { /* none */ }
    const deck = document.body.getAttribute("data-deck") || "";
    const touch = (navigator.maxTouchPoints || 0) > 1;

    const pend = new Map(); // slide -> ms counted and not sent yet (fractions carry over)
    let path = [], seq = 0, counted = 0, max = 0, fs = 0, dlUsed = 0, sentFs = 0, sentDl = 0;
    let slide = 0, active = false, since = performance.now(), lastSend = since, ticker = 0, soonT = 0;

    function settle() {
      const now = performance.now();
      if (active && slide) {
        let d = now - since;
        if (d > GAP) d = TICK; // the ticker runs every second while counting: a longer gap means the page was suspended
        if (d > 0) { pend.set(slide, (pend.get(slide) || 0) + d); counted += d; }
      }
      since = now;
    }
    function send(json) {
      try { if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([json], { type: "text/plain;charset=UTF-8" }))) return; } catch { /* fall back */ }
      try { fetch(ENDPOINT, { method: "POST", body: json, keepalive: true, credentials: "omit", headers: { "content-type": "text/plain;charset=UTF-8" } }).catch(() => {}); } catch { /* lost */ }
    }
    function flush() {
      clearTimeout(soonT); soonT = 0;
      if (off) return;
      settle();
      lastSend = performance.now();
      if (counted < 1) return; // nothing has been on screen yet: a page that is never seen sends nothing
      const t = {};
      let any = false;
      for (const [s, v] of pend) { const w = Math.floor(v); if (w > 0) { t[s] = w; pend.set(s, v - w); any = true; } }
      if (!any && !path.length && fs === sentFs && dlUsed === sentDl) return;
      const body = { v: 1, vid, seq: ++seq, t, p: path.slice(0, 50), m: max, fs, dl: dlUsed, d: deck };
      if (viewer) body.b = viewer;
      if (token) body.k = token;
      if (ref) body.r = ref;
      if (touch) body.tp = 1;
      if (own) body.o = 1;
      path = []; sentFs = fs; sentDl = dlUsed;
      send(JSON.stringify(body));
    }
    const soon = () => { if (!soonT) soonT = setTimeout(flush, 1000); };
    function tick() { settle(); if (performance.now() - lastSend >= EVERY) flush(); }
    function update() {
      settle();
      const a = !off && document.visibilityState === "visible" && document.hasFocus();
      if (a === active) return;
      active = a;
      if (a) ticker = setInterval(tick, TICK);
      else { clearInterval(ticker); ticker = 0; flush(); }
    }
    function stop() { settle(); active = false; clearInterval(ticker); ticker = 0; flush(); }
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", (e) => { if (e.persisted) update(); });
    document.addEventListener("freeze", stop);
    document.addEventListener("resume", update);
    return {
      enter(n) { settle(); slide = n; path.push(n); if (n > max) max = n; soon(); },
      fullscreen() { if (!fs) { fs = 1; soon(); } },
      download() { dlUsed = 1; flush(); },
      update,
    };
  })();

  // ----------------------------------------------------------------------------------------------------- viewer
  let cur = 0;
  function preload(n) {
    for (const i of [n, n + 1, n - 1, n + 2]) {
      if (i < 1 || i > N) continue;
      const img = imgOf(i);
      if (img.getAttribute("loading") !== "eager") img.setAttribute("loading", "eager");
    }
  }
  function fit() {
    const w = cur ? imgOf(cur).getBoundingClientRect().width : 0;
    if (w < 1) return;
    const s = Math.ceil(w) + "px";
    for (const el of slides) { const img = el.querySelector("img"); if (img.getAttribute("sizes") !== s) img.setAttribute("sizes", s); }
  }
  function go(n, announce = true) {
    n = clamp(n);
    if (n === cur) return;
    if (cur) { slides[cur - 1].classList.remove("on"); slides[cur - 1].setAttribute("aria-hidden", "true"); }
    cur = n;
    const el = slides[n - 1];
    el.classList.add("on");
    el.removeAttribute("aria-hidden");
    count.textContent = n + " / " + N;
    prevBtn.disabled = n === 1;
    nextBtn.disabled = n === N;
    progress.style.width = (100 * n / N).toFixed(2) + "%";
    if (location.hash !== "#" + n) { try { history.replaceState(history.state, "", "#" + n); } catch { /* sandboxed */ } }
    if (announce) live.textContent = "Slide " + n + " of " + N;
    preload(n);
    track.enter(n);
  }

  // full screen (presentation): the whole page, so the toolbar can sit over the slide
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const canFs = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled) && !!(root.requestFullscreen || root.webkitRequestFullscreen);
  if (!canFs) fsBtn.hidden = true;
  function toggleFs() {
    try {
      if (fsElement()) { const p = (document.exitFullscreen || document.webkitExitFullscreen).call(document); if (p && p.catch) p.catch(() => {}); }
      else { const p = (root.requestFullscreen || root.webkitRequestFullscreen).call(root); if (p && p.catch) p.catch(() => {}); }
    } catch { /* refused */ }
  }
  let idleT = 0;
  function wake() {
    root.classList.remove("idle");
    clearTimeout(idleT);
    if (fsElement()) idleT = setTimeout(() => { if (!bar.matches(":hover") && !bar.contains(document.activeElement)) root.classList.add("idle"); }, 2500);
  }
  function onFs() {
    const on = !!fsElement();
    root.classList.toggle("fs", on);
    fsBtn.setAttribute("aria-pressed", String(on));
    fsBtn.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
    fsBtn.title = on ? "Exit full screen (F)" : "Full screen (F)";
    if (on) track.fullscreen();
    wake();
    requestAnimationFrame(fit);
  }
  document.addEventListener("fullscreenchange", onFs);
  document.addEventListener("webkitfullscreenchange", onFs);

  prevBtn.addEventListener("click", () => go(cur - 1));
  nextBtn.addEventListener("click", () => go(cur + 1));
  fsBtn.addEventListener("click", toggleFs);
  dl.addEventListener("click", () => track.download());
  bar.addEventListener("focusin", wake);
  document.addEventListener("mousemove", wake, { passive: true });

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const onControl = e.target instanceof Element && !!e.target.closest("button, a, input, select, textarea");
    let to = 0;
    switch (e.key) {
      case "ArrowRight": case "ArrowDown": case "PageDown": to = cur + 1; break;
      case "ArrowLeft": case "ArrowUp": case "PageUp": to = cur - 1; break;
      case " ": case "Spacebar": if (onControl) return; to = cur + (e.shiftKey ? -1 : 1); break;
      case "Home": to = 1; break;
      case "End": to = N; break;
      case "f": case "F": if (!canFs || e.shiftKey) return; e.preventDefault(); toggleFs(); return;
      default: return;
    }
    e.preventDefault();
    wake();
    go(to);
  });

  // click or tap: the left third of the slide goes back, the rest goes forward
  let swipedAt = 0;
  stage.addEventListener("click", (e) => {
    if (e.button !== 0 || Date.now() - swipedAt < 500) return;
    const r = imgOf(cur).getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    go(e.clientX < r.left + r.width / 3 ? cur - 1 : cur + 1);
  });
  // swipe: one finger, mostly horizontal, not while the page is pinch-zoomed (then the finger pans)
  let x0 = 0, y0 = 0, t0 = 0, multi = false;
  stage.addEventListener("touchstart", (e) => { multi = e.touches.length > 1; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); wake(); }, { passive: true });
  stage.addEventListener("touchmove", (e) => { if (e.touches.length > 1) multi = true; }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (multi || e.changedTouches.length !== 1 || (window.visualViewport && window.visualViewport.scale > 1.05)) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 40 && Math.abs(dx) > 1.5 * Math.abs(dy) && Date.now() - t0 < 800) { swipedAt = Date.now(); go(cur + (dx < 0 ? 1 : -1)); }
  }, { passive: true });

  window.addEventListener("hashchange", () => { const n = fromHash(); if (n) go(n); });
  let fitRaf = 0;
  window.addEventListener("resize", () => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fit); });

  const start = fromHash() || 1;
  slides.forEach((el, i) => { el.classList.remove("on"); if (i !== start - 1) el.setAttribute("aria-hidden", "true"); });
  go(start, false);
  track.update();
  requestAnimationFrame(fit);
})();
