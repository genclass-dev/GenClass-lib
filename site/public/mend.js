// The self-healing mesh behind the genclass.dev hero. An illustration of what GenClass is for: a lattice that knows
// its own shape gets broken (an old frame lands over newer data, the same change arrives twice, an endpoint tears a
// seam), the shape it should have is predicted from its neighbours (green dots), and a repair front knits it back.
// Move the cursor through it to break it yourself. Canvas 2D, no dependencies; one static frame under
// prefers-reduced-motion; stops drawing when off screen or hidden. The site is light-only, so the ink stays navy.
(() => {
  const stage = document.querySelector(".mend-stage");
  if (!stage || !window.CanvasRenderingContext2D) return;
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cv = document.createElement("canvas");
  cv.className = "mend";
  cv.setAttribute("aria-hidden", "true");
  stage.prepend(cv);
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const INK = "14,31,77", RED = "240,69,28", GREEN = "20,184,106";
  const MONO = '11px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  // Lattice strength: AMAX in the open, AMIN under the text (still visible, but the headline stays easy to read).
  const AMAX = 0.56, AMIN = 0.1, FADE = 72;
  const at = (f) => AMIN + (AMAX - AMIN) * f;
  const SOFT = at(0.12); // under or right next to the text: no dots, no pointer damage
  const OPEN = at(0.6); // where the scripted breaks may start
  const Z1 = at(0.2), Z2 = at(0.55); // red and green come in three strengths so nothing loud crosses the headline
  const HEAL = 1300; // how long a mended point stays green, the visible repair front

  let TEXT = [];
  let W = 0, H = 0, S = 22, bump = 0, LW = 1.35, N = 0, cols = 0, rows = 0, RH = 0, E = 0;
  let hx, hy, x, y, vx, vy, st, ts, ta, al, ea, eb, a0, adj, fresh;
  const ghosts = [], labels = [];
  let now = 0, last = 0, nextEvent = 1400, raf = 0, visible = true, onScreen = true;
  let nBroken = 0, nHealed = 0, kind = 0, slow = 0, frames = 0, introDone = false;

  // ---------- lattice ----------
  function build() {
    const r = stage.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S = (W < 700 ? 26 : 22) + bump; // a slow device gets a coarser lattice (bump), never a finer one
    LW = W < 700 ? 1.25 : 1.35;
    RH = S * 0.8660254;
    cols = Math.ceil(W / S) + 2;
    rows = Math.ceil(H / RH) + 2;
    N = cols * rows;
    hx = new Float32Array(N); hy = new Float32Array(N);
    x = new Float32Array(N); y = new Float32Array(N);
    vx = new Float32Array(N); vy = new Float32Array(N);
    st = new Uint8Array(N); fresh = new Uint8Array(N); ts = new Float32Array(N); ta = new Float32Array(N); al = new Float32Array(N);
    const A = [], B = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        hx[k] = x[k] = (i - 1) * S + (j & 1 ? S / 2 : 0);
        hy[k] = y[k] = (j - 1) * RH;
        if (i + 1 < cols) { A.push(k); B.push(k + 1); }
        if (j + 1 < rows) {
          A.push(k); B.push(k + cols);
          if (j & 1) { if (i + 1 < cols) { A.push(k); B.push(k + cols + 1); } }
          else if (i > 0) { A.push(k); B.push(k + cols - 1); }
        }
      }
    }
    E = A.length;
    ea = Int32Array.from(A); eb = Int32Array.from(B);
    const deg = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) { deg[ea[e] + 1]++; deg[eb[e] + 1]++; }
    for (let k = 0; k < N; k++) deg[k + 1] += deg[k];
    a0 = deg; adj = new Int32Array(2 * E);
    const fill = a0.slice(0, N);
    for (let e = 0; e < E; e++) { adj[fill[ea[e]]++] = eb[e]; adj[fill[eb[e]]++] = ea[e]; }
    ghosts.length = 0; labels.length = 0;
    mask();
    if (!introDone && !reduce) intro();
  }

  // First paint: the lattice starts as scattered dust and a repair front spreads from the headline and knits it.
  function intro() {
    introDone = true;
    const h1 = stage.querySelector("h1 em") || stage.querySelector("h1");
    const sr = stage.getBoundingClientRect(), b = h1 ? h1.getBoundingClientRect() : sr;
    const ox = b.left - sr.left + b.width / 2, oy = b.top - sr.top + b.height / 2;
    for (let k = 0; k < N; k++) {
      const d = Math.hypot(hx[k] - ox, hy[k] - oy);
      if (d < 28) continue;
      const a = Math.random() * 6.2832, r = 30 + Math.random() * 110;
      x[k] = hx[k] + Math.cos(a) * r; y[k] = hy[k] + Math.sin(a) * r;
      vx[k] = vy[k] = 0;
      st[k] = 1; fresh[k] = 1; ts[k] = now; ta[k] = now + 250 + d * 1.35;
    }
    nextEvent = now + 2800;
  }

  // Lines soften under the text so the headline stays readable, and fade at the top and bottom edges.
  function mask() {
    const sr = stage.getBoundingClientRect();
    const rects = [...stage.querySelectorAll(".announce,h1,.lede,.ctas,.install-line,.fw")]
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 0)
      .map((b) => [b.left - sr.left - 12, b.top - sr.top - 8, b.right - sr.left + 12, b.bottom - sr.top + 8]);
    TEXT = rects;
    for (let k = 0; k < N; k++) {
      let d = 1e9;
      for (const [l, t, r, b] of rects) {
        const dx = Math.max(l - hx[k], 0, hx[k] - r), dy = Math.max(t - hy[k], 0, hy[k] - b);
        d = Math.min(d, Math.hypot(dx, dy));
      }
      const f = d >= FADE ? 1 : d <= 0 ? 0 : (d / FADE) * (d / FADE) * (3 - 2 * (d / FADE));
      const edge = Math.min(1, Math.max(0, hy[k] / 48), Math.max(0, (H - hy[k]) / 120));
      al[k] = at(f) * edge;
    }
  }

  // ---------- breaking ----------
  function near(cx, cy, R, fn) {
    const j0 = Math.max(0, Math.floor((cy - R) / RH) + 1), j1 = Math.min(rows - 1, Math.ceil((cy + R) / RH) + 1);
    const i0 = Math.max(0, Math.floor((cx - R) / S)), i1 = Math.min(cols - 1, Math.ceil((cx + R) / S) + 2);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * cols + i, d = Math.hypot(hx[k] - cx, hy[k] - cy);
      if (d <= R) fn(k, d);
    }
  }
  function hurt(k, delay) {
    if (st[k] !== 1) nBroken++;
    fresh[k] = 0;
    st[k] = 1; ts[k] = now; ta[k] = now + delay;
  }
  function spot() {
    for (let n = 0; n < 80; n++) {
      const k = (Math.random() * N) | 0;
      if (al[k] > OPEN && hx[k] > 40 && hx[k] < W - 40 && hy[k] > 60 && hy[k] < H - 90) return [hx[k], hy[k]];
    }
    return null;
  }
  // A note goes where it overlaps no text and no other note and stays inside the canvas; if there is no such place, no note.
  function label(cx, cy, bad, good, heal) {
    ctx.font = MONO;
    const w = Math.max(ctx.measureText(bad).width, ctx.measureText(good).width) + 10, h = 18;
    if (w > W - 24) return;
    const xs = [Math.min(Math.max(12, cx - w / 2), W - 12 - w), cx + 18, cx - 18 - w], ys = [cy + 52, cy - 52, cy + 78, cy - 78];
    for (const ly of ys) for (const lx of xs) {
      const l = lx - 4, t = ly - h / 2 - 4, r = lx + w + 4, b = ly + h / 2 + 4;
      if (l < 8 || r > W - 8 || t < 50 || b > H - 34) continue;
      if (TEXT.some(([tl, tt, tr, tb]) => l < tr && r > tl && t < tb && b > tt)) continue;
      if (labels.some((o) => l < o.lx + o.w && r > o.lx - 9 && t < o.ly + 13 && b > o.ly - 13)) continue; // nor another note
      labels.push({ lx: lx + 5, ly, w, bad, good, t0: now, tg: now + heal });
      return;
    }
  }

  // An older response lands over newer data: a patch of the lattice shows up where it used to be.
  function stale(cx, cy) {
    const ox = (Math.random() < 0.5 ? -1 : 1) * (16 + Math.random() * 14), oy = (Math.random() - 0.5) * 18;
    near(cx, cy, 62, (k, d) => { x[k] = hx[k] + ox; y[k] = hy[k] + oy; vx[k] = vy[k] = 0; hurt(k, 950 + d * 5); });
    label(cx, cy, "an older response landed over newer data", "[GenClass] kept the newer data", 1000);
  }
  // The same change arrives twice: a ghost copy sits beside the real patch until it is merged into it.
  function duplicate(cx, cy) {
    const list = [];
    near(cx, cy, 50, (k) => { list.push(k); hurt(k, 1100); });
    ghosts.push({ list, ox: 9 + Math.random() * 7, oy: -7 - Math.random() * 5, t0: now, tm: now + 1100 });
    label(cx, cy, "the same POST, sent twice", "[GenClass] reused the first response", 1150);
  }
  // An endpoint keeps failing: a seam tears open, then closes from its ends.
  function tear(cx, cy) {
    const a = Math.random() * Math.PI, c = Math.cos(a), s = Math.sin(a), L = 170;
    near(cx, cy, L / 2 + 30, (k) => {
      const px = hx[k] - cx, py = hy[k] - cy, along = px * c + py * s, perp = -px * s + py * c;
      if (Math.abs(along) > L / 2 || Math.abs(perp) > 24) return;
      const side = perp >= 0 ? 1 : -1, f = 1 - Math.abs(perp) / 24;
      vx[k] += -s * side * 240 * f; vy[k] += c * side * 240 * f;
      hurt(k, 1300 - Math.abs(along) * 4);
    });
    label(cx, cy, "GET /api/stock failed 5 times in a row", "[GenClass] backed off, retried once", 1150);
  }
  const KINDS = [stale, duplicate, tear];

  // ---------- simulation ----------
  function step(dt) {
    const ms = dt * 1000;
    now += ms;
    if (now >= nextEvent) {
      const p = spot();
      if (p) KINDS[kind++ % KINDS.length](p[0], p[1]);
      nextEvent = now + 1500 + Math.random() * 1200;
    }
    for (let k = 0; k < N; k++) {
      const s = st[k];
      if (s === 1 && now >= ta[k]) {
        // the repair front: a broken point is mended once a neighbour holds its shape
        let ok = now > ta[k] + 2600;
        for (let q = a0[k]; q < a0[k + 1] && !ok; q++) {
          const n = adj[q];
          if (st[n] === 0 || (st[n] === 2 && now - ts[n] > 60)) ok = true;
        }
        if (ok && Math.random() < dt * 16) { st[k] = 2; ts[k] = now; }
      } else if (s === 2 && now - ts[k] > HEAL) { st[k] = 0; if (fresh[k]) fresh[k] = 0; else nHealed++; }
      const sp = s === 1 ? 0 : s === 2 ? 95 : 28, dm = s === 1 ? 2.4 : s === 2 ? 15 : 9;
      const tx = hx[k] + (s === 0 ? Math.sin(now * 0.0007 + hy[k] * 0.031) * 0.8 : 0);
      const ty = hy[k] + (s === 0 ? Math.cos(now * 0.0006 + hx[k] * 0.027) * 0.8 : 0);
      vx[k] += (sp * (tx - x[k]) - dm * vx[k]) * dt;
      vy[k] += (sp * (ty - y[k]) - dm * vy[k]) * dt;
      x[k] += vx[k] * dt; y[k] += vy[k] * dt;
    }
  }

  // ---------- drawing ----------
  const INKB = 8;
  const RED_A = [0.16, 0.5, 0.9], RED_W = [1, 1.25, 1.5], GRN_A = [0.35, 0.65, 0.95], GRN_W = [1, 1.3, 1.6];
  function dot(p, px, py, r) { p.moveTo(px + r, py); p.arc(px, py, r, 0, 6.2832); }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const ink = [], red = [new Path2D(), new Path2D(), new Path2D()], grn = [new Path2D(), new Path2D(), new Path2D()];
    const dust = new Path2D(); // the first paint's scattered lattice: quiet ink, not a bug
    for (let b = 0; b < INKB; b++) ink.push(new Path2D());
    const zone = (v) => (v < Z1 ? 0 : v < Z2 ? 1 : 2);
    const tornSq = (3 * S) * (3 * S);
    for (let e = 0; e < E; e++) {
      const a = ea[e], b = eb[e], sa = st[a], sb = st[b];
      const dx = x[b] - x[a], dy = y[b] - y[a];
      if (dx * dx + dy * dy > tornSq) continue; // torn open
      let p;
      const v = (al[a] + al[b]) * 0.5;
      if (sa === 1 || sb === 1) p = (sa !== 1 || fresh[a]) && (sb !== 1 || fresh[b]) ? dust : red[zone(v)];
      else if (sa === 2 || sb === 2) {
        const t = Math.max(sa === 2 ? ts[a] : 0, sb === 2 ? ts[b] : 0);
        const f = Math.min(2, Math.max(0, ((1 - (now - t) / HEAL) * 3) | 0));
        p = grn[Math.min(f, zone(v))];
      } else {
        if (v < 0.012) continue;
        p = ink[Math.min(INKB - 1, ((v / AMAX) * INKB) | 0)];
      }
      p.moveTo(x[a], y[a]); p.lineTo(x[b], y[b]);
    }
    ctx.lineWidth = LW;
    for (let b = 0; b < INKB; b++) { ctx.strokeStyle = `rgba(${INK},${((b + 0.5) / INKB) * AMAX})`; ctx.stroke(ink[b]); }
    ctx.strokeStyle = `rgba(${INK},0.16)`; ctx.stroke(dust);
    for (let g = 0; g < 3; g++) { ctx.lineWidth = LW * RED_W[g]; ctx.strokeStyle = `rgba(${RED},${RED_A[g]})`; ctx.stroke(red[g]); }
    for (let g = 0; g < 3; g++) { ctx.lineWidth = LW * GRN_W[g]; ctx.strokeStyle = `rgba(${GREEN},${GRN_A[g]})`; ctx.stroke(grn[g]); }

    // predicted shape (green dots where the points should be) and the broken points themselves
    const pred = new Path2D(), bad = new Path2D(), mote = new Path2D();
    for (let k = 0; k < N; k++) {
      if (al[k] < SOFT) continue;
      if (st[k] === 1) {
        if (fresh[k]) dot(mote, x[k], y[k], 1.4); else dot(bad, x[k], y[k], 2);
        if (now > ta[k] - 380) dot(pred, hx[k], hy[k], 1.8);
      } else if (st[k] === 2 && now - ts[k] < 360) dot(pred, hx[k], hy[k], 1.8);
    }
    ctx.fillStyle = `rgba(${INK},0.4)`; ctx.fill(mote);
    ctx.fillStyle = `rgba(${RED},0.9)`; ctx.fill(bad);
    ctx.fillStyle = `rgba(${GREEN},0.85)`; ctx.fill(pred);

    // duplicates: a ghost copy that slides into the real patch once it is merged
    for (let g = ghosts.length - 1; g >= 0; g--) {
      const G = ghosts[g], f = now < G.tm ? 1 : Math.max(0, 1 - (now - G.tm) / 520);
      if (f <= 0) { ghosts.splice(g, 1); continue; }
      const path = new Path2D();
      for (const k of G.list) dot(path, x[k] + G.ox * f, y[k] + G.oy * f, 1.8);
      ctx.fillStyle = now < G.tm ? `rgba(${RED},0.75)` : `rgba(${GREEN},${0.8 * f})`;
      ctx.fill(path);
    }

    // event notes, written like the runtime's console lines
    ctx.font = MONO;
    ctx.textBaseline = "middle";
    for (let i = labels.length - 1; i >= 0; i--) {
      const L = labels[i], age = now - L.t0;
      if (age > 3600) { labels.splice(i, 1); continue; }
      const healed = now >= L.tg, text = healed ? L.good : L.bad;
      const a = Math.min(1, age / 160, (3600 - age) / 450);
      ctx.fillStyle = `rgba(255,255,255,${0.9 * a})`;
      ctx.fillRect(L.lx - 5, L.ly - 9, L.w, 18);
      ctx.fillStyle = `rgba(${healed ? GREEN : RED},${a})`;
      ctx.fillText(text, L.lx, L.ly);
    }
  }

  // ---------- loop, input, lifecycle ----------
  function frame(t) {
    raf = 0;
    if (!visible || !onScreen) return;
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;
    const t0 = performance.now();
    step(dt);
    draw();
    // a slow device gets a coarser lattice instead of a janky page
    if (performance.now() - t0 > 12) slow++;
    if (++frames % 90 === 0) {
      if (slow > 45 && bump < 12) { bump += 4; build(); }
      slow = 0;
    }
    raf = requestAnimationFrame(frame);
  }
  function start() { if (!raf && !reduce && visible && onScreen) { last = 0; raf = requestAnimationFrame(frame); } }

  let px = -1, py = -1, pt = 0;
  if (!reduce) {
    stage.addEventListener("pointermove", (e) => {
      const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, t = performance.now();
      if (px >= 0) {
        const d = Math.max(8, t - pt) / 1000, sx = (mx - px) / d, sy = (my - py) / d, sp = Math.hypot(sx, sy);
        if (sp > 80) {
          const R = Math.min(64, 24 + sp * 0.018);
          near(mx, my, R, (k, dd) => {
            if (al[k] < SOFT) return; // never under the text
            const f = 1 - dd / R;
            vx[k] += Math.max(-900, Math.min(900, sx)) * 0.32 * f;
            vy[k] += Math.max(-900, Math.min(900, sy)) * 0.32 * f;
            hurt(k, 480 + Math.random() * 300);
          });
        }
      }
      px = mx; py = my; pt = t;
    }, { passive: true });
    stage.addEventListener("pointerleave", () => { px = -1; }, { passive: true });
    stage.addEventListener("pointerdown", (e) => {
      if (e.target.closest("a,button,input,textarea,select,code,pre")) return;
      const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      near(mx, my, 120, (k, dd) => {
        if (al[k] < SOFT) return;
        const f = 1 - dd / 120, ux = (hx[k] - mx) / (dd || 1), uy = (hy[k] - my) / (dd || 1);
        vx[k] += ux * 520 * f; vy[k] += uy * 520 * f;
        hurt(k, 380 + dd * 3);
      });
    }, { passive: true });
  }

  const cap = document.createElement("p");
  cap.className = "mend-cap";
  stage.append(cap);
  if (reduce) cap.textContent = "Illustration";
  else setInterval(() => { if (visible && onScreen) cap.textContent = `Illustration · broken ${nBroken} · mended ${nHealed} · drag through it`; }, 400);

  document.addEventListener("visibilitychange", () => { visible = document.visibilityState !== "hidden"; start(); });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; start(); }).observe(stage);
  }
  let rt = 0;
  const rebuild = () => { clearTimeout(rt); rt = setTimeout(() => { build(); if (reduce) draw(); }, 160); };
  if ("ResizeObserver" in window) new ResizeObserver(rebuild).observe(stage);
  else window.addEventListener("resize", rebuild);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { mask(); if (reduce) draw(); });

  build();
  if (reduce) draw();
  else start();
})();
