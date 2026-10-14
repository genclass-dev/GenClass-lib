// The model judge: Cloudflare's Clef (@cf/cloudflare/clef, a vision decision model) on Workers AI, asked about one
// element at a time. It reads a crop of the view (the element's box plus 24 px, cut from a viewport screenshot) and a
// state text, with the questions and score of the evaluation on wave2/clef-eval (vision/clef/README.md,
// vision/clef/eval.py; score 1 - P(nothing is wrong) on the family question). Two uses (src/report.ts):
//   1. a second stage on the measured visual checks' findings, with the element's measured facts (src/judge-page.ts)
//      and the caution line (clef-img-p3): one the model scores below KEEP_THRESHOLD in every view it appeared in is
//      listed, not scored ("a model judged it as probably fine"), never dropped; page-overflow-x, image-broken and
//      text-template-leak are left as they are (the evaluation: the crop cannot show a page that scrolls sideways, and
//      the model drops real ones there), and so is a finding with no element to crop;
//   2. findings of its own on elements the measured checks abstain on, with the image and the tag only
//      (clef-imgonly-p2, ABSTAIN_TEXT, chosen in calibration), when it scores one at FIND_THRESHOLD or more: Visual
//      bugs, moderate, labelled "Judged from the screenshot by a model (Clef)", never a measured check.
//
// Invariants:
// - A judge failure never breaks a scan: a call that throws, answers malformed data or takes longer than
//   JUDGE_TIMEOUT_MS is recorded as unanswered, and its finding stays as the measured checks reported it.
// - At most JUDGE_MAX_CALLS calls per scan (JudgeBudget: each view's JUDGE_SHARE guaranteed, what a view leaves goes
//   to the views after it); each call is sent as soon as its crop is taken, and they run in parallel.
// - What the page controls reaches the model only as the evaluation's extractor kept it: numbers, colours, a tag and
//   a role cut to [a-z-], text lengths, leak-pattern ids and their matched characters (at most 24). The crop image is
//   the page as a visitor sees it, and is the only thing sent besides that text.
// - Only option keys the questions offer are read back; probabilities must be numbers in [0, 1].
// - The thresholds were chosen on the evaluation's dev split (25 real of 412 crops) and never on a scanned page.

/** The model, as Workers AI names it, and in words. */
export const JUDGE_MODEL = "@cf/cloudflare/clef";
export const JUDGE_NAME = "Clef";
export const JUDGE_PLATFORM = "Cloudflare Workers AI";
/**
 * The prompt and candidate rules, by name: the evaluation's variant, and a suffix for each change calibration made
 * (CALIBRATION.md). Reports and /api/scan/health carry it, so a report says which prompt judged it.
 */
export const JUDGE_PROMPT = "clef-img-p3 + clef-imgonly-p2 r3";
/** Calls per scan, at most, across the three views; each view's share (desktop, light phone, dark phone). */
export const JUDGE_MAX_CALLS = 40;
export const JUDGE_SHARE: Record<string, number> = { desktop: 14, phone: 13, "phone-dark": 13 };
/** How long one call may take, from when it is sent, before its answer is ignored. */
export const JUDGE_TIMEOUT_MS = 4000;
/** Context around the element's box in the crop, as the evaluation cut its crops (vision/src/candidates.mjs cropRect). */
export const CROP_PAD = 24;

/**
 * Keep a measured finding when the model's score reaches this: the threshold that gave recall 0.5 on the dev split
 * (clef-img-p3, anyProblem). On the report split, rules then Clef at this threshold: 109 kept of 408 rule flags, 61
 * real; precision 0.560 (rules alone 0.225), recall 0.535 of every real (rules alone 0.807).
 */
export const KEEP_THRESHOLD = 0.9777;
/**
 * A finding of the model's own from this score, with the image + tag only text (ABSTAIN_TEXT): the lowest dev threshold
 * of clef-imgonly-p2 with precision at least 0.8 (4 crops at or above it on dev, all 4 real; recall 0.16). On the
 * report split: 36 at or above it, 32 real, precision 0.89; on the crops no rule flagged, 5 of 5. (With the facts and the
 * caution, clef-img-p3, the same rule gave 0.9843: 5 of 6 on dev, 33 of 44 on report, 1 of 3 on crops no rule flagged.)
 */
export const FIND_THRESHOLD = 0.9757;

/** The evaluation's numbers the page and /scan/about publish (vision/results/clef/RESULTS.md, metrics.json). */
export const JUDGE_EVAL = {
  ref: "wave2/clef-eval, vision/results/clef/RESULTS.md",
  crops: 1856,
  real: 139,
  labellers: "six AI labeller agents working in parallel, not people",
  doubleLabelled: 208,
  kappa: 0.705,
  dev: { crops: 412, real: 25 },
  report: { crops: 1444, real: 114 },
  keep: { kept: 109, real: 61, precision: 0.56, recall: 0.535, rulesPrecision: 0.225, rulesRecall: 0.807 },
  find: { variant: "clef-imgonly-p2", flagged: 36, real: 32, precision: 0.89, devFlagged: 4, devReal: 4, devPrecision: 1, noRuleFlagged: 5, noRuleReal: 5 },
  usdPerMillionInput: 0.24,
  pricingDate: "2026-10-14",
} as const;

/** The label every finding the model made carries, word for word. */
export const JUDGE_LABEL = "Judged from the screenshot by a model (Clef)";

/** A finding of the model's own, in words: the headline by the problem it named, why it matters, what to do. */
export const JUDGE_WHAT: Record<string, string> = {
  unreadable_text: "Text that looks unreadable in the screenshot",
  hidden_control: "A control that looks hidden or covered in the screenshot",
  broken_image: "An image that looks broken in the screenshot",
  cut_off: "Content that looks cut off in the screenshot",
  overlap: "Content that looks overlapped in the screenshot",
  leak: "What looks like template or placeholder text in the screenshot",
  blank: "An area that looks blank in the screenshot",
};
export const JUDGE_WHY =
  "A model looking at a crop of the screenshot judged that a visitor cannot see or use this element as intended. The measured checks could not judge it here (text over an image or a gradient, a control under another element, colours in the dark scheme), so this is a model's judgement, not a measurement: look at the crop before acting on it.";
export const JUDGE_FIX: Record<string, string> = {
  unreadable_text: "Give the text a background it can be read on: a solid or semi-opaque backdrop behind it, a darker overlay on the image, or a colour with at least 4.5:1 contrast against what is behind it (WCAG 1.4.3). Check it in the light and the dark colour scheme.",
  hidden_control: "Make sure nothing covers the control where visitors see it: raise it above the covering layer (z-index), give a decorative layer pointer-events: none, or move it out from under fixed bars.",
  broken_image: "Check the image's URL and file: serve one the browser can decode, give it width and height, and object-fit: cover or contain so it is not stretched.",
  cut_off: "Let the content fit its box: remove the fixed height or overflow: hidden that clips it, let long words wrap (overflow-wrap: anywhere), and give wide elements max-width: 100%.",
  overlap: "Give the overlapping elements room: remove the negative margin or absolute position that puts one over the other, or reserve space for the part that arrives late.",
  leak: "Render a fallback when a value is missing, and replace placeholder copy with the real content.",
  blank: "Check why the area renders empty: a failed data request, a script error, or content that stays hidden.",
  "": "Look at the crop: if a visitor cannot see or use the element, fix its colours, size or layering.",
};
/** The model's answers in words, for "what the model saw". */
export const VERDICT_WORDS: Record<string, string> = {
  fine: "it looks and works as intended",
  unreadable_text: "text a visitor should read is unreadable",
  hidden_control: "a link, button or form field is hidden or covered",
  broken_image: "an image, icon or video is broken, missing or distorted",
  cut_off: "content is cut off or spills out",
  overlap: "content overlaps other content",
  leak: "a template or data leak is visible",
  blank: "a blank area sits where content belongs",
};
export const FAMILY_WORDS: Record<string, string> = {
  text: "text readability",
  dark: "a dark-mode problem",
  overflow: "overflow",
  responsive: "a layout broken at this screen size",
  occlusion: "occlusion",
  media: "media",
  leaks: "a template or data leak",
  blank: "a blank area",
  controls: "a control that does not work",
  other: "another visible problem",
};

/**
 * What the model reads about an element the measured checks abstain on: "facts" (clef-img-p3, as for a measured
 * finding) or "tag" (clef-imgonly-p2: the image, the view and the tag). A measured finding always gets the facts.
 * "tag" since calibration (CALIBRATION.md): the facts of such an element are the measurements the checks could not
 * make (a contrast against a background they could not know), and on the fixture they talked the model out of both
 * deliberate bugs; on the evaluation's crops no rule flagged, image + tag only ranked better on dev and on report.
 */
export const ABSTAIN_TEXT = "tag" as "facts" | "tag";

/** The state text for one judged element: the facts and the caution for a measured finding, ABSTAIN_TEXT otherwise. */
export const judgeText = (finding: boolean, f: JudgeFacts, c: Crop): string => (finding || ABSTAIN_TEXT === "facts" ? stateText(f, c) : tagOnlyText(f, c));

/** Visual kinds that are never sent to the judge: left as the measured checks reported them. */
export const NOT_JUDGED = new Set(["page-overflow-x", "image-broken", "text-template-leak", "layout-shift"]);

// ------------------------------------------------------------------------------------------- the prompt

/** The caution line that won on dev (eval.py GUIDE): the screenshot is the evidence, the facts are hints. */
export const GUIDE =
  "Judge by what the screenshot shows a visitor. The measured facts below come from the browser and often flag harmless things: a transparent layer over a link, a contrast computed against a guessed background, content that scrolls inside a box by design, an element that continues below the fold. Treat them as hints that explain what you see, never as proof that something is broken.";
export const VERDICT_Q = "Can a visitor see and use this element as intended?";
/** The p2 criteria of eval.py: `fine` names deliberate design that is not a bug. */
export const VERDICT_CRITERIA: Record<string, string> = {
  fine: "Yes. It looks and works as its designer intended. Deliberate design is fine: muted or decorative styling, icons without text, images cropped on purpose, carousels and sliders, sticky or fixed headers, menus that scroll inside themselves, parts that are simply below the fold or past the screenshot edge.",
  unreadable_text: "No: text a visitor should read is unreadable, because its colour nearly matches what is behind it, it is invisible, far too small, or garbled.",
  hidden_control: "No: a link, button or form field is hidden or covered by another element so it cannot be used.",
  broken_image: "No: an image, icon or video is broken, missing, empty, visibly distorted or squashed, or shows a placeholder instead of real content.",
  cut_off: "No: content is cut off or spills out: text or controls clipped mid-word, pushed past the screen edge, or the page scrolls sideways because something is too wide for the screen.",
  overlap: "No: content overlaps other content so that one of them is hard to read or use.",
  leak: "No: a template or data leak is visible: placeholder copy such as lorem ipsum or example contact details, raw {{variables}}, code, 'undefined', 'null' or 'NaN'.",
  blank: "No: a blank or empty area sits where content clearly belongs.",
};
export const FAMILY_Q = "If something is wrong with this element, which kind of problem is it?";
export const FAMILY_CRITERIA: Record<string, string> = {
  none: "Nothing is wrong.",
  text: "Text readability: low contrast, invisible, tiny or garbled text.",
  dark: "A dark-mode problem: colours that do not work in the dark colour scheme.",
  overflow: "Overflow: content cut off, spilling out of its box or past the screen edge.",
  responsive: "Layout broken at this screen size: squashed, stacked wrongly, too wide for a phone.",
  occlusion: "Occlusion: covered or overlapped by another element.",
  media: "Media: broken, missing, distorted or placeholder image or video.",
  leaks: "A template or data leak: placeholder or raw template text shown to visitors.",
  blank: "A blank area where content belongs.",
  controls: "A control that does not work: unclickable, disabled by mistake, unreachable.",
  other: "Another visible problem.",
};

const EBS: Record<number, string> = {
  0: "a solid colour",
  1: "no opaque layer (the page canvas colour was assumed)",
  2: "a background image or gradient",
  3: "an image or video behind it",
  4: "a filter or blend mode",
  5: "a colour that did not parse",
  6: "another element painted on top at the text centre",
  7: "not found in the paint stack at its centre",
};
const POS: Record<string, string> = { r: "relative", a: "absolute", f: "fixed", s: "sticky" };
const OVF: Record<string, string> = { h: "hidden", c: "clip", a: "auto (scrolls)", s: "scroll" };
const SRC: Record<string, string> = { same: "same-site URL", cross: "another site's URL", data: "inline data URL", blob: "blob URL", ph: "a placeholder-image service", "": "no usable URL" };
const FIT: Record<string, string> = { c: "contain", v: "cover", n: "none", d: "scale-down" };

/** One element's measured facts: the evaluation's extractor row (vision/src/extract.js), sanitised. */
export type Row = Record<string, unknown>;
export interface JudgeFacts {
  device: "desktop" | "phone";
  scheme: "light" | "dark";
  page: Row;
  el: Row;
  anc: Row | null;
  kids: number;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Python truthiness for the fields eval.py tests with `if e.get(...)`. */
const truthy = (v: unknown): boolean => !(v === undefined || v === null || v === 0 || v === "" || v === false || (Array.isArray(v) && v.length === 0));
/** Python's round(): halves to even, as eval.py rounds (Math.round rounds them up). */
export const pyRound = (x: number): number => (Number.isInteger(x * 2) && !Number.isInteger(x) ? 2 * Math.round(x / 2) : Math.round(x));
/** Python's "%.<d>f": the exact value rounded, an exact half to even (toFixed rounds it away from zero). */
export function pyFixed(v: number, d: number): string {
  const a = Math.abs(v);
  const exact = a.toFixed(Math.min(100, d + 30));
  const dot = exact.indexOf(".");
  let s = a.toFixed(d);
  if (/^50*$/.test(exact.slice(dot + 1 + d))) {
    const down = d ? exact.slice(0, dot + 1 + d) : exact.slice(0, dot);
    if (Number(down.charAt(down.length - 1)) % 2 === 0) s = down;
  }
  return v < 0 && Number(s) !== 0 ? `-${s}` : s;
}
const num = (v: unknown, d = 0): string => (isNum(v) ? pyFixed(v, d) : "?");
const strip = (s: string): string => s.replace(/0+$/, "").replace(/\.$/, "");
const pct = (v: number): number => pyRound(v * 100);
const show = (v: unknown): string => (v === undefined || v === null ? "None" : String(v));
const colour = (c: unknown): string => {
  if (!Array.isArray(c) || c.length < 3 || !c.slice(0, 3).every(isNum)) return "unknown";
  let s = `rgb(${pyRound(c[0])}, ${pyRound(c[1])}, ${pyRound(c[2])})`;
  if (c.length > 3 && isNum(c[3]) && c[3] < 1) s += ` at ${pyRound(c[3] * 100)}% alpha`;
  return s;
};

/** eval.py page_words: the view, the colour scheme, sideways scrolling, failed loads, web fonts. */
export function pageWords(f: JudgeFacts): string {
  const p = f.page;
  const w: string[] = [];
  w.push(`Page: ${f.device === "phone" ? "phone" : "desktop"} view, viewport ${p.vw ?? "?"} x ${p.vh ?? "?"} px, rendered with the ${f.scheme} colour scheme preference.`);
  const cs = truthy(p.colorScheme) ? String(p.colorScheme) : "normal";
  w.push(`The page declares color-scheme '${cs}'${truthy(p.appDark) ? "; it switches to a dark theme of its own" : ""}.`);
  const sw = isNum(p.scrollW) ? p.scrollW : 0;
  const cw = isNum(p.clientW) ? p.clientW : 0;
  w.push(sw > cw + 1 ? `The page is ${sw} px wide in a ${cw} px viewport, so it scrolls sideways by ${sw - cw} px.` : "The page does not scroll sideways.");
  const res = (p.res && typeof p.res === "object" ? p.res : {}) as Record<string, unknown>;
  const fails = ["cssFailed", "imgFailed", "fontFailed", "scriptFailed"].filter((k) => truthy(res[k])).map((k) => `${res[k]} ${k.replace("Failed", "")}`);
  if (fails.length) w.push(`Failed loads on the page: ${fails.join(", ")}.`);
  if (truthy(p.fontsStatus) && p.fontsStatus !== "loaded") w.push(`Web fonts status: ${p.fontsStatus}.`);
  return w.join(" ");
}

/** eval.py element_words: the element's row in plain words, in the same order and wording. */
export function elementWords(f: JudgeFacts): string {
  const e = f.el;
  const w: string[] = [];
  const kind = `<${e.tag}>${truthy(e.role) ? `, role ${e.role}` : ""}`;
  const extra: string[] = [];
  if (truthy(e.disp)) extra.push(`display ${e.disp}`);
  if (truthy(e.pos)) extra.push(`position ${POS[String(e.pos)] ?? e.pos}`);
  w.push(`Element: ${kind}${extra.length ? ` (${extra.join(", ")})` : ""}.`);
  const inter: string[] = [];
  if (truthy(e.ia)) inter.push("interactive");
  if (truthy(e.cur)) inter.push("pointer cursor");
  if (truthy(e.pen)) inter.push("pointer-events none (clicks pass through)");
  if (truthy(e.dis)) inter.push("disabled");
  if (inter.length) w.push(`It is ${inter.join(", ")}.`);
  w.push(`Box: x ${num(e.x)}, y ${num(e.y)}, ${num(e.w)} x ${num(e.h)} px; ${pct(isNum(e.inv) ? e.inv : 0)}% of it is inside the viewport.`);
  if (!truthy(e.vis)) w.push(`The browser reports it as not visible (${truthy(e.why) ? e.why : "reason unknown"}).`);
  if (truthy(e.tl)) {
    let t = `Own text: ${e.tl} characters on ${e.ln ?? "?"} line(s), font ${strip(num(e.fs, 1))} px`;
    if (truthy(e.fw)) t += ` weight ${e.fw}`;
    if (isNum(e.lh) && e.lh > 0) t += `, line height ${strip(num(e.lh, 1))} px`;
    w.push(`${t}.`);
    const flags: string[] = [];
    if (truthy(e.nw)) flags.push("no wrapping");
    if (truthy(e.ell)) flags.push("ellipsis on overflow");
    if (truthy(e.lcl)) flags.push(`clamped to ${e.lcl} line(s)`);
    if (truthy(e.tsh)) flags.push("text shadow");
    if (truthy(e.bclip)) flags.push("background-clip: text");
    if (flags.length) w.push(`Text styling: ${flags.join(", ")}.`);
    if (truthy(e.tspill)) w.push(`The text extends ${num(e.tspill, 1)} px beyond the element's box.`);
  } else if (truthy(e.tt)) w.push(`No text of its own; ${e.tt} characters of text inside it.`);
  else w.push("No text.");
  w.push(`Text colour ${colour(e.c)}.`);
  if (truthy(e.tfc)) w.push(`Text fill colour ${colour(e.tfc)}.`);
  if (truthy(e.bg)) w.push(`Own background colour ${colour(e.bg)}.`);
  if (truthy(e.bgi)) w.push(`It has a background ${({ 1: "image", 2: "gradient", 3: "image and gradient" } as Record<string, string>)[String(e.bgi)] ?? "image"}.`);
  const ebs = isNum(e.ebs) ? e.ebs : 0;
  w.push(`Background behind it along its ancestors: ${colour(e.eb)}, from ${EBS[ebs] ?? "?"} (${ebs === 0 ? "background known" : "background not reliably known"}).`);
  if (isNum(e.cr)) w.push(`Text contrast against that background: ${pyFixed(e.cr, 2)}:1.`);
  if (e.sbs !== undefined && e.sbs !== null) {
    const sbs = Number(e.sbs);
    if (sbs === 6 || sbs === 7) w.push(`At the text centre the browser found ${EBS[sbs]}.`);
    if (truthy(e.sb)) w.push(`Background actually painted under the text centre: ${colour(e.sb)}, from ${EBS[sbs] ?? "?"}.`);
    if (isNum(e.scr)) w.push(`Text contrast against what is painted under it: ${pyFixed(e.scr, 2)}:1.`);
  }
  if ((e.op !== undefined && e.op !== null) || (e.eop !== undefined && e.eop !== null)) w.push(`Opacity: own ${num(e.op ?? 1, 2)}, effective ${num(e.eop ?? 1, 2)}.`);
  if (e.sw !== undefined && e.sw !== null) {
    let o = `Content size ${show(e.sw)} x ${show(e.sh)} px in a ${show(e.cw)} x ${show(e.ch)} px box`;
    if (truthy(e.ox) || truthy(e.oy)) o += `, overflow-x ${OVF[String(e.ox)] ?? "visible"}, overflow-y ${OVF[String(e.oy)] ?? "visible"}`;
    w.push(`${o}.`);
  }
  if (truthy(e.nca)) w.push(`${e.nca} ancestor(s) clip their overflow.`);
  if (isNum(e.cvis)) w.push(`Only ${pct(e.cvis)}% of its box is inside its ancestors' clip area.`);
  if (truthy(e.clip) || truthy(e.cpath)) w.push("It has a CSS clip or clip-path.");
  const fx: string[] = [];
  if (isNum(e.z)) fx.push(`z-index ${e.z}`);
  if (truthy(e.tf)) fx.push("a transform");
  if (truthy(e.flt)) fx.push("a filter or backdrop filter");
  if (truthy(e.an)) fx.push("a running animation");
  if (fx.length) w.push(`It has ${fx.join(", ")}.`);
  if (isNum(e.hs)) {
    const parts = [`${e.hs} on the element itself`];
    if (truthy(e.ho)) parts.push(`${e.ho} on a different element`);
    if (truthy(e.ha)) parts.push(`${e.ha} on an ancestor`);
    if (truthy(e.hn)) parts.push(`${e.hn} outside the viewport`);
    w.push(`Hit test at 5 points of its box: ${parts.join(", ")}.`);
  }
  if (e.tag === "img") {
    let s = `Image: natural size ${e.nw ?? "?"} x ${e.nh ?? "?"} px, ${truthy(e.cmp) ? "load complete" : "still loading"}, ${truthy(e.iok) ? "decoded" : "not decoded (broken or empty)"}, from ${SRC[String(e.src ?? "")] ?? "unknown source"}`;
    if (truthy(e.of)) s += `, object-fit ${FIT[String(e.of)] ?? e.of}`;
    if (truthy(e.lazy)) s += ", lazy-loaded";
    w.push(`${s}.`);
    const alt = isNum(e.alt) ? e.alt : -1;
    w.push(`Alt text: ${alt === -1 ? "none" : alt === 0 ? "empty" : `${alt} characters`}.`);
    if (isNum(e.dist)) w.push(`Aspect ratio differs from the image's natural ratio by ${pct(e.dist)}%.`);
  } else if (e.tag === "video") w.push(`Video: readyState ${e.rs ?? "?"}${truthy(e.verr) ? `, media error ${e.verr}` : ""}.`);
  else if (e.tag === "svg") w.push(`SVG: ${truthy(e.vb) ? "has a" : "no"} viewBox, ${truthy(e.wa) ? "has a" : "no"} width attribute.`);
  if (truthy(e.bsrc)) w.push(`Background image from ${SRC[String(e.bsrc)] ?? "unknown source"}.`);
  if (Array.isArray(e.lk) && e.lk.length) w.push(`Text matching leak patterns: ${(e.lk as string[][]).map(([k, m]) => `${k} ('${m}')`).join("; ")}.`);
  if (truthy(e.vu) || truthy(e.vi))
    w.push(`CSS variables: ${isNum(e.vu) ? e.vu : 0} declaration(s) with an undefined var(), ${isNum(e.vi) ? e.vi : 0} with an invalid colour after substitution (${(Array.isArray(e.vp) ? e.vp : []).join(", ")}).`);
  const p = f.anc;
  if (p) {
    let s = `Parent: <${p.tag}>, ${num(p.w)} x ${num(p.h)} px`;
    if (p.sw !== undefined && p.sw !== null) {
      s += `, content ${show(p.sw)} x ${show(p.sh)} px in a ${show(p.cw)} x ${show(p.ch)} px box`;
      if (truthy(p.ox) || truthy(p.oy)) s += ` (overflow-x ${OVF[String(p.ox)] ?? "visible"}, overflow-y ${OVF[String(p.oy)] ?? "visible"})`;
    }
    w.push(`${s}.`);
  }
  w.push(`Child elements: ${f.kids}.`);
  return w.join(" ");
}

/** A crop: where it was cut (CSS px of the page), its size, and the element's box inside it. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The element's box inside the crop [x, y, w, h] (it may continue past the crop's edges). */
  inCrop: [number, number, number, number];
}

/**
 * The crop of a box (viewport coordinates) with CROP_PAD px of context, clamped to the viewport (vision/src/
 * candidates.mjs cropRect); null when under 4 by 4 px. `sx`, `sy` are the scroll offsets: the crop's x and y are in
 * page coordinates, as Page.captureScreenshot takes a clip.
 */
export function cropOf(box: { x: number; y: number; w: number; h: number }, vw: number, vh: number, sx = 0, sy = 0): Crop | null {
  const x0 = Math.max(0, Math.floor(box.x - CROP_PAD));
  const y0 = Math.max(0, Math.floor(box.y - CROP_PAD));
  const x1 = Math.min(vw, Math.ceil(box.x + box.w + CROP_PAD));
  const y1 = Math.min(vh, Math.ceil(box.y + box.h + CROP_PAD));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { x: x0 + sx, y: y0 + sy, w: x1 - x0, h: y1 - y0, inCrop: [r1(box.x - x0), r1(box.y - y0), box.w, box.h] };
}

/** eval.py image_words: the crop's size and where the element is in it. */
export function imageWords(c: Crop): string {
  const [x, y, w, h] = c.inCrop;
  return `The image is a screenshot of the area around the element, ${c.w} x ${c.h} px; the element's box is at x ${num(x)}, y ${num(y)}, ${num(w)} x ${num(h)} px inside it (a box larger than the image continues past its edges).`;
}

/** The state text of one call: the caution, the image, the page and the element (eval.py build_request, clef-img-p3). */
export function stateText(f: JudgeFacts, c: Crop): string {
  return [GUIDE, imageWords(c), pageWords(f), elementWords(f)].join("\n");
}

/**
 * The evaluation's image + tag only text (eval.py build_request, clef-imgonly-p2): where the element is in the image,
 * the view and colour scheme, the tag and role; no facts, no caution line.
 */
export function tagOnlyText(f: JudgeFacts, c: Crop): string {
  const e = f.el;
  return [imageWords(c), `Page: ${f.device} view, ${f.scheme} colour scheme.`, `Element: <${e.tag}>${truthy(e.role) ? `, role ${e.role}` : ""}.`].join("\n");
}

/** The Workers AI input for one element (the Clef schema: model, state, questions, images). */
export function judgeInput(state: string, imageBase64: string): Record<string, unknown> {
  return {
    model: "clef",
    state,
    questions: {
      verdict: { type: "choice", instructions: VERDICT_Q, criteria: VERDICT_CRITERIA },
      family: { type: "choice", instructions: FAMILY_Q, criteria: FAMILY_CRITERIA },
    },
    images: [{ content_type: "image/jpeg", base64: imageBase64 }],
  };
}

// ------------------------------------------------------------------------------------------- answers

export interface JudgeAnswer {
  /** 1 - P(family = none): the evaluation's score. */
  score: number;
  /** The verdict option with the most probability other than `fine`, and its probability; `fine` and its own. */
  verdict: string;
  verdictP: number;
  fineP: number;
  /** The family with the most probability other than `none`, and its probability; P(none). */
  family: string;
  familyP: number;
  noneP: number;
  tokens: number | null;
}

const probs = (v: unknown, keys: Record<string, string>): Record<string, number> | null => {
  if (!v || typeof v !== "object") return null;
  const p = (v as { probabilities?: unknown }).probabilities;
  if (!p || typeof p !== "object") return null;
  const out: Record<string, number> = {};
  for (const k of Object.keys(keys)) {
    const x = (p as Record<string, unknown>)[k];
    if (x === undefined) continue;
    if (!isNum(x) || x < 0 || x > 1) return null;
    out[k] = x;
  }
  return Object.keys(out).length ? out : null;
};
const top = (p: Record<string, number>, skip: string): [string, number] => {
  let best: [string, number] = ["", -1];
  for (const [k, v] of Object.entries(p)) if (k !== skip && v > best[1]) best = [k, v];
  return best[1] < 0 ? ["", 0] : best;
};

/** Clef's answer read back: only the options the questions offer, probabilities in [0, 1]; null when malformed. */
export function parseAnswer(out: unknown): JudgeAnswer | null {
  if (!out || typeof out !== "object") return null;
  const a = (out as { answers?: unknown }).answers;
  if (!a || typeof a !== "object") return null;
  const fam = probs((a as Record<string, unknown>).family, FAMILY_CRITERIA);
  const ver = probs((a as Record<string, unknown>).verdict, VERDICT_CRITERIA);
  if (!fam || !ver || fam.none === undefined) return null;
  const [family, familyP] = top(fam, "none");
  const [verdict, verdictP] = top(ver, "fine");
  const usage = (out as { usage?: { input_tokens?: unknown } }).usage;
  const round4 = (x: number) => Math.round(x * 10000) / 10000;
  return {
    score: round4(1 - fam.none),
    verdict,
    verdictP: round4(verdictP),
    fineP: round4(ver.fine ?? 0),
    family,
    familyP: round4(familyP),
    noneP: round4(fam.none),
    tokens: isNum(usage?.input_tokens) ? Math.round(usage.input_tokens) : null,
  };
}

// ------------------------------------------------------------------------------------------- sanitising facts

const ROW_NUMS = ["x", "y", "w", "h", "inv", "vis", "sr", "ia", "cur", "pen", "dis", "foc", "tl", "tt", "fs", "fw", "lh", "tsh", "nw", "ell", "lcl", "bgi", "bclip", "ebs", "eop", "op", "cr", "sbs", "scr", "ln", "tspill", "sw", "sh", "cw", "ch", "nca", "cvis", "cpath", "clip", "z", "tf", "flt", "an", "nh", "cmp", "iok", "lazy", "alt", "dist", "rs", "verr", "vb", "wa", "hs", "ho", "ha", "hn", "vu", "vi"];
const ROW_CODES: Record<string, RegExp> = { pos: /^[rafs]$/, ox: /^[hcas]$/, oy: /^[hcas]$/, of: /^[cvnd]$/, src: /^(same|cross|data|blob|ph|unsplash|)$/, bsrc: /^(same|cross|data|blob|ph|unsplash|)$/, why: /^[a-z-]{1,16}$/, disp: /^[a-z-]{1,16}$/ };
const WORD = /^[a-z][a-z0-9-]{0,23}$/;
const rgbArr = (v: unknown): number[] | null => (Array.isArray(v) && (v.length === 3 || v.length === 4) && v.every(isNum) ? v.map((x) => Math.round(x * 100) / 100) : null);

/** One row from the page, with only the fields and shapes the prompt uses. */
export function sanitizeRow(v: unknown): Row | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const tag = typeof o.tag === "string" && WORD.test(o.tag) ? o.tag : null;
  if (!tag) return null;
  const r: Row = { tag };
  if (typeof o.role === "string" && WORD.test(o.role)) r.role = o.role;
  for (const k of ROW_NUMS) if (isNum(o[k])) r[k] = o[k];
  if (isNum(o.nw)) r.nw = o.nw;
  for (const [k, re] of Object.entries(ROW_CODES)) if (typeof o[k] === "string" && re.test(o[k] as string)) r[k] = o[k];
  for (const k of ["c", "bg", "tfc", "eb", "sb"]) {
    const c = rgbArr(o[k]);
    if (c) r[k] = c;
  }
  if (Array.isArray(o.lk))
    r.lk = o.lk
      .filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string" && /^[a-z:-]{1,32}$/.test(x[0]))
      .slice(0, 4)
      .map(([k, m]) => [k, m.replace(/[\u0000-\u001f\u007f\u2028\u2029']/g, " ").slice(0, 24)]);
  if (Array.isArray(o.vp)) r.vp = o.vp.filter((x): x is string => typeof x === "string" && /^[a-z-]{1,32}$/.test(x)).slice(0, 3);
  return r;
}

/** The page facts from the page, with only the fields page_words uses. */
export function sanitizePage(v: unknown): Row {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const r: Row = {};
  for (const k of ["vw", "vh", "scrollW", "clientW", "appDark"]) if (isNum(o[k])) r[k] = Math.round(o[k] as number);
  if (typeof o.colorScheme === "string" && /^[a-z ]{1,40}$/.test(o.colorScheme)) r.colorScheme = o.colorScheme;
  if (typeof o.fontsStatus === "string" && /^[a-z]{1,16}$/.test(o.fontsStatus)) r.fontsStatus = o.fontsStatus;
  const res = o.res && typeof o.res === "object" ? (o.res as Record<string, unknown>) : {};
  r.res = Object.fromEntries(["cssFailed", "imgFailed", "fontFailed", "scriptFailed"].map((k) => [k, isNum(res[k]) ? Math.max(0, Math.round(res[k] as number)) : 0]));
  return r;
}

// ------------------------------------------------------------------------------------------- the calls

/** What the scan hands the judge: Workers AI's run for the model (env.AI.run(JUDGE_MODEL, input)). */
export interface JudgeClient {
  ask(input: Record<string, unknown>): Promise<unknown>;
}

/** How a candidate came to be judged: a measured finding, or an element the measured checks abstain on. */
export type CandidateClass = "finding" | "covered" | "clipped" | "dark-control" | "text-bg";

/** One judged element in one view: what was asked about, what the model said, and the crop it saw. */
export interface JudgeResult {
  /** An id for the crop image within the scan: "<view>-j<n>". */
  id: string;
  view: string;
  cls: CandidateClass;
  /** For a measured finding: its identity in the view (visualKey) and kind. */
  key: string;
  kind: string;
  selector: string;
  /** The element's box in document coordinates (CSS px), as the scan found it at the top of the page. */
  box: { x: number; y: number; w: number; h: number };
  crop: Crop;
  /** The state text the model read (the facts in words). */
  state?: string;
  /** The crop the model saw, base64 JPEG; kept in memory until the report is saved, never in the report. */
  image: string;
  answer: JudgeAnswer | null;
  /** Why there is no answer: "timeout", "unavailable" (the call threw) or "malformed". */
  error: string | null;
  ms: number;
}

/**
 * The scan's calls, shared by the three views (they run in parallel). Each view takes once. Its JUDGE_SHARE is
 * guaranteed: a view may also take what the views that took before it left, but never the share of a view that has not
 * taken yet, and never more than the total.
 */
export class JudgeBudget {
  left: number;
  private taken = new Set<string>();
  constructor(total = JUDGE_MAX_CALLS) {
    this.left = total;
  }
  /** Takes up to `want` calls for `view`; returns how many. A second take for the same view gets nothing. */
  take(view: string, want: number): number {
    if (this.taken.has(view)) return 0;
    this.taken.add(view);
    const reserved = Object.keys(JUDGE_SHARE).filter((v) => !this.taken.has(v)).reduce((s, v) => s + JUDGE_SHARE[v], 0);
    const n = Math.max(0, Math.min(Math.floor(want), this.left - reserved));
    this.left -= n;
    return n;
  }
}

/**
 * Sends one call and records its answer, or why there is none; never throws. The timeout starts when the call is
 * sent; a late answer is ignored.
 */
export async function askJudge(client: JudgeClient, input: Record<string, unknown>, timeoutMs: number, now: () => number): Promise<{ answer: JudgeAnswer | null; error: string | null; ms: number }> {
  const t0 = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      Promise.resolve().then(() => client.ask(input)),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (out === "timeout") return { answer: null, error: "timeout", ms: now() - t0 };
    const answer = parseAnswer(out);
    return { answer, error: answer ? null : "malformed", ms: now() - t0 };
  } catch {
    return { answer: null, error: "unavailable", ms: now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Base64 of bytes (a crop's JPEG), in chunks. */
export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Workers AI's price for one scan's calls, in USD, from the tokens the answers report. */
export const judgeCost = (tokens: number): number => (tokens * JUDGE_EVAL.usdPerMillionInput) / 1_000_000;
