// Page-level configuration for the zero-code entries: `import "@genclass/runtime/auto"` and the CDN script tag
// (dist/genclass.global.js). Owner: INSTALL.
//
// Sources, lowest precedence first (the URL kill switch `?genclass=off|observe|guard|heal` and
// `localStorage.genclass` still beat everything, inside GenClass.init):
//   <meta name="genclass" content="mode=observe, devtools=local">
//   <script src=".../genclass.global.min.js" data-mode="observe" data-devtools></script>   (script tag only)
//   window.GENCLASS_CONFIG = { mode: "observe", devtools: true, policy: { deny: ["delay"] } }  (any InitOptions)
//
// Keys of the meta tag and data attributes: mode, model (a model directory URL, or "off"), device, preload, ort
// (onnxruntime-web wasm directory), worker, report, debug, triage, detect (likely: no possible detections and no
// deferred situations in observe; possible), devtools (bare / true, "local" = only on
// localhost, false, or a corner such as "bottom-left"), telemetry (off/false/no: no anonymous diagnostics), autostate
// (off/false/no: no automatic state discovery; on by default in these entries), token (the app's dashboard token,
// gc_...), scope (app or functions), sink (sinks by name: console-json, webhook:<url>; "console-json+webhook:/g" in
// the meta tag since commas separate its keys, data-sink="console-json,webhook:/g" on the tag; src/cdn/sinks.ts, which
// warns once about the names sentry, posthog and datadog: forwarding to those tools is not in the free runtime),
// visual (measured visual checks: on, off, local, or fix = on with runtime fixes, which still need guard or heal mode),
// analytics (interaction analytics: on or off; off by default, and they need telemetry and the app's token).
//
// Trust: only `<meta name="genclass">` tags inside <head> are read (first to last), so markup injected into the body
// (user content, a CMS field) cannot configure GenClass. A meta tag may set the mode, but the model, onnxruntime-web
// and webhook sink URLs it names must be same-origin, resolved as the browser resolves them (against the page and
// document.baseURI, by the WHATWG parser: `/\host` is another host): a cross-origin model, ORT or
// `sink=webhook:<url>` URL is ignored with one warning. Cross-origin URLs (a CDN or a collector of your own) go
// in the script tag's data-* attributes, window.GENCLASS_CONFIG or GenClass.init(options). The URL switch
// (`?genclass=guard`) can no longer raise the mode of a production site (index.ts).
//
// Remote code: an `integrity` attribute on the script tag covers that one file only. What it loads later at runtime
// (dist/cdn/worker.js, dist/cdn/ort-*.js, dist/devtools/index.js, dist/sinks/<name>.js for a named sink,
// onnxruntime-web's wasm and the model files) is fetched by URL without SRI (dynamic import() and module workers take
// no integrity option). On jsDelivr/unpkg those URLs are pinned to the tag's own version (immutable there), so pin the
// tag's version (`@genclass/runtime@x.y.z`, as `init` writes it), never @latest, in production. For full control,
// self-host: `data-base` (this package's dist/), `data-ort` (onnxruntime-web's dist/) and `data-model` (a model
// directory), plus a CSP `script-src` / `worker-src` / `connect-src` limited to those origins.

import type { DevtoolsOptions, DevtoolsPosition } from "../devtools/index.js";
import type { InitOptions, Mode, ModelOptions, Sink } from "../types.js";
import { parseSinkList, webhookUrl } from "./sinks.js";

/** true, "local" (localhost, 127.0.0.1, [::1], *.localhost, *.local, *.test, file:), false, or overlay options. */
export type DevtoolsSetting = boolean | "local" | DevtoolsOptions;

export interface PageConfig extends Omit<InitOptions, "sinks"> {
  /** Mount the devtools overlay (loaded on demand). Default: not mounted. */
  devtools?: DevtoolsSetting;
  /** Sinks, or their names: "console-json", "webhook:<url>" (src/cdn/sinks.ts). */
  sinks?: (Sink | string)[];
}

const MODES: readonly string[] = ["observe", "guard", "heal"];
const POSITIONS: readonly string[] = ["bottom-right", "bottom-left", "top-right", "top-left"];

const isOff = (v: string) => v === "false" || v === "0" || v === "off" || v === "no" || v === "none";
const isOn = (v: string) => v === "" || v === "true" || v === "1" || v === "on" || v === "yes";
const normKey = (k: string) => k.trim().toLowerCase().replace(/[-_\s]/g, "");

/** `"mode=observe, devtools; model=off"` -> `{ mode: "observe", devtools: "", model: "off" }` (keys normalised). */
export function parsePairs(s: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(s ?? "").split(/[,;\s]+/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = normKey(eq < 0 ? part : part.slice(0, eq));
    if (k) out[k] = eq < 0 ? "" : part.slice(eq + 1).trim();
  }
  return out;
}

function parseDevtools(v: string): DevtoolsSetting {
  if (isOff(v)) return false;
  if (v === "local" || v === "dev" || v === "localhost") return "local";
  if (POSITIONS.includes(v)) return { position: v as DevtoolsPosition };
  return true;
}

/** Turns normalised key/value pairs (meta content, script data attributes) into options. Unknown keys are ignored. */
export function fromPairs(pairs: Record<string, string>): PageConfig {
  const c: PageConfig = {};
  const model: ModelOptions = {};
  let modelOff = false;
  for (const [k, raw] of Object.entries(pairs)) {
    const v = String(raw ?? "").trim();
    const lv = v.toLowerCase();
    switch (k) {
      case "mode":
        if (MODES.includes(lv)) c.mode = lv as Mode;
        break;
      case "model":
        if (isOff(lv)) modelOff = true;
        else if (!isOn(lv)) model.baseUrl = v;
        break;
      case "modelurl":
      case "baseurl":
        if (v) model.baseUrl = v;
        break;
      case "device":
        if (lv === "auto" || lv === "webgpu" || lv === "wasm") model.device = lv;
        break;
      case "preload":
        if (lv === "eager" || lv === "idle" || lv === "lazy") model.preload = lv;
        break;
      case "ort":
      case "ortwasmpaths":
        if (v) model.ortWasmPaths = v;
        break;
      case "worker":
        model.worker = !isOff(lv);
        break;
      case "report":
        if (lv === "console" || lv === "silent") c.report = lv;
        break;
      case "debug":
        c.debug = !isOff(lv);
        break;
      case "triage":
        if (lv === "salient" || lv === "always") c.triage = lv;
        break;
      case "detect":
        if (lv === "likely" || lv === "possible") c.detect = lv;
        break;
      case "devtools":
        c.devtools = parseDevtools(lv);
        break;
      case "autostate":
      case "state":
        // automatic state discovery (on by default in the zero-code entries): only an opt-out here
        if (isOff(lv)) c.autoState = false;
        break;
      case "token":
        // the app's dashboard token (validated with a console warning by createRuntime)
        if (v) c.token = v;
        break;
      case "scope":
        if (lv === "app" || lv === "functions") c.scope = lv;
        break;
      case "telemetry":
        // anonymous diagnostics (TELEMETRY.md): only an opt-out here; on is the GenClass.init default
        if (isOff(lv)) c.telemetry = false;
        break;
      case "sink":
      case "sinks":
        // sinks by name, resolved by the entry (cdn/sinks.ts → applySinks); "off" clears what an earlier source set
        if (isOff(lv)) c.sinks = [];
        else if (v) c.sinks = parseSinkList(v);
        break;
      case "analytics":
        // interaction analytics (docs/runtime/ANALYTICS.md): off by default; they need telemetry and the app's token
        c.analytics = !isOff(lv);
        break;
      case "visual":
        // measured visual checks (docs/runtime/VISUAL.md): "local" is the GenClass.init default
        c.visual = isOff(lv) ? false : lv === "local" ? "local" : lv === "fix" ? { on: true, fix: true } : true;
        break;
    }
  }
  if (modelOff) c.model = false;
  else if (Object.keys(model).length) c.model = model;
  return c;
}

/** Shallow merge, later wins; two `model` objects are merged, `model: false` replaces. */
export function mergeConfig(...configs: (PageConfig | null | undefined)[]): PageConfig {
  const out: Record<string, unknown> = {};
  for (const c of configs) {
    if (!c || typeof c !== "object") continue;
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined) continue;
      const prev = out[k];
      out[k] = k === "model" && v && typeof v === "object" && prev && typeof prev === "object" ? { ...prev, ...v } : v;
    }
  }
  return out as PageConfig;
}

interface MetaRoot {
  querySelectorAll?(sel: string): ArrayLike<{ getAttribute(name: string): string | null }>;
}
interface DocLike extends MetaRoot {
  /** Only meta tags under <head> are read; a document-like object without `head` is searched whole (tests). */
  head?: MetaRoot | null;
  /** document.baseURI: a URL a meta tag names must stay same-origin against it too (sameOriginUrl). */
  baseURI?: string;
}

/**
 * Whether `url` (as written in a meta tag) resolves to the page's own origin, resolved as the browser resolves it:
 * against `baseURI` (document.baseURI, which fetch and sendBeacon use, so an injected `<base href>` counts) and against
 * the page location, both of which must stay on the page's origin. The WHATWG parser decides, so a backslash
 * (`/\host/x`) or a tab inside `//host` is another host, not a path. Without a page location only a path counts.
 */
export function sameOriginUrl(url: string, loc: { href?: string; origin?: string } | null | undefined, baseURI?: string | null): boolean {
  const v = url.trim();
  if (!v) return true;
  try {
    const href = loc?.href;
    const origin = loc?.origin ?? (href ? new URL(href).origin : undefined);
    if (!origin) return new URL(v, "http://genclass.invalid/").origin === "http://genclass.invalid";
    for (const b of [baseURI, href ?? `${origin}/`]) if (b && new URL(v, b).origin !== origin) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * `<meta name="genclass" content="...">` tags under <head>, in document order. Model, onnxruntime-web and webhook sink
 * URLs that are not same-origin are dropped (`warn` is told once).
 */
export function readMetaConfig(
  doc: DocLike | null | undefined,
  o: { location?: { href?: string; origin?: string } | null; warn?: (msg: string) => void } = {},
): PageConfig {
  let c: PageConfig = {};
  try {
    const root: MetaRoot | null | undefined = doc && "head" in doc ? doc.head : doc;
    const metas = root?.querySelectorAll?.('meta[name="genclass"]');
    for (let i = 0; metas && i < metas.length; i++) c = mergeConfig(c, fromPairs(parsePairs(metas[i].getAttribute("content"))));
    const dropped: string[] = [];
    const same = (u: string) => sameOriginUrl(u, o.location, doc?.baseURI);
    const m = c.model;
    if (m && typeof m === "object") {
      if (typeof m.baseUrl === "string" && !same(m.baseUrl)) {
        dropped.push(`model=${m.baseUrl}`);
        delete m.baseUrl;
      }
      if (typeof m.ortWasmPaths === "string" && !same(m.ortWasmPaths)) {
        dropped.push(`ort=${m.ortWasmPaths}`);
        delete m.ortWasmPaths;
      }
      if (dropped.length && !Object.keys(m).length) delete c.model;
    }
    // a webhook sink would send the records to its URL: same-origin only from a meta tag, like the model
    if (c.sinks)
      c.sinks = c.sinks.filter((s) => {
        const u = typeof s === "string" ? webhookUrl(s) : undefined;
        if (!u || same(u)) return true;
        dropped.push(`sink=${s}`);
        return false;
      });
    if (dropped.length) {
      o.warn?.(
        `[GenClass] Ignored cross-origin ${dropped.join(", ")} in <meta name="genclass">; use data-model/data-ort/data-sink, GENCLASS_CONFIG or GenClass.init().`,
      );
    }
  } catch {
    /* never break the page over configuration */
  }
  return c;
}

/** `window.GENCLASS_CONFIG` (any InitOptions plus `devtools`). */
export function readWindowConfig(win: unknown): PageConfig {
  try {
    const c = (win as { GENCLASS_CONFIG?: unknown } | null | undefined)?.GENCLASS_CONFIG;
    return c && typeof c === "object" ? ({ ...(c as PageConfig) } as PageConfig) : {};
  } catch {
    return {};
  }
}

/** A script tag's dataset (`data-mode`, `data-devtools`, ...); `data-manual` and `data-base` are not options. */
export function fromDataset(ds: Record<string, string | undefined> | null | undefined): PageConfig {
  const pairs: Record<string, string> = {};
  for (const [k, v] of Object.entries(ds ?? {})) {
    const nk = normKey(k);
    if (nk === "manual" || nk === "base") continue;
    pairs[nk] = v ?? "";
  }
  return fromPairs(pairs);
}

interface LocLike {
  protocol?: string;
  hostname?: string;
  search?: string;
}

/** Development hosts: loopback, *.localhost, *.local, *.test, file:. */
export function isLocalHost(loc: LocLike | null | undefined): boolean {
  if (!loc) return false;
  if (loc.protocol === "file:") return true;
  const h = String(loc.hostname ?? "").toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(h) ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".test")
  );
}

/** `?genclass=off` or `localStorage.genclass = "off"` (GenClass.init installs nothing then; neither do we). */
export function isKilled(g: { location?: LocLike; localStorage?: { getItem(k: string): string | null } } | null | undefined): boolean {
  let v: string | null = null;
  try {
    if (g?.location?.search) v = new URLSearchParams(g.location.search).get("genclass");
  } catch {
    /* ignore */
  }
  if (!v) {
    try {
      v = g?.localStorage?.getItem("genclass") ?? null;
    } catch {
      /* ignore */
    }
  }
  return !!v && v.trim().toLowerCase() === "off";
}

/** Overlay options when the setting asks for the overlay on this page, else null. */
export function devtoolsOptions(s: DevtoolsSetting | undefined, loc: LocLike | null | undefined): DevtoolsOptions | null {
  if (!s) return null;
  if (s === "local") return isLocalHost(loc) ? {} : null;
  if (s === true) return {};
  return typeof s === "object" ? s : null;
}

/** InitOptions without `devtools` and `sinks`, plus those two (sinks still by name: `applySinks` in cdn/sinks.ts resolves them). */
export function splitConfig(c: PageConfig): { init: InitOptions; devtools: DevtoolsSetting | undefined; sinks: (Sink | string)[] | undefined } {
  const { devtools, sinks, ...init } = c;
  return { init, devtools, sinks };
}

/** Runs fn once document.body exists. */
export function whenBody(doc: Document, fn: () => void): void {
  if (doc.body) fn();
  else doc.addEventListener("DOMContentLoaded", () => fn(), { once: true });
}
