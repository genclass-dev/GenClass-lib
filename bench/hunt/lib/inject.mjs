// Put @genclass/runtime on a page the harness does not own, and connect it to the bridge, without changing a line of
// the app and without touching the app's own requests. An init script (it runs in every document of the context before
// any of the document's scripts) carries the page configuration (observe, telemetry off, visual checks off, the model
// skipped unless asked), the runtime's script-tag build and the agent link. As soon as the document has its root
// element, it runs the runtime as an inline script, which it removes again right away (so the document an app
// hydrates has no extra node), then imports the agent link from a blob: URL and connects it to the bridge. In Chromium
// that is before the first script of the page's own <head>.
//
// No request of the app is routed, rewritten or delayed by this: the documents, their encoding, streaming, redirects
// and the HTTP cache stay as they are. Only with the model on does the context route one virtual same-origin path,
// `/__genclass__/`, which serves the runtime's dist/ (the model worker and onnxruntime-web load from the script's base
// URL) and a model directory; Playwright then disables the HTTP cache for the context.
//
// What this changes on the page, for the record: the globals the runtime and its agent link define themselves
// (window.GenClass, window.__GENCLASS_AGENT__), window.GENCLASS_CONFIG, window.__GENCLASS_AGENT_URL__ and a
// window.__GENCLASS_HUNT__ object (the injection's own log); and, from the browser context (hunt.mjs), CSP bypassed,
// service workers blocked unless asked, the local-network-access permission granted. Nothing is sent anywhere but the
// loopback bridge.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export const VIRTUAL = "/__genclass__/";
const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".txt": "text/plain",
};
/** A bridge URL that answers nothing (port 9 is one Chromium refuses at once): the page's hello fails and nothing waits. */
export const NO_BRIDGE = "http://127.0.0.1:9";

/**
 * The page configuration the init script sets as `window.GENCLASS_CONFIG` (InitOptions): observe, no telemetry, no
 * visual checks, the model off unless asked. `extra` goes over it.
 */
export function pageConfig(o = {}) {
  const c = { mode: "observe", telemetry: false, visual: false, analytics: false, report: "console" };
  if (o.modelDir) c.model = { baseUrl: `${VIRTUAL}model/`, ...(existsSync(resolve(o.modelDir, "ort")) ? { ortWasmPaths: `${VIRTUAL}model/ort/` } : {}), device: "wasm" };
  else if (!o.model) c.model = false;
  return { ...c, ...(o.extra ?? {}) };
}

const withoutMap = (src) => src.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n");

// The init script: runs in every document of the context before any of its scripts (frames only mark themselves:
// the top document is under test). Serialised by Playwright, so it must be self-contained.
function init(cfg) {
  const w = window;
  if (w.__GENCLASS_HUNT__) return;
  const hunt = (w.__GENCLASS_HUNT__ = { frame: w.top !== w, injected: null, connectCalled: false, reason: null, error: null, t: { init: performance.now() } });
  if (hunt.frame) return;
  w.__GENCLASS_AGENT_URL__ = cfg.agentUrl;
  w.GENCLASS_CONFIG = Object.assign({}, w.GENCLASS_CONFIG || {}, cfg.config);
  const later = w.setTimeout.bind(w); // the page's own, before the agent link wraps it
  const connect = () => {
    const rt = w.GenClass && w.GenClass.runtime;
    if (!rt) {
      hunt.error = "window.GenClass.runtime is missing after the runtime script ran";
      return;
    }
    hunt.t.runtime = performance.now();
    let url;
    try {
      url = URL.createObjectURL(new Blob([cfg.agent], { type: "text/javascript" }));
    } catch (e) {
      hunt.error = "agent link: " + ((e && e.message) || String(e));
      return;
    }
    import(url).then(
      (m) => {
        const conn = m.connectAgent(rt, { url: cfg.agentUrl, anyHost: !!cfg.anyHost, settleMs: cfg.settleMs, holdProtected: !!cfg.holdProtected });
        hunt.connectCalled = true;
        hunt.reason = conn.reason;
        hunt.t.connect = performance.now();
        // a hello that never comes back (a bridge that refuses this origin, a wrong port) is said, not waited out
        if (cfg.helloWaitMs > 0)
          later(() => {
            if (!conn.connected && !hunt.error) hunt.error = "the bridge did not answer the page's hello within " + cfg.helloWaitMs + " ms (is it running, and does it allow this origin?)";
          }, cfg.helloWaitMs);
      },
      (e) => {
        hunt.error = "agent link: " + ((e && e.message) || String(e));
      },
    );
  };
  const inject = () => {
    if (hunt.injected) return;
    hunt.injected = "inline";
    try {
      const s = document.createElement("script");
      s.setAttribute("data-base", cfg.base);
      s.textContent = cfg.runtime;
      (document.head || document.documentElement).appendChild(s);
      s.remove(); // it ran on insertion; the document keeps no node of ours
      connect();
    } catch (e) {
      hunt.error = "inline injection: " + ((e && e.message) || String(e));
    }
  };
  if (document.documentElement) inject();
  else {
    const mo = new MutationObserver(() => {
      if (!document.documentElement) return;
      mo.disconnect();
      inject();
    });
    mo.observe(document, { childList: true });
  }
}

/**
 * Put GenClass on every document of a browser context. `o`: { dist, agentUrl, anyHost, settleMs, holdProtected, config,
 * model, modelDir, helloWaitMs, onLog }. Returns the injection's log (files served under the virtual path, missing ones).
 */
export async function injectGenClass(context, o) {
  const dist = realpathSync(o.dist);
  const runtime = withoutMap(readFileSync(join(dist, "genclass.global.min.js"), "utf8"));
  const agent = withoutMap(readFileSync(join(dist, "agent.js"), "utf8"));
  const log = { served: 0, missing: [], routed: false };
  if (o.model || o.modelDir) {
    // the model worker and onnxruntime-web load from the script's base URL: serve dist/ (and a model directory) there
    const modelDir = o.modelDir ? realpathSync(o.modelDir) : null;
    const roots = [{ prefix: `${VIRTUAL}model/`, dir: modelDir }, { prefix: VIRTUAL, dir: dist }];
    log.routed = true;
    await context.route(`**${VIRTUAL}**`, async (route, request) => {
      const pathname = new URL(request.url()).pathname;
      for (const r of roots) {
        if (!r.dir || !pathname.startsWith(r.prefix)) continue;
        const file = resolve(r.dir, decodeURIComponent(pathname.slice(r.prefix.length)));
        if (file !== r.dir && !file.startsWith(r.dir + sep)) break;
        try {
          if (!statSync(file).isFile()) break;
          log.served++;
          return await route.fulfill({ status: 200, headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }, body: readFileSync(file) });
        } catch {
          break;
        }
      }
      if (log.missing.length < 50) log.missing.push(pathname);
      return route.fulfill({ status: 404, body: "not in dist/" }).catch(() => undefined);
    });
  }
  await context.addInitScript(init, {
    agentUrl: o.agentUrl,
    base: VIRTUAL,
    anyHost: !!o.anyHost,
    settleMs: o.settleMs,
    holdProtected: !!o.holdProtected,
    config: o.config ?? pageConfig(o),
    helloWaitMs: o.helloWaitMs ?? 5000,
    runtime,
    agent,
  });
  // Chromium's local network access check refuses a page's request to the loopback bridge from some pages: grant the
  // permission to this context, the test browser only
  try {
    await context.grantPermissions(["local-network-access"]);
  } catch (e) {
    o.onLog?.(`local-network-access permission not granted (${e.message}); if the page cannot reach the bridge, launch Chromium with --disable-features=LocalNetworkAccessChecks`);
  }
  return log;
}
