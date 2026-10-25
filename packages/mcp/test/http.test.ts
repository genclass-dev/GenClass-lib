// The bridge's HTTP server (AGENT.md §4, §6): who may call what.
import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { callBridge, devOrigin, parseOrigins, probeBridge, startBridge, tokenFile, type Bridge } from "../src/http.js";
import { Store } from "../src/store.js";
import { makeApi } from "../src/api.js";
import { PAGE, hello, options, page, post, tokenDir } from "./helpers.js";

let b: Bridge | null = null;
afterEach(async () => {
  await b?.close();
  b = null;
});

async function start(origins?: Set<string>): Promise<{ store: Store; b: Bridge; dir: string }> {
  const store = new Store();
  const dir = tokenDir();
  let api: ReturnType<typeof makeApi> | null = null;
  b = await startBridge(store, { port: 0, api: (m, p) => api!(m, p), tokenDir: dir, ...(origins ? { origins } : {}) });
  api = makeApi(store, { url: b.url, port: b.port });
  return { store, b, dir };
}

describe("bridge: HTTP (AGENT.md §4, §6)", () => {
  it("page origins on this machine only, unless allowed exactly", () => {
    for (const o of ["http://localhost:5173", "http://127.0.0.1:3000", "https://app.localhost", "http://[::1]:8080"]) expect(devOrigin(o), o).toBe(true);
    for (const o of ["https://evil.example", "http://portal.test", "http://8.8.8.8", "http://10.0.0.1", "http://192.168.1.1", "http://printer.local", "http://corp.internal", "null", undefined, "file:///x", "http://localhost.evil.com"]) expect(devOrigin(o), String(o)).toBe(false);
    expect(devOrigin("http://shop.test", parseOrigins("http://shop.test"))).toBe(true);
    const allow = parseOrigins("http://192.168.1.20:5173, nonsense, https://dev.corp.internal");
    expect(devOrigin("http://192.168.1.20:5173", allow)).toBe(true);
    expect(devOrigin("http://192.168.1.20:5174", allow)).toBe(false);
    expect(devOrigin("https://dev.corp.internal", allow)).toBe(true);
  });

  it("a page on this machine says hello and sends events with its token; CORS names its origin", async () => {
    const { store, b } = await start();
    const h = await post(b.port, "/v1/hello", hello(), { origin: PAGE.origin });
    expect(h.status).toBe(200);
    expect(h.json.run).toBe("r1");
    expect(typeof h.json.token).toBe("string");
    expect(h.headers["access-control-allow-origin"]).toBe(PAGE.origin);
    const ev = [{ t: "error", error: { t: 1, name: "Error", message: "boom", chain: [] } }];
    expect((await post(b.port, "/v1/events", { run: "r1", events: ev }, { origin: PAGE.origin })).json).toEqual({ ok: true, applied: 0 });
    expect((await post(b.port, "/v1/events", { run: "r1", token: h.json.token, events: ev }, { origin: "http://localhost:6006" })).json).toEqual({ ok: true, applied: 0 });
    expect((await post(b.port, "/v1/events", { run: "r1", token: h.json.token, events: ev }, { origin: PAGE.origin })).json).toEqual({ ok: true, applied: 1 });
    expect(store.ranked()).toHaveLength(1);
  });

  it("an allowed LAN origin may connect; a private-network preflight is answered only when asked", async () => {
    const { b } = await start(parseOrigins("http://192.168.1.20:5173"));
    expect((await post(b.port, "/v1/hello", hello(), { origin: "http://192.168.1.20:5173" })).status).toBe(200);
    expect((await post(b.port, "/v1/hello", hello(), { origin: "http://192.168.1.21:5173" })).status).toBe(403);
    const plain = await options(b.port, "/v1/hello", { origin: PAGE.origin, "access-control-request-method": "POST" });
    expect(plain.headers["access-control-allow-private-network"]).toBeUndefined();
    const pna = await options(b.port, "/v1/hello", { origin: PAGE.origin, "access-control-request-method": "POST", "access-control-request-private-network": "true" });
    expect(pna.headers["access-control-allow-private-network"]).toBe("true");
  });

  it("refuses pages on public or LAN hosts, requests without an origin, and a rebinding Host", async () => {
    const { store, b } = await start();
    expect((await post(b.port, "/v1/hello", hello(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(b.port, "/v1/hello", hello(), { origin: "http://10.0.0.1" })).status).toBe(403);
    expect((await post(b.port, "/v1/hello", hello())).status).toBe(403);
    expect((await post(b.port, "/v1/hello", hello(), { origin: PAGE.origin, host: `evil.example:${b.port}` })).status).toBe(421);
    expect(store.runs.size).toBe(0);
  });

  it("the agent API is for local processes of this user: no Origin, the custom header and the token", async () => {
    const { b, dir } = await start();
    const file = tokenFile(b.port, dir);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o077).toBe(0);
    const token = readFileSync(file, "utf8");
    expect((await post(b.port, "/v1/api", { m: "status" })).status).toBe(403);
    expect((await post(b.port, "/v1/api", { m: "status" }, { "x-genclass-api": "1" })).status).toBe(403);
    expect((await post(b.port, "/v1/api", { m: "status" }, { "x-genclass-api": "1", "x-genclass-token": token, origin: PAGE.origin })).status).toBe(403);
    const ok = await post(b.port, "/v1/api", { m: "status" }, { "x-genclass-api": "1", "x-genclass-token": token });
    expect(ok.status).toBe(200);
    expect(ok.json.result.bridge.port).toBe(b.port);
    // through the client helper too (Node's fetch sends no Origin; it reads the token file)
    expect(((await callBridge(b.port, "status", {}, "127.0.0.1", 5000, dir)) as { totalRuns: number }).totalRuns).toBe(0);
    expect(await probeBridge(b.port)).toBe(true);
    await b.close();
    expect(existsSync(file)).toBe(false);
  });

  it("caps bodies and rejects bad JSON", async () => {
    const { b } = await start();
    expect((await post(b.port, "/v1/events", "{nope", { origin: PAGE.origin })).status).toBe(400);
    expect((await post(b.port, "/v1/events", "x".repeat(1024 * 1024 + 10), { origin: PAGE.origin })).status).toBe(413);
  });

  it("a second bridge on the same port fails with EADDRINUSE (the server then shares the first)", async () => {
    const { b } = await start();
    await expect(startBridge(new Store(), { port: b.port, tokenDir: tokenDir() })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("the page helper flow works end to end", async () => {
    const { store, b } = await start();
    const p = await page(b.port, "/cart");
    expect((await p.send([{ t: "error", error: { t: 1, name: "TypeError", message: "x", chain: [] } }])).json.applied).toBe(1);
    expect(store.ranked()[0].route).toBe("/cart");
  });
});
