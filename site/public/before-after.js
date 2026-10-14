// genclass.dev homepage, the before-and-after frame (src/partials/before-after.html): the divider follows a mouse,
// finger or pen (a tap moves it there; a vertical swipe still scrolls the page), and the arrow keys on the hidden range
// input. On first view, when motion is allowed and nobody has touched it yet, the divider sways once.
(() => {
  const view = document.querySelector(".ba-view");
  const range = view && view.querySelector(".ba-range");
  if (!range) return;
  let pos = 50, drag = null, raf = 0, used = false;
  const set = (p) => {
    pos = Math.max(0, Math.min(100, p));
    view.style.setProperty("--pos", pos.toFixed(2));
    range.value = String(Math.round(pos));
  };
  const at = (x) => { const r = view.getBoundingClientRect(); if (r.width) set(((x - r.left) / r.width) * 100); };
  const stop = () => { used = true; if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  const grab = (e) => { drag.live = true; try { view.setPointerCapture(e.pointerId); } catch {} view.classList.add("is-drag"); };
  const done = () => { drag = null; view.classList.remove("is-drag"); };

  view.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || drag) return;
    stop();
    drag = { id: e.pointerId, x: e.clientX, live: false };
    if (e.pointerType === "mouse") { e.preventDefault(); grab(e); at(e.clientX); }
  });
  view.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.live) { if (Math.abs(e.clientX - drag.x) < 6) return; grab(e); }
    at(e.clientX);
  });
  view.addEventListener("pointerup", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.live) at(e.clientX);
    done();
  });
  view.addEventListener("pointercancel", (e) => { if (drag && drag.id === e.pointerId) done(); });

  range.addEventListener("input", () => { stop(); set(+range.value); });
  range.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -25, PageUp: 25, Home: -100, End: 100 }[e.key];
    if (d === undefined) return;
    e.preventDefault(); stop(); set(pos + d);
  });

  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  if (calm.matches || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver((es) => {
    if (!es.some((x) => x.isIntersecting)) return;
    io.disconnect();
    setTimeout(() => {
      if (used || calm.matches) return;
      const keys = [50, 38, 60, 50], t0 = performance.now(), D = 1700;
      const step = (t) => {
        const k = Math.min(1, (t - t0) / D) * 3, i = Math.min(2, Math.floor(k)), f = k - i;
        const ease = f < 0.5 ? 2 * f * f : 1 - (2 - 2 * f) ** 2 / 2;
        set(keys[i] + (keys[i + 1] - keys[i]) * ease);
        raf = k < 3 ? requestAnimationFrame(step) : 0;
      };
      raf = requestAnimationFrame(step);
    }, 400);
  }, { threshold: 0.6 });
  io.observe(view);
})();
