// Test helpers: page-like HTTP calls to a bridge (with an Origin header, as a browser sends), recorded runs, and a
// per-test directory for the bridge's API token.
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActStep, Snapshot, Step } from "../src/types.js";

export function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: any }> {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "text/plain", "content-length": Buffer.byteLength(data), host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (t += c));
      res.on("end", () => {
        let json: unknown = null;
        try {
          json = t ? JSON.parse(t) : null;
        } catch {
          json = t;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

export function options(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "OPTIONS", headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

export const PAGE = { origin: "http://localhost:5173" };

/** A page load: hello, then a function that sends events for its run (with its token). */
export async function page(port: number, route = "/search", schedule?: unknown, origin = PAGE.origin) {
  const h = await post(port, "/v1/hello", hello(route, schedule), { origin });
  const { run, token } = h.json as { run: string; token: string };
  return {
    run,
    token,
    schedule: h.json.schedule,
    send: (events: unknown[]) => post(port, "/v1/events", { run, token, events }, { origin }),
  };
}

export function tokenDir(): string {
  return mkdtempSync(join(tmpdir(), "gc-token-"));
}

export function act(i: number, kind: string, target: string, value?: string, extra: Partial<ActStep> = {}): ActStep {
  return { k: "act", i, t: i * 100, kind, target, ...(value !== undefined ? { value } : {}), ...extra };
}

export function snap(state: Record<string, string>, text: string[] = [], extra: Partial<Snapshot> = {}): Snapshot {
  return { t: 1000, state, text, requests: {}, witnesses: 0, errors: 0, forced: 0, ...extra };
}

export function hello(route = "/search", schedule: unknown = undefined) {
  return { schema: "genclass-agent/1", page: { url: `http://localhost:5173${route}`, route, title: "App" }, runtime: { mode: "observe", model: "ready" }, ...(schedule ? { schedule } : {}) };
}

export function steps(...s: Step[]): Step[] {
  return s;
}
