// Put @genclass/runtime on a page the harness does not own, and connect it to the bridge, without changing a line of
// the app: the built dist/ is served under a virtual same-origin path (`/__genclass__/`, through page routing), the
// HTML document gets the script tag first in <head> (the place the README asks for, so the runtime sees the page's
// first requests and the React discovery hook is installed before react-dom), and an init script carries the page
// configuration (observe, telemetry off, visual checks off, the model skipped unless asked) and connects the agent link
// (dist/agent.js, imported from the virtual path) as soon as the runtime exists. When the document could not be
// rewritten (not HTML through the route, or --no-rewrite), the init script inserts the runtime inline as soon as the
// document has an element to hold it: that is still before the page's external scripts, but after inline scripts that
// come first in <head>.
//
// What this changes on the page, for the record: the script tag and a `window.__GENCLASS_HUNT__` object (the
// injection's own log), the globals the runtime and its agent link define themselves, service workers blocked and
// CSP bypassed by the browser context (hunt.mjs). Nothing is sent anywhere but the loopback bridge.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

export const VIRTUAL = "/__genclass__/";
const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".txt": "text/plain",
  ".ts": "text/plain",
};
const MARK = "data-genclass-hunt";

/**
 * The page configuration the init script sets as `window.GENCLASS_CONFIG` (InitOptions): observe, no telemetry, no
 * visual checks, the model off unless asked. `extra` goes over it (a scenario may need `requests` options).
 */
export function pageConfig(o = {}) {
  const c = { mode: "observe", telemetry: false, visual: false, analytics: false, report: "console" };
  if (o.modelDir) c.model = { baseUrl: `${VIRTUAL}model/`, ...(existsSync(resolve(o.modelDir, "ort")) ? { ortWasmPaths: `${VIRTUAL}model/ort/` } : {}), device: "wasm" };
  else if (!o.model) c.model = false;
  return { ...c, ...(o.extra ?? {}) };
}

/** The two tags the document rewrite inserts first in <head>: the runtime, then the call that connects the agent. */
export function tags() {
  return `<script src="${VIRTUAL}genclass.global.js" data-base="${VIRTUAL}" ${MARK}="tag"></script><script ${MARK}="connect">window.__GENCLASS_HUNT__&&window.__GENCLASS_HUNT__.connect("tag")</script>`;
}

/** Insert the tags first in <head> (else after <html>, else at the start). Returns the new HTML. */
export function rewriteHtml(html) {
  const t = tags();
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + t + html.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + t + html.slice(root.index + root[0].length);
  return t + html;
}

// The init script: runs in every document of the context before any of its scripts (also in frames, where it does
// nothing but mark itself). Serialised by Playwright, so it must be self-contained.
function init(cfg) {
  const w = window;
  if (w.__GENCLASS_HUNT__) return;
  const hunt = (w.__GENCLASS_HUNT__ = { frame: w.top !== w, injected: null, connectCalled: false, reason: null, error: null, t: { init: performance.now() } });
  if (hunt.frame) {
    hunt.connect = () => null; // only the top document is under test
    return;
  }
  w.__GENCLASS_AGENT_URL__ = cfg.agentUrl;
  w.GENCLASS_CONFIG = Object.assign({}, w.GENCLASS_CONFIG || {}, cfg.config);
  let connecting = null;
  hunt.connect = (how) => {
    if (connecting) return connecting;
    const rt = w.GenClass && w.GenClass.runtime;
    if (!rt) {
      hunt.error = "window.GenClass.runtime is missing after the runtime script ran (" + how + ")";
      return null;
    }
    hunt.injected = how;
    hunt.t.runtime = performance.now();
    connecting = import(cfg.base + "agent.js").then(
      (m) => {
        const conn = m.connectAgent(rt, { url: cfg.agentUrl, anyHost: !!cfg.anyHost, settleMs: cfg.settleMs, holdProtected: !!cfg.holdProtected });
        hunt.connectCalled = true;
        hunt.reason = conn.reason;
        hunt.t.connect = performance.now();
        return conn;
      },
      (e) => {
        hunt.error = "agent.js: " + ((e && e.message) || String(e));
        return null;
      },
    );
    return connecting;
  };
  // the document was not rewritten: insert the runtime inline now, before the page's external scripts run
  const inline = () => {
    if (w.GenClass || document.querySelector("script[data-genclass-hunt]")) return;
    try {
      const x = new XMLHttpRequest();
      x.open("GET", cfg.base + "genclass.global.js", false);
      x.send();
      if (x.status !== 200) throw new Error("HTTP " + x.status);
      const s = document.createElement("script");
      s.setAttribute("data-base", cfg.base);
      s.setAttribute("data-genclass-hunt", "inline");
      s.textContent = x.responseText;
      (document.head || document.documentElement).appendChild(s);
      hunt.connect("inline");
    } catch (e) {
      hunt.error = "inline injection: " + ((e && e.message) || String(e));
    }
  };
  const mo = new MutationObserver(() => {
    if (!document.documentElement) return;
    mo.disconnect();
    inline();
  });
  mo.observe(document, { childList: true });
}

/**
 * Serve the runtime's dist/ (and a model directory) under the virtual path, rewrite HTML documents, and add the init
 * script to a browser context. `o`: { dist, agentUrl, anyHost, settleMs, holdProtected, config, modelDir, rewrite,
 * onLog }. Returns the per-context log (documents rewritten, files served).
 */
export async function injectGenClass(context, o) {
  const dist = realpathSync(o.dist);
  const modelDir = o.modelDir ? realpathSync(o.modelDir) : null;
  const log = { rewritten: [], passedThrough: [], served: 0, missing: [] };
  const roots = [{ prefix: `${VIRTUAL}model/`, dir: modelDir }, { prefix: VIRTUAL, dir: dist }];
  const serve = async (route, pathname) => {
    for (const r of roots) {
      if (!r.dir || !pathname.startsWith(r.prefix)) continue;
      const file = resolve(r.dir, decodeURIComponent(pathname.slice(r.prefix.length)));
      if (file !== r.dir && !file.startsWith(r.dir + sep)) break;
      try {
        if (!statSync(file).isFile()) break;
        log.served++;
        return route.fulfill({ status: 200, headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }, body: readFileSync(file) });
      } catch {
        break;
      }
    }
    log.missing.push(pathname);
    return route.fulfill({ status: 404, body: "not in dist/" });
  };
  const rewrite = async (route, request) => {
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch (e) {
      log.passedThrough.push(`${request.url()} (fetch failed: ${e.message})`);
      return route.continue();
    }
    const headers = response.headers();
    const ct = headers["content-type"] ?? "";
    if (response.status() >= 300 || !/text\/html/i.test(ct)) {
      log.passedThrough.push(`${request.url()} (${response.status()} ${ct || "no content type"})`);
      return route.fulfill({ response });
    }
    const body = rewriteHtml(await response.text());
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!/^(content-encoding|content-length|transfer-encoding|set-cookie)$/i.test(k)) out[k] = v;
    out["content-type"] = /charset=/i.test(ct) ? ct.replace(/charset=[^;]+/i, "charset=utf-8") : `${ct}; charset=utf-8`;
    log.rewritten.push(request.url());
    return route.fulfill({ status: response.status(), headers: out, body });
  };
  await context.route("**/*", async (route, request) => {
    try {
      const url = new URL(request.url());
      if (url.pathname.startsWith(VIRTUAL)) return await serve(route, url.pathname);
      let top = false;
      try {
        top = request.resourceType() === "document" && request.isNavigationRequest() && !request.frame().parentFrame();
      } catch {
        top = false;
      }
      if (top && o.rewrite !== false) return await rewrite(route, request);
    } catch (e) {
      o.onLog?.(`route: ${e.message}`);
    }
    try {
      return await route.continue();
    } catch {
      /* the page went away */
    }
  });
  await context.addInitScript(init, { agentUrl: o.agentUrl, base: VIRTUAL, anyHost: !!o.anyHost, settleMs: o.settleMs, holdProtected: !!o.holdProtected, config: o.config ?? pageConfig(o) });
  // Chromium's local network access check refuses an intercepted request to the loopback bridge (the interception
  // hides the page's own address space): grant the permission to this context, the test browser only
  try {
    await context.grantPermissions(["local-network-access"]);
  } catch (e) {
    o.onLog?.(`local-network-access permission not granted (${e.message}); if the page cannot reach the bridge, launch Chromium with --disable-features=LocalNetworkAccessChecks`);
  }
  return log;
}
