// genclass.dev/<url>: which paths are a page-check request (genclass.dev/example.com, genclass.dev/https://example.com/pricing).
// Narrow on purpose. worker.js asks only after the static assets answered 404 (so every page and asset keeps priority),
// and only for GET and HEAD. The path may hold URL-safe characters only and must start with http: or https:, or be a
// hostname with an IANA top-level domain, then an optional path. The scan worker normalises and checks it again.
import { TLDS } from "./tlds.js";

const URL_SAFE = /^[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/;
// "app.js.map", "x.css.map": a file name whose last part happens to be a TLD is not a hostname
const FILE_PARTS = new Set(["js", "mjs", "css", "html", "htm", "json", "png", "jpg", "jpeg", "gif", "svg", "ico", "txt", "xml", "webp", "avif", "woff", "woff2", "ttf", "wasm", "onnx", "pdf", "gz"]);

function isHostname(raw) {
  const h = raw.toLowerCase().replace(/\.$/, "");
  if (!h || h.length > 253) return false;
  const labels = h.split(".");
  if (labels.length < 2) return false;
  for (const l of labels) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return false;
  if (!TLDS.has(labels[labels.length - 1])) return false;
  if (labels.length >= 3 && FILE_PARTS.has(labels[labels.length - 2])) return false;
  return true;
}

/** The address to scan for a request path (and query), or null when the path is not a page-check request. */
export function scanTargetFromPath(pathname, search = "") {
  if (typeof pathname !== "string" || pathname.length < 2 || pathname.length > 2048) return null;
  let p;
  try {
    p = decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
  const q = typeof search === "string" ? search : "";
  if (!URL_SAFE.test(p + q)) return null;
  const scheme = /^(https?):\/*/i.exec(p);
  if (scheme) {
    const rest = p.slice(scheme[0].length);
    return isHostname(rest.split(/[/?#]/)[0]) ? `${scheme[1].toLowerCase()}://${rest}${q}` : null;
  }
  return isHostname(p.split(/[/?#]/)[0]) ? `${p}${q}` : null;
}
