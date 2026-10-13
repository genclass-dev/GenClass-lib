// Text patterns for text-template-leak, text-placeholder and text-encoding (docs/runtime/VISUAL.md 3.9 to 3.11).
// Pure: a string in, the patterns it shows out. Case-sensitive unless noted; each pattern has a stable id that
// reports and tests use.

import type { CheckKind } from "../types.js";

export interface TextPattern {
  id: string;
  kind: Extract<CheckKind, "text-template-leak" | "text-placeholder" | "text-encoding">;
  re: RegExp;
  /** What the developer sees in the report. */
  label: string;
}

export const TEXT_PATTERNS: TextPattern[] = [
  { id: "object-object", kind: "text-template-leak", re: /\[object Object\]/, label: "[object Object]" },
  { id: "invalid-date", kind: "text-template-leak", re: /\bInvalid Date\b/, label: "Invalid Date" },
  { id: "mustache", kind: "text-template-leak", re: /\{\{\s*[\w.$[\]]+\s*\}\}/, label: "an unrendered {{ }} placeholder" },
  { id: "template-literal", kind: "text-template-leak", re: /\$\{\s*[\w.]+\s*\}/, label: "an unrendered ${ } placeholder" },
  { id: "jinja", kind: "text-template-leak", re: /\{%\s*\w+[^%]*%\}/, label: "an unrendered {% %} tag" },
  { id: "erb", kind: "text-template-leak", re: /<%=?\s*[\w.]+\s*%>/, label: "an unrendered <% %> tag" },
  { id: "currency-nan", kind: "text-template-leak", re: /[$€£¥]\s?(?:NaN|undefined|null)\b|\b(?:NaN|undefined|null)\s?(?:%|px|USD|EUR)(?![\w])/, label: "a price or unit showing NaN, undefined or null" },
  { id: "nan-time", kind: "text-template-leak", re: /\bNaN:NaN\b/, label: "a time showing NaN:NaN" },
  { id: "lorem", kind: "text-placeholder", re: /\blorem ipsum\b|\bdolor sit amet\b/i, label: "placeholder text (lorem ipsum)" },
  {
    id: "mojibake",
    kind: "text-encoding",
    re: /\u00e2\u20ac[\u2122\u0153\u201c\u201d\u02dc\u00a6\u2013\u2014]|\u00c3[\u00a9\u00a8\u00a2\u00a4\u00b6\u00bc\u00bd\u00a1]|\u00c2[\u00a9\u00ae\u00b0]/,
    label: "UTF-8 text decoded as Windows-1252 (mojibake)",
  },
  { id: "replacement-char", kind: "text-encoding", re: /\ufffd/, label: "the replacement character U+FFFD" },
  { id: "double-escaped", kind: "text-encoding", re: /&(?:amp|lt|gt|quot|#39|#x27|nbsp);/, label: "an HTML entity shown literally (escaped twice)" },
];

/** A text node that is exactly one of these is the weak tier: counted, never reported. */
export const WEAK_VALUES = new Set(["undefined", "null", "NaN"]);

/** Image hosts that only serve placeholder images. */
export const PLACEHOLDER_HOSTS = ["placehold.co", "via.placeholder.com", "placeholder.com", "dummyimage.com", "picsum.photos", "placekitten.com"];

/** The patterns `text` shows, with the index of the first match. */
export function scanText(text: string): { p: TextPattern; index: number }[] {
  const out: { p: TextPattern; index: number }[] = [];
  if (!text || text.length < 3) return out;
  for (const p of TEXT_PATTERNS) {
    const m = p.re.exec(text);
    if (m) out.push({ p, index: m.index });
  }
  return out;
}

/** Up to `n` characters on each side of a match, whitespace collapsed. */
export function excerpt(text: string, index: number, n = 20): string {
  const s = Math.max(0, index - n);
  return `${s > 0 ? "..." : ""}${text.slice(s, index + n + 10).replace(/\s+/g, " ").trim()}${index + n + 10 < text.length ? "..." : ""}`;
}

/** The placeholder host an image URL is on, or null. */
export function placeholderHost(url: string, ignore: string[] = []): string | null {
  let host = "";
  try {
    host = new URL(url, "http://x.invalid/").hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const h of PLACEHOLDER_HOSTS) if ((host === h || host.endsWith(`.${h}`)) && !ignore.includes(h)) return h;
  return null;
}
