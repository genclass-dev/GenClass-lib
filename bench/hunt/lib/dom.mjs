// Small DOM helpers for scenarios and their oracles. An oracle is the scenario author's own record of what the page
// shows at the end of a run; the harness compares it across runs as a secondary check, apart from GenClass's verdict.

/** Visible text of `selector` (default the whole body), one entry per non-empty line, whitespace collapsed. */
export async function textLines(page, selector = "body", max = 400) {
  return page.evaluate(
    ([sel, n]) => {
      const el = document.querySelector(sel);
      if (!el) return [];
      const text = String(el.innerText ?? el.textContent ?? "");
      return text
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, n);
    },
    [selector, max],
  );
}

/** How many elements match. */
export async function countOf(page, selector) {
  return page.locator(selector).count();
}

/** A scenario parameter (`--param key=value`), with a default. */
export function param(ctx, key, fallback) {
  const v = ctx?.params?.[key];
  return v === undefined || v === "" ? fallback : v;
}

/** A parameter as a number. */
export function numberParam(ctx, key, fallback) {
  const v = Number(param(ctx, key, fallback));
  return Number.isFinite(v) ? v : fallback;
}
