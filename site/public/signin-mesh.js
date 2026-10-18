// The sign-in backdrop of genclass.dev (/admin, and /login, /signup and the other account pages served by
// telemetry-worker/): a self-healing geodesic sphere built from the same triangular lattice as the genclass.dev hero
// mesh. It assembles from scattered shards, requests orbit it, and every few seconds one of the bugs GenClass catches
// tears a patch (red): a stale write lifts and twists it, a duplicate lands a ghost copy beside it, a failing endpoint
// splits a seam. The predicted shape shows as green dots and a repair front closes the patch from its rim inward. A
// faint green meridian sweeps the surface the whole time (GenClass watching every request). Each keystroke in a form
// field sends a pulse across the surface, the cursor tears what it touches, and submitting seals the whole sphere
// green; an error the page shows afterwards (a server-rendered .err, or text a script puts in one) unseals it and
// tears one more patch that heals. Canvas 2D, no dependencies, same-origin (the admin CSP allows only 'self' scripts;
// the account pages load it with their nonce), paused while the tab is hidden, one still frame under
// prefers-reduced-motion. An illustration.
(() => {
  const cv = document.querySelector("canvas[data-mesh]");
  if (!cv || !window.CanvasRenderingContext2D) return;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BONE = "240,241,233", RED = "255,90,54", GREEN = "47,208,127";
  const RED_TXT = "255,122,87", GREEN_TXT = "91,227,155";
  const MONO = '11px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  const HEAL = 1400, BUCKETS = 10;
  const EVENTS = [
    { kind: "stale", bad: "GET /search?q=pa landed after q=paris", good: "[GenClass] dropped the stale write" },
    { kind: "dup", bad: "POST /api/orders sent twice", good: "[GenClass] merged it into #212, one order" },
    { kind: "tear", bad: "GET /api/inventory failed 5 times in 8 s", good: "[GenClass] flagged the failing endpoint" },
    { kind: "stale", bad: "cart.total written by an older response", good: "[GenClass] kept the newer value" },
  ];

  // seeded noise, so the shards and the first events fall the same way on every load
  let seed = 0x9e3779b9;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

  // ---------- geometry: an icosphere, its edges, neighbours and edge midpoints ----------
  function icosphere(level) {
    const t = (1 + Math.sqrt(5)) / 2;
    const P = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
      .map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });
    let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let s = 0; s < level; s++) {
      const mid = new Map(), next = [];
      const m = (a, b) => {
        const k = a < b ? a * 65536 + b : b * 65536 + a;
        let i = mid.get(k);
        if (i === undefined) {
          const [x, y, z] = [(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2, (P[a][2] + P[b][2]) / 2], l = Math.hypot(x, y, z);
          i = P.push([x / l, y / l, z / l]) - 1; mid.set(k, i);
        }
        return i;
      };
      for (const [a, b, c] of F) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
      F = next;
    }
    const seen = new Set(), E = [];
    for (const [a, b, c] of F) for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u < v ? u * 65536 + v : v * 65536 + u;
      if (!seen.has(k)) { seen.add(k); E.push(u < v ? u : v, u < v ? v : u); }
    }
    return { P, E: Uint32Array.from(E) };
  }

  let W = 0, H = 0, DPR = 1, CX = 0, CY = 0, R = 0, N = 0, NE = 0;
  let hx, hy, hz, dx, dy, dz, tx, ty, tz, vx, vy, vz, rel, st, ta, ts, sx, sy, sz, al, E, mx, my, mz;
  let grid = null, orbits = [], ghosts = [], notes = [], pulses = [], events = [];
  let nBroken = 0, nMended = 0, yaw = 0.6, pitch = 0.42, pYaw = 0, pPitch = 0, mouseX = -1e4, mouseY = -1e4, lastTear = 0;
  let t0 = 0, last = 0, nextEvent = 2600, seal = 0, raf = 0, firstEvent = true;

  function build() {
    W = innerWidth; H = innerHeight;
    DPR = Math.min(2, devicePixelRatio || 1);
    if (W * H * DPR * DPR > 5e6) DPR = Math.max(1, Math.sqrt(5e6 / (W * H)));
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const wide = W > 900;
    CX = wide ? W * 0.7 : W / 2; CY = H * 0.5;
    R = wide ? Math.min(H * 0.33, W * 0.2) : Math.min(W * 0.42, H * 0.3);
    if (N) return; // geometry survives a resize; only the projection changes
    const g = icosphere(W < 700 ? 2 : 3);
    N = g.P.length; E = g.E; NE = E.length / 2;
    const f = () => new Float32Array(N);
    hx = f(); hy = f(); hz = f(); dx = f(); dy = f(); dz = f(); tx = f(); ty = f(); tz = f(); vx = f(); vy = f(); vz = f();
    rel = f(); ta = f(); ts = f(); sx = f(); sy = f(); sz = f(); al = f(); st = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      [hx[i], hy[i], hz[i]] = g.P[i];
      // a shard flung outward along a random direction, released top to bottom
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u), k = 0.7 + rnd() * 1.9;
      dx[i] = tx[i] = s * Math.cos(th) * k; dy[i] = ty[i] = u * k; dz[i] = tz[i] = s * Math.sin(th) * k;
      rel[i] = still ? -1 : 250 + (1 - (hy[i] + 1) / 2) * 1300 + rnd() * 300;
    }
    mx = new Float32Array(NE); my = new Float32Array(NE); mz = new Float32Array(NE);
    for (let e = 0; e < NE; e++) {
      const a = E[2 * e], b = E[2 * e + 1], x = hx[a] + hx[b], y = hy[a] + hy[b], z = hz[a] + hz[b], l = Math.hypot(x, y, z);
      mx[e] = x / l; my[e] = y / l; mz[e] = z / l;
    }
    orbits = [0, 1, 2].map((i) => {
      const a = rnd() * Math.PI, b = 0.35 + rnd() * 0.9, r = 1.3 + i * 0.16;
      const n = [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)];
      let ux = [n[1], -n[0], 0]; const ul = Math.hypot(...ux) || 1; ux = ux.map((v) => v / ul);
      const vv = [n[1] * ux[2] - n[2] * ux[1], n[2] * ux[0] - n[0] * ux[2], n[0] * ux[1] - n[1] * ux[0]];
      return { r, u: ux, v: vv, dots: Array.from({ length: 2 + i }, () => ({ p: rnd() * Math.PI * 2, s: (0.22 + rnd() * 0.3) * (rnd() < 0.5 ? -1 : 1), trail: [] })) };
    });
    if (still) for (let i = 0; i < N; i++) { dx[i] = dy[i] = dz[i] = tx[i] = ty[i] = tz[i] = 0; }
  }

  // a faint dot grid that fades away from the sphere, drawn once per size
  function paintGrid() {
    grid = document.createElement("canvas");
    grid.width = cv.width; grid.height = cv.height;
    const g = grid.getContext("2d"); g.setTransform(DPR, 0, 0, DPR, 0, 0);
    const step = 26;
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) {
      const d = Math.hypot(x - CX, y - CY) / (R * 2.6);
      const a = 0.11 * (1 - clamp(d, 0, 1)) ** 1.6;
      if (a < 0.006) continue;
      g.fillStyle = `rgba(${BONE},${a})`; g.fillRect(x, y, 1, 1);
    }
  }

  // ---------- projection ----------
  function project(scale) {
    const cyw = Math.cos(yaw + pYaw), syw = Math.sin(yaw + pYaw), cp = Math.cos(pitch + pPitch), sp = Math.sin(pitch + pPitch), D = 4.2;
    for (let i = 0; i < N; i++) {
      const x = hx[i] + dx[i], y = hy[i] + dy[i], z = hz[i] + dz[i];
      const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw;
      const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      const k = (D / (D - z2)) * R * scale;
      sx[i] = CX + x1 * k; sy[i] = CY - y2 * k; sz[i] = z2;
    }
    return { cyw, syw, cp, sp, D };
  }
  const toScreen = (x, y, z, m, scale) => {
    const x1 = x * m.cyw + z * m.syw, z1 = -x * m.syw + z * m.cyw, y2 = y * m.cp - z1 * m.sp, z2 = y * m.sp + z1 * m.cp, k = (m.D / (m.D - z2)) * R * scale;
    return [CX + x1 * k, CY - y2 * k, z2];
  };
  // the model-space direction that currently faces the viewer
  const front = () => { const c = Math.cos(pitch + pPitch); return [-c * Math.sin(yaw + pYaw), Math.sin(pitch + pPitch), c * Math.cos(yaw + pYaw)]; };

  // ---------- events ----------
  function patchAround(cx, cy, cz, rad) {
    const out = [];
    for (let i = 0; i < N; i++) { const d = Math.acos(clamp(hx[i] * cx + hy[i] * cy + hz[i] * cz, -1, 1)); if (d < rad) out.push([i, d]); }
    return out;
  }
  function spawn(now, forced) {
    const f = front();
    // a centre on the visible face, a little off-axis so the patch reads in perspective
    let best = -1, bd = -2;
    for (let tries = 0; tries < 40; tries++) {
      const i = (rnd() * N) | 0, d = hx[i] * f[0] + hy[i] * f[1] + hz[i] * f[2];
      if (d > 0.45 && d < 0.92 && st[i] === 0 && (best < 0 || rnd() < 0.5)) { best = i; bd = d; }
    }
    if (best < 0) return;
    const spec = forced || EVENTS[firstEvent ? 0 : (rnd() * EVENTS.length) | 0];
    firstEvent = false;
    const cx = hx[best], cy = hy[best], cz = hz[best], rad = spec.kind === "tear" ? 0.5 : 0.3;
    const patch = patchAround(cx, cy, cz, rad);
    // tangent frame at the centre
    let ax = [-cz, 0, cx]; const al0 = Math.hypot(...ax) || 1; ax = ax.map((v) => v / al0);
    const bx = [cy * ax[2] - cz * ax[1], cz * ax[0] - cx * ax[2], cx * ax[1] - cy * ax[0]];
    const ev = { spec, t0: now, c: [cx, cy, cz], patch, left: 0, done: false, merge: now + 1250 };
    for (const [i, d] of patch) {
      const fall = 1 - d / rad;
      if (spec.kind === "stale") {
        // the old frame lands over the new one: lifted and twisted
        const lift = 0.07 + 0.11 * fall, tw = 0.16 * fall;
        tx[i] = hx[i] * lift + (ax[0] * tw); ty[i] = hy[i] * lift + (ax[1] * tw); tz[i] = hz[i] * lift + (ax[2] * tw);
      } else if (spec.kind === "tear") {
        // a seam splits along the b-axis: each side pulls away from it
        const side = hx[i] * ax[0] + hy[i] * ax[1] + hz[i] * ax[2];
        if (Math.abs(side) > 0.16) continue;
        const push = (0.05 + 0.07 * fall) * (side < 0 ? -1 : 1);
        tx[i] = ax[0] * push + hx[i] * 0.03; ty[i] = ax[1] * push + hy[i] * 0.03; tz[i] = ax[2] * push + hz[i] * 0.03;
      } else {
        // a duplicate: the patch itself stays, a ghost copy lands beside it
        continue;
      }
      st[i] = 1; ta[i] = now + 1150 + (1 - fall) * -200 + fall * 950; ev.left++;
    }
    if (spec.kind === "dup") {
      ghosts.push({ list: patch.map(([i]) => i), off: [bx[0] * 0.17 + cx * 0.06, bx[1] * 0.17 + cy * 0.06, bx[2] * 0.17 + cz * 0.06], t0: now, merge: ev.merge });
      ev.left = 0; ev.healAt = ev.merge + 520;
    }
    events.push(ev); notes.push({ ev, t0: now }); nBroken++;
    // the request that caused it streaks in from its orbit
    const o = orbits[(rnd() * orbits.length) | 0], dot = o.dots[0];
    ev.from = { o, dot };
  }
  function pulse(now) { const f = front(); pulses.push({ o: f, t0: now }); if (pulses.length > 6) pulses.shift(); }

  // ---------- step ----------
  function step(now, dt) {
    // springs toward each vertex's target; released shards fly home
    const k = 70, c = 13;
    for (let i = 0; i < N; i++) {
      if (rel[i] >= 0 && now - t0 >= rel[i]) { tx[i] = ty[i] = tz[i] = 0; rel[i] = -1; }
      if (st[i] === 1 && now >= ta[i]) { st[i] = 2; ts[i] = now; tx[i] = ty[i] = tz[i] = 0; }
      vx[i] += (k * (tx[i] - dx[i]) - c * vx[i]) * dt; vy[i] += (k * (ty[i] - dy[i]) - c * vy[i]) * dt; vz[i] += (k * (tz[i] - dz[i]) - c * vz[i]) * dt;
      dx[i] += vx[i] * dt; dy[i] += vy[i] * dt; dz[i] += vz[i] * dt;
      al[i] = rel[i] >= 0 ? 0 : 1;
    }
    for (const ev of events) {
      if (ev.done) continue;
      const open = ev.spec.kind === "dup" ? now < ev.healAt : ev.patch.some(([i]) => st[i] === 1);
      if (!open) { ev.done = true; nMended++; }
    }
    events = events.filter((ev) => !ev.done || now - ev.t0 < 6000);
    for (const o of orbits) for (const d of o.dots) d.p += d.s * dt;
    // gentle drift, plus parallax toward the cursor
    yaw += dt * 0.11;
    const tyaw = mouseX > -1e3 ? ((mouseX - CX) / W) * 0.5 : 0, tpitch = mouseY > -1e3 ? ((mouseY - CY) / H) * 0.3 : 0;
    pYaw += (tyaw - pYaw) * Math.min(1, dt * 2.5); pPitch += (tpitch - pPitch) * Math.min(1, dt * 2.5);
    pitch = 0.42 + Math.sin(now / 5200) * 0.08;
    if (now - t0 > nextEvent && !seal) { spawn(now); nextEvent = now - t0 + 2400 + rnd() * 1500; }
  }

  // the cursor tears the front face it passes over; the tear heals a moment later
  function tearAt(now) {
    if (mouseX < -1e3 || now - lastTear < 90 || seal) return;
    const d0 = Math.hypot(mouseX - CX, mouseY - CY);
    if (d0 > R * 1.08) return;
    let hit = 0;
    for (let i = 0; i < N; i++) {
      if (sz[i] < 0.1 || st[i] !== 0) continue;
      const d = Math.hypot(sx[i] - mouseX, sy[i] - mouseY);
      if (d > 34) continue;
      const f = 1 - d / 34, j = 0.05 + 0.08 * f;
      tx[i] = hx[i] * j + (rnd() - 0.5) * 0.05; ty[i] = hy[i] * j + (rnd() - 0.5) * 0.05; tz[i] = hz[i] * j + (rnd() - 0.5) * 0.05;
      st[i] = 1; ta[i] = now + 520 + rnd() * 420; hit++;
    }
    if (hit) { lastTear = now; nBroken++; setTimeout(() => nMended++, 1100); }
  }

  // ---------- draw ----------
  function draw(now) {
    const breathe = 1 + Math.sin(now / 1300) * 0.006, sealK = seal ? ease((now - seal) / 420) : 0, scale = breathe * (1 - 0.06 * sealK);
    const m = project(scale);
    ctx.clearRect(0, 0, W, H);
    if (grid) ctx.drawImage(grid, 0, 0, W, H);
    // glow and rim behind the sphere
    const glow = ctx.createRadialGradient(CX, CY, R * 0.1, CX, CY, R * 1.9);
    glow.addColorStop(0, `rgba(${GREEN},${0.11 + 0.08 * sealK})`); glow.addColorStop(0.5, `rgba(${GREEN},0.035)`); glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

    // orbits (back halves first, so the sphere hides them correctly enough for a wireframe)
    const orbitPts = orbits.map((o) => {
      const pts = [];
      for (let s = 0; s <= 96; s++) {
        const a = (s / 96) * Math.PI * 2, c = Math.cos(a) * o.r, d = Math.sin(a) * o.r;
        pts.push(toScreen(o.u[0] * c + o.v[0] * d, o.u[1] * c + o.v[1] * d, o.u[2] * c + o.v[2] * d, m, scale));
      }
      return pts;
    });
    const intro = clamp((now - t0 - 900) / 1200, 0, 1);
    ctx.lineWidth = 1;
    for (const pts of orbitPts) for (let s = 0; s < 96; s++) {
      const z = (pts[s][2] + pts[s + 1][2]) / 2;
      ctx.strokeStyle = `rgba(${BONE},${(0.04 + 0.13 * clamp((z + 1.6) / 3.2, 0, 1)) * intro})`;
      ctx.beginPath(); ctx.moveTo(pts[s][0], pts[s][1]); ctx.lineTo(pts[s + 1][0], pts[s + 1][1]); ctx.stroke();
    }

    // rim light: a thin bright limb and a soft inner falloff, so the wireframe reads as a solid body
    const rr = R * scale * 1.012;
    const rim = ctx.createRadialGradient(CX, CY, rr * 0.82, CX, CY, rr * 1.04);
    rim.addColorStop(0, "rgba(0,0,0,0)"); rim.addColorStop(0.86, `rgba(${GREEN},${0.06 * intro})`); rim.addColorStop(0.96, `rgba(${BONE},${0.1 * intro})`); rim.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rim; ctx.beginPath(); ctx.arc(CX, CY, rr * 1.04, 0, Math.PI * 2); ctx.fill();

    // lattice edges, bucketed by depth and state
    const bone = Array.from({ length: BUCKETS }, () => new Path2D()), red = [new Path2D(), new Path2D(), new Path2D()], grn = [new Path2D(), new Path2D(), new Path2D()];
    const pz = pulses.map((p) => ({ o: p.o, f: ((now - p.t0) / 1000) * 2.3 }));
    const sw = (now - t0) / 2600, nwx = Math.cos(sw), nwz = Math.sin(sw), sweepOn = intro >= 1;
    for (let e = 0; e < NE; e++) {
      const a = E[2 * e], b = E[2 * e + 1];
      if (!al[a] || !al[b]) continue;
      const z = (sz[a] + sz[b]) / 2, depth = clamp((z + 1) / 2, 0, 1);
      let p;
      if (st[a] === 1 || st[b] === 1) p = red[depth > 0.66 ? 2 : depth > 0.33 ? 1 : 0];
      else {
        const age = Math.min(st[a] === 2 ? now - ts[a] : 1e9, st[b] === 2 ? now - ts[b] : 1e9);
        let g = age < HEAL ? 1 - age / HEAL : 0;
        for (const q of pz) {
          const ang = Math.acos(clamp(mx[e] * q.o[0] + my[e] * q.o[1] + mz[e] * q.o[2], -1, 1)), off = Math.abs(ang - q.f);
          if (off < 0.2) g = Math.max(g, (1 - off / 0.2) * (1 - q.f / 3.4));
        }
        if (sweepOn) { const off = Math.abs(mx[e] * nwx + mz[e] * nwz); if (off < 0.045) g = Math.max(g, 0.3 * (1 - off / 0.045)); }
        if (sealK) g = Math.max(g, sealK);
        if (g > 0.08) p = grn[Math.min(2, (g * depth * 3.2) | 0)];
        else p = bone[Math.min(BUCKETS - 1, (Math.pow(depth, 1.5) * BUCKETS) | 0)];
      }
      p.moveTo(sx[a], sy[a]); p.lineTo(sx[b], sy[b]);
    }
    for (let i = 0; i < BUCKETS; i++) { ctx.strokeStyle = `rgba(${BONE},${0.035 + 0.5 * ((i + 0.5) / BUCKETS) ** 1.2})`; ctx.stroke(bone[i]); }
    [0.25, 0.55, 0.95].forEach((a, i) => { ctx.lineWidth = 1 + i * 0.35; ctx.strokeStyle = `rgba(${RED},${a})`; ctx.stroke(red[i]); });
    [0.3, 0.6, 0.95].forEach((a, i) => { ctx.lineWidth = 1 + i * 0.35; ctx.strokeStyle = `rgba(${GREEN},${a})`; ctx.stroke(grn[i]); });
    ctx.lineWidth = 1;

    // vertices on the front face catch the light; broken ones show red, their predicted home green
    const pts = new Path2D(), bad = new Path2D(), pred = new Path2D();
    for (let i = 0; i < N; i++) {
      if (!al[i]) continue;
      if (st[i] === 1) {
        bad.moveTo(sx[i] + 1.8, sy[i]); bad.arc(sx[i], sy[i], 1.8, 0, Math.PI * 2);
        if (now > ta[i] - 520) { const h = toScreen(hx[i], hy[i], hz[i], m, scale); pred.moveTo(h[0] + 1.6, h[1]); pred.arc(h[0], h[1], 1.6, 0, Math.PI * 2); }
      } else if (sz[i] > 0.55) { pts.rect(sx[i] - 0.6, sy[i] - 0.6, 1.2, 1.2); }
    }
    ctx.fillStyle = `rgba(${BONE},0.55)`; ctx.fill(pts);
    ctx.fillStyle = `rgba(${RED},0.95)`; ctx.fill(bad);
    ctx.fillStyle = `rgba(${GREEN},0.9)`; ctx.fill(pred);

    // duplicate ghosts: a red copy beside the patch, slid in and merged green
    for (let g = ghosts.length - 1; g >= 0; g--) {
      const G = ghosts[g], into = now < G.merge ? 0 : ease((now - G.merge) / 520), fadeIn = ease((now - G.t0) / 260);
      if (into >= 1 && now - G.merge > 900) { ghosts.splice(g, 1); continue; }
      const path = new Path2D(), k = 1 - into;
      for (const i of G.list) {
        const s = toScreen(hx[i] * 1.01 + G.off[0] * k, hy[i] * 1.01 + G.off[1] * k, hz[i] * 1.01 + G.off[2] * k, m, scale);
        path.moveTo(s[0] + 1.7, s[1]); path.arc(s[0], s[1], 1.7, 0, Math.PI * 2);
      }
      ctx.fillStyle = into > 0 ? `rgba(${GREEN},${0.9 * (1 - clamp((now - G.merge - 400) / 500, 0, 1))})` : `rgba(${RED},${0.85 * fadeIn})`;
      ctx.fill(path);
    }

    // requests on their orbits, with short trails; the one behind a fresh event streaks in red
    for (let oi = 0; oi < orbits.length; oi++) {
      const o = orbits[oi];
      for (const d of o.dots) {
        const c = Math.cos(d.p) * o.r, s = Math.sin(d.p) * o.r;
        const p = toScreen(o.u[0] * c + o.v[0] * s, o.u[1] * c + o.v[1] * s, o.u[2] * c + o.v[2] * s, m, scale);
        d.trail.push(p); if (d.trail.length > 14) d.trail.shift();
        const hot = events.some((ev) => ev.from && ev.from.dot === d && now - ev.t0 < 700);
        const col = hot ? RED : p[2] > 0 ? GREEN : BONE;
        for (let t = 1; t < d.trail.length; t++) {
          ctx.strokeStyle = `rgba(${col},${(t / d.trail.length) * 0.5 * intro * (p[2] > -0.4 ? 1 : 0.35)})`;
          ctx.beginPath(); ctx.moveTo(d.trail[t - 1][0], d.trail[t - 1][1]); ctx.lineTo(d.trail[t][0], d.trail[t][1]); ctx.stroke();
        }
        ctx.fillStyle = `rgba(${col},${(p[2] > -0.4 ? 0.95 : 0.3) * intro})`;
        ctx.beginPath(); ctx.arc(p[0], p[1], hot ? 2.6 : 1.9, 0, Math.PI * 2); ctx.fill();
        if (hot) {
          const ev = events.find((e) => e.from && e.from.dot === d), cs = toScreen(ev.c[0], ev.c[1], ev.c[2], m, scale), f = ease((now - ev.t0) / 380);
          ctx.strokeStyle = `rgba(${RED},${0.7 * (1 - f)})`; ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + (cs[0] - p[0]) * f, p[1] + (cs[1] - p[1]) * f); ctx.stroke(); ctx.lineWidth = 1;
          ctx.strokeStyle = `rgba(${RED},${0.6 * (1 - f)})`; ctx.beginPath(); ctx.arc(cs[0], cs[1], 6 + 26 * f, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }

    // notes, written like the runtime's console lines, pinned beside their patch
    ctx.font = MONO; ctx.textBaseline = "middle";
    // on narrow screens the sphere sits behind the form, so its notes stay hidden
    for (let n = W > 900 ? notes.length - 1 : -1; n >= 0; n--) {
      const N0 = notes[n], age = now - N0.t0;
      if (age > 3800) { notes.splice(n, 1); continue; }
      const ev = N0.ev, cs = toScreen(ev.c[0] * 1.12, ev.c[1] * 1.12, ev.c[2] * 1.12, m, scale);
      if (cs[2] < -0.1) continue;
      const healed = ev.done || (ev.spec.kind === "dup" ? now >= ev.merge : !ev.patch.some(([i]) => st[i] === 1) && age > 900);
      const text = healed ? ev.spec.good : ev.spec.bad, a = Math.min(1, age / 160, (3800 - age) / 450);
      const w = ctx.measureText(text).width + 10, minX = W > 900 ? W * 0.42 : 8;
      const right = cs[0] > CX || cs[0] - 16 - w < minX, lx = clamp(right ? cs[0] + 16 : cs[0] - 16 - w, minX, W - w - 8), ly = clamp(cs[1] - 14, 14, H - 14);
      ctx.strokeStyle = `rgba(${healed ? GREEN : RED},${0.35 * a})`;
      ctx.beginPath(); ctx.moveTo(cs[0], cs[1]); ctx.lineTo(right ? lx : lx + w, ly); ctx.stroke();
      ctx.fillStyle = `rgba(0,0,0,${0.85 * a})`; ctx.fillRect(lx, ly - 9, w, 18);
      ctx.strokeStyle = `rgba(${healed ? GREEN : RED},${0.4 * a})`; ctx.strokeRect(lx + 0.5, ly - 8.5, w - 1, 17);
      ctx.fillStyle = `rgba(${healed ? GREEN_TXT : RED_TXT},${a})`; ctx.fillText(text, lx + 5, ly);
    }
    if (cap) cap.lastChild.textContent = `broken ${nBroken} · mended ${nMended}`;
  }

  // ---------- caption, input, lifecycle ----------
  const cap = document.createElement("p");
  cap.className = "mesh-cap"; cap.setAttribute("aria-hidden", "true");
  const c1 = document.createElement("span"), c2 = document.createElement("span");
  c1.textContent = matchMedia("(pointer: coarse)").matches ? "Illustration · the mesh heals itself" : "Illustration · drag across the mesh";
  cap.append(c1, c2); document.body.append(cap);

  function frame(now) {
    raf = 0;
    if (document.hidden) return;
    if (!t0) { t0 = now; last = now; }
    const dt = Math.min(0.034, (now - last) / 1000); last = now;
    tearAt(now); step(now, dt); draw(now);
    raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf && !document.hidden && !still) raf = requestAnimationFrame(frame); };

  build(); paintGrid();
  if (still) { t0 = performance.now() - 6000; step(t0 + 6000, 0); draw(t0 + 6000); }
  else kick();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { last = performance.now(); kick(); } });
  let rt = 0;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { build(); paintGrid(); if (still) draw(performance.now()); }, 120); });
  addEventListener("pointermove", (e) => { mouseX = e.clientX; mouseY = e.clientY; }, { passive: true });
  document.addEventListener("pointerleave", () => { mouseX = mouseY = -1e4; });
  document.querySelectorAll("form input").forEach((f) => f.addEventListener("input", () => pulse(performance.now())));
  // the sign-out form in an account page's header is not a sign-in
  document.querySelectorAll("form:not(.so)").forEach((f) => f.addEventListener("submit", () => { seal = performance.now(); }));
  // a refused sign-in shows as one more bug that heals: nothing changed, try again
  const refused = (bad, wait) => {
    const once = { kind: "tear", bad, good: "[GenClass] nothing changed, try again" };
    setTimeout(() => { seal = 0; if (t0) spawn(performance.now(), once); }, wait);
  };
  const errs = [...document.querySelectorAll(".err")];
  if (errs.some((e) => e.textContent.trim())) refused("wrong password", still ? 0 : 2300);
  if (window.MutationObserver) {
    const mo = new MutationObserver(() => { if (errs.some((e) => e.textContent.trim())) refused("sign-in refused", 0); });
    errs.forEach((e) => mo.observe(e, { childList: true, characterData: true, subtree: true }));
  }
})();
