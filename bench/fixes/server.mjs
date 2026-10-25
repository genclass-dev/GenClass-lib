// The bench's backend: serves the strategy pages, GenClass (built from this repository), the model and a small API
// whose latency and failures are drawn from each run's seed (lib/rng.mjs, lib/config.mjs PROFILES).
//
// HTTP/2 over TLS with a self-signed certificate (made with openssl on first start, in .cache/), so the browser does
// not queue requests behind HTTP/1.1's six connections per host: production APIs mostly speak HTTP/2, and the queue
// would put responses back in order by itself.
//
// A run is registered by the runner (POST /__bench/runs), opened with ?run=<id>, and identified on API calls by the
// `run` cookie the page response sets. Per run the server keeps the request log (arrival, latency, status, aborted),
// the tickets created, and the idempotency keys it has seen.

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import http2 from "node:http2";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PROFILES, STRATEGIES } from "./lib/config.mjs";
import { stream, uniformInt } from "./lib/rng.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
export const DIRS = {
  build: join(HERE, ".out/build"),
  genclass: join(REPO, "packages/runtime/dist"),
  model: join(HERE, ".cache/model/files"),
  // the onnxruntime-web the runtime depends on: its main file is in dist/, next to the wasm files
  ort: dirname(createRequire(join(REPO, "packages/runtime/package.json")).resolve("onnxruntime-web")),
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

/** A self-signed certificate for 127.0.0.1 and localhost, made once. */
function certificate() {
  const dir = join(HERE, ".cache/tls");
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "3650",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { stdio: "ignore" });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/** The page's <head> additions for a GenClass condition: the configuration, then the one script tag. */
function genclassHead(gc) {
  if (!gc) return "";
  const model = gc === "skipped"
    ? `{ loadIf: function () { return false; } }`
    : `{ baseUrl: "/model/", ortWasmPaths: "/ort/", preload: "eager" }`;
  // telemetry off (the bench host is local, where it is off anyway); the measured visual checks are off because
  // 127.0.0.1 is a development host where they would start, and they never feed a detection
  return `<script>window.GENCLASS_CONFIG = { mode: "observe", telemetry: false, visual: false, model: ${model} };</script>\n` +
    `<script src="/genclass/genclass.global.min.js"></script>\n`;
}

function page(strategy, gc) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${genclassHead(gc)}<title>${strategy.kind === "search" ? "Package search" : "New ticket"} (${strategy.id})</title>
<link rel="stylesheet" href="/build/style.css">
</head>
<body>
<div id="app"></div>
<script src="/build/${strategy.id}.js"></script>
</body>
</html>
`;
}

/** Deterministic search results for a query. */
function searchItems(q) {
  const base = q.trim().replace(/\s+/g, "-") || "pkg";
  return ["", "-utils", "-core", "-lite", "-plugin"].map((s, i) => ({ id: `${base}${s}`, name: `${base}${s}`, downloads: 1000 * (5 - i) + q.length }));
}

const runs = new Map();

function newRun(cfg) {
  return { ...cfg, attempts: Object.create(null), lastRelease: 0, log: [], inflight: 0, lastArrival: 0, lastEnd: 0, tickets: [], nextId: 101, idem: new Map(), created: performance.now() };
}

function readCookie(req, name) {
  const c = req.headers.cookie;
  if (!c) return undefined;
  for (const part of String(c).split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return undefined;
}

function sendJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf8");
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/**
 * Answer an API request after the latency the run's seed gives it. `key` names the request (method, path, query);
 * repeats of the same key (a retry, the second click) take the next draw. `respond(fail)` runs at arrival and returns
 * the response to send, or a function that builds it at release time.
 */
function schedule(run, key, req, res, respond) {
  const p = PROFILES[run.profile];
  const attempt = (run.attempts[key] = (run.attempts[key] ?? 0) + 1);
  const rnd = stream(`${run.seed}|${run.profile}|${key}|${attempt}`);
  let latency = uniformInt(rnd, p.latency[0], p.latency[1]);
  const fail = rnd() < p.failRate;
  // drawn after the others, so the profiles without a slow tail keep their numbers
  if (p.slow && rnd() < p.slow.rate) latency = uniformInt(rnd, p.slow.latency[0], p.slow.latency[1]);
  const arrival = performance.now();
  let release = arrival + latency;
  if (p.inOrder) release = Math.max(release, run.lastRelease + 1);
  run.lastRelease = Math.max(run.lastRelease, release);
  const entry = { i: run.log.length, key, attempt, arrival: arrival - run.created, latency, wait: Math.round(release - arrival), status: 0, aborted: false, end: null };
  run.log.push(entry);
  run.inflight++;
  run.lastArrival = arrival;
  let done = false;
  const finish = (aborted) => {
    if (done) return;
    done = true;
    run.inflight--;
    run.lastEnd = performance.now();
    entry.end = run.lastEnd - run.created;
    entry.aborted = aborted;
  };
  res.on("close", () => finish(!res.writableEnded || entry.status === 0));
  const out = respond(fail, entry);
  setTimeout(() => {
    if (res.destroyed || res.writableEnded) return finish(true);
    const r = typeof out === "function" ? out() : out;
    entry.status = r.status;
    sendJson(res, r.status, r.body);
    finish(false);
  }, Math.max(0, release - performance.now()));
}

async function api(run, req, res, url) {
  const method = req.method;
  if (url.pathname === "/api/search" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    schedule(run, `GET /api/search?q=${q}`, req, res, (fail) =>
      fail ? { status: 503, body: { error: "unavailable" } } : { status: 200, body: { q, items: searchItems(q) } });
    return;
  }
  if (url.pathname === "/api/tickets" && method === "GET") {
    schedule(run, "GET /api/tickets", req, res, (fail) =>
      fail ? { status: 503, body: { error: "unavailable" } } : () => ({ status: 200, body: { tickets: run.tickets.map((t) => ({ id: t.id, title: t.title })) } }));
    return;
  }
  if (url.pathname === "/api/tickets" && method === "POST") {
    const body = await readBody(req);
    const idemKey = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : undefined;
    schedule(run, "POST /api/tickets", req, res, (fail, entry) => {
      entry.idemKey = idemKey;
      if (fail) return { status: 503, body: { error: "unavailable" } }; // not processed: nothing created, key not kept
      if (idemKey && run.idem.has(idemKey)) {
        entry.replay = true;
        const t = run.idem.get(idemKey);
        return { status: 200, body: { ticket: { id: t.id, title: t.title }, replayed: true } };
      }
      const t = { id: run.nextId++, title: String(body.title ?? "").slice(0, 200), idemKey };
      run.tickets.push(t);
      if (idemKey) run.idem.set(idemKey, t);
      return { status: 201, body: { ticket: { id: t.id, title: t.title } } };
    });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

function serveStatic(res, dir, rel, cache) {
  const file = normalize(join(dir, rel));
  if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": statSync(file).size,
    "cache-control": cache,
  });
  createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, "https://127.0.0.1");
  const path = url.pathname;
  try {
    if (path === "/__bench/runs" && req.method === "POST") {
      const cfg = await readBody(req);
      if (!PROFILES[cfg.profile] || !cfg.id) return sendJson(res, 400, { error: "bad run" });
      runs.set(cfg.id, newRun(cfg));
      return sendJson(res, 200, { ok: true });
    }
    if (path.startsWith("/__bench/runs/")) {
      const id = decodeURIComponent(path.slice("/__bench/runs/".length));
      const run = runs.get(id);
      if (!run) return sendJson(res, 404, { error: "no run" });
      if (req.method === "DELETE") {
        runs.delete(id);
        return sendJson(res, 200, { ok: true });
      }
      const now = performance.now();
      return sendJson(res, 200, {
        inflight: run.inflight,
        quietMs: Math.round(now - Math.max(run.lastArrival, run.lastEnd, run.created)),
        log: run.log,
        tickets: run.tickets.map((t) => ({ id: t.id, idemKey: t.idemKey ?? null })),
      });
    }
    if (path.startsWith("/s/")) {
      const id = path.split("/")[2];
      const strategy = STRATEGIES.find((s) => s.id === id);
      const runId = url.searchParams.get("run");
      const run = runId ? runs.get(runId) : undefined;
      if (!strategy || !run) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("unknown strategy or run");
      }
      res.writeHead(200, {
        "content-type": TYPES[".html"],
        "cache-control": "no-store",
        "set-cookie": `run=${encodeURIComponent(runId)}; Path=/; SameSite=Lax; Secure`,
      });
      return res.end(page(strategy, run.gc));
    }
    if (path.startsWith("/api/")) {
      const run = runs.get(readCookie(req, "run") ?? "");
      if (!run) return sendJson(res, 400, { error: "no run cookie" });
      return api(run, req, res, url);
    }
    const cache = "public, max-age=86400";
    if (path.startsWith("/build/")) return serveStatic(res, DIRS.build, path.slice(7), "no-cache");
    if (path.startsWith("/genclass/")) return serveStatic(res, DIRS.genclass, path.slice(10), cache);
    if (path.startsWith("/model/")) return serveStatic(res, DIRS.model, path.slice(7), cache);
    if (path.startsWith("/ort/")) return serveStatic(res, DIRS.ort, path.slice(5), cache);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e));
  }
}

/** Start the server; resolves with its origin. */
export function start(port = Number(process.env.PORT ?? 4517)) {
  const server = http2.createSecureServer({ ...certificate(), allowHTTP1: true, settings: { maxConcurrentStreams: 1000 } }, handle);
  server.on("sessionError", () => {});
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ origin: `https://127.0.0.1:${port}`, server })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().then(({ origin }) => console.log(`bench server on ${origin} (self-signed certificate)`));
}
