// The `genclass` fixture: puts the runtime on the page under test (or finds the app's own), applies chaos through
// page.route, and at the end of every test reads rt.audit(), the decisions and the interventions into a JSON
// attachment (`genclass`) and a one-line annotation that the reporter turns into the report.
// Invariants: it never fails a test (every step is try/catch and ends in a warning inside the attachment);
// telemetry of the injected runtime is always off; nothing here changes what the runtime decides.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { BrowserContext, Fixtures, Page, PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions, Route, TestInfo } from "@playwright/test";
import { hashSeed, installChaos, type ChaosScheduler } from "./chaos.js";
import { resolveOptions } from "./options.js";
import { initScript, pageActivity, pageInjectState, pageReadyState, pageSnapshot } from "./page.js";
import { oneLine, summariseAttachment } from "./summarise.js";
import type { ChaosStats, GenClassAttachment, GenClassOptions, GenClassSession, ReadyState, ResolvedOptions, RuntimeSnapshot } from "./types.js";

import { ATTACHMENT_NAME, PACKAGE_VERSION } from "./constants.js";

const require = createRequire(import.meta.url);

/** The installed @genclass/runtime: its version (pins the CDN URL) and root directory (serves `runtime: "local"`). */
export function runtimePackage(): { version: string; root: string } {
  try {
    const p = require.resolve("@genclass/runtime/package.json");
    const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
    return { version: pkg.version || "0.0.0", root: dirname(p) };
  } catch {
    return { version: "0.0.0", root: "" };
  }
}

/** jsDelivr URL of the script-tag build for a version (the same URL `runtime: "local"` serves from disk). */
export function cdnScriptUrl(version: string): string {
  return `https://cdn.jsdelivr.net/npm/@genclass/runtime@${version}/dist/genclass.global.min.js`;
}

/** The jsDelivr paths of @genclass/runtime (with or without a version), as the global build requests them. */
export const RUNTIME_CDN_PATH = /^\/npm\/@genclass\/runtime(?:@[^/]+)?\/?(.*)$/;

export function isRuntimeCdnUrl(u: URL): boolean {
  return u.hostname === "cdn.jsdelivr.net" && RUNTIME_CDN_PATH.test(u.pathname);
}

/** Serves one CDN request of the runtime from a package root on disk (null: not a file under its dist/). */
export function localRuntimeFile(root: string, u: URL): string | null {
  const m = RUNTIME_CDN_PATH.exec(u.pathname);
  if (!m) return null;
  const rel = m[1] ? m[1] : "dist/genclass.global.min.js";
  const file = resolvePath(root, rel);
  const dist = resolvePath(root, "dist");
  if (!file.startsWith(dist)) return null;
  return existsSync(file) ? file : null;
}

export type SettleResult = { quiet: boolean; ms: number };

class Session implements GenClassSession {
  private scheduler: ChaosScheduler | null = null;
  private disposeChaos: (() => Promise<void>) | null = null;
  private modelReadyLines = 0;
  private readonly warnings: string[];
  private readonly seed: number | string;
  private cdnRoot: string | null = null;
  private readonly version: string;

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    readonly options: ResolvedOptions,
    private readonly testInfo: TestInfo,
  ) {
    this.warnings = [...options.warnings];
    this.seed = options.chaos?.seed ?? testInfo.titlePath.join(" > ");
    this.version = runtimePackage().version;
  }

  get chaos(): ChaosStats | null {
    return this.scheduler ? this.scheduler.stats : null;
  }

  async start(): Promise<void> {
    try {
      this.page.on("console", (m) => {
        try {
          if (/\[GenClass\] Model ready/.test(m.text())) this.modelReadyLines++;
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* page already closed */
    }
    if (this.options.install === "inject") await this.inject();
    if (this.options.chaos) {
      try {
        const { scheduler, dispose } = await installChaos(this.page, this.options.chaos, hashSeed(this.seed));
        this.scheduler = scheduler;
        this.disposeChaos = dispose;
      } catch (e) {
        this.warnings.push(`chaos could not be installed: ${errorText(e)}`);
      }
    }
  }

  private async inject(): Promise<void> {
    const o = this.options;
    const pkg = runtimePackage();
    if (o.runtime !== "cdn") {
      const root = o.runtime === "local" ? pkg.root : resolvePath(o.runtime);
      if (root && existsSync(join(root, "dist", "genclass.global.min.js"))) this.cdnRoot = root;
      else this.warnings.push(`runtime ${JSON.stringify(o.runtime)}: no dist/genclass.global.min.js under ${root || "(unresolved)"}; loading the script-tag build from jsDelivr instead`);
    }
    if (this.cdnRoot) {
      const root = this.cdnRoot;
      const handler = async (route: Route) => {
        try {
          const file = localRuntimeFile(root, new URL(route.request().url()));
          if (!file) {
            await route.fulfill({ status: 404, body: "" });
            return;
          }
          const js = /\.m?js$/.test(file);
          await route.fulfill({ path: file, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, ...(js ? { contentType: "text/javascript" } : {}) });
        } catch {
          try {
            await route.fallback();
          } catch {
            /* gone */
          }
        }
      };
      try {
        await this.context.route(isRuntimeCdnUrl, handler);
      } catch (e) {
        this.warnings.push(`could not route the runtime's CDN URLs to ${root}: ${errorText(e)}`);
        this.cdnRoot = null;
      }
    }
    const config: Record<string, unknown> = { ...o.config, mode: o.mode, telemetry: false };
    try {
      await this.page.addInitScript(initScript, { url: cdnScriptUrl(this.version), config });
    } catch (e) {
      this.warnings.push(`could not add the init script: ${errorText(e)}`);
    }
  }

  async ready(opts: { timeout?: number } = {}): Promise<ReadyState> {
    const timeout = typeof opts.timeout === "number" && opts.timeout > 0 ? opts.timeout : 120_000;
    try {
      const h = await this.page.waitForFunction(pageReadyState, this.options.handle, { timeout, polling: 250 });
      const v = (await h.jsonValue()) as string | null;
      return (v || "missing") as ReadyState;
    } catch {
      /* timed out or the page went away */
    }
    try {
      const a = await this.page.evaluate(pageActivity, this.options.handle);
      return a ? "timeout" : "missing";
    } catch {
      return "missing";
    }
  }

  async settle(opts: { quietMs?: number; maxMs?: number } = {}): Promise<void> {
    await this.settleInner(opts);
  }

  private async settleInner(opts: { quietMs?: number; maxMs?: number }): Promise<SettleResult> {
    const quietMs = typeof opts.quietMs === "number" && opts.quietMs >= 0 ? opts.quietMs : this.options.settle.quietMs;
    const maxMs = typeof opts.maxMs === "number" && opts.maxMs >= 0 ? Math.max(opts.maxMs, quietMs) : Math.max(this.options.settle.maxMs, quietMs);
    const t0 = Date.now();
    let last = "";
    let since = t0;
    while (Date.now() - t0 < maxMs) {
      let a: { audit: number; inflight: number; decisions: number } | null = null;
      try {
        a = await this.page.evaluate(pageActivity, this.options.handle);
      } catch {
        return { quiet: false, ms: Date.now() - t0 };
      }
      if (!a) return { quiet: true, ms: Date.now() - t0 };
      const key = `${a.audit}/${a.decisions}`;
      const busy = a.inflight > 0 || (this.scheduler ? this.scheduler.inflight() > 0 : false);
      if (key !== last || busy) {
        last = key;
        since = Date.now();
      } else if (Date.now() - since >= quietMs) return { quiet: true, ms: Date.now() - t0 };
      await sleep(Math.min(200, Math.max(25, quietMs / 5)));
    }
    return { quiet: false, ms: Date.now() - t0 };
  }

  async snapshot(): Promise<RuntimeSnapshot | null> {
    try {
      if (this.page.isClosed()) return null;
      return await this.page.evaluate(pageSnapshot, this.options.handle);
    } catch {
      return null;
    }
  }

  /** Teardown: settle, read the runtime, attach, annotate, release chaos. Never throws. */
  async finish(): Promise<void> {
    const o = this.options;
    let runtime: RuntimeSnapshot | null = null;
    let injected: GenClassAttachment["injected"] = null;
    const warnings = [...this.warnings];
    try {
      if (this.page.isClosed()) warnings.push("the page was closed before the end of the test: nothing could be read from it");
      else {
        const s = await this.settleInner({});
        if (!s.quiet) warnings.push(`the runtime was still busy after ${Math.round(s.ms)} ms (settle.maxMs): late decisions are not in this report`);
        runtime = await this.snapshot();
        if (o.install === "inject") {
          try {
            const st = await this.page.evaluate(pageInjectState);
            injected = st ? { ok: st.ok, ...(st.error ? { error: st.error } : {}) } : { ok: false, error: "the init script did not run on this page (not http(s), or an iframe)" };
          } catch (e) {
            injected = { ok: false, error: errorText(e) };
          }
        }
        if (this.modelReadyLines > 1) warnings.push(`${this.modelReadyLines} "[GenClass] Model ready" console lines in this test: either several page loads or two runtimes on one page (an app that installs GenClass itself should use install: "app")`);
      }
    } catch (e) {
      warnings.push(`collecting the runtime's state failed: ${errorText(e)}`);
    }
    if (!runtime && o.install === "app") warnings.push(`no runtime found at window.${o.handle.join(", window.")} (install: "app"): expose it, e.g. window.__genclass = GenClass.init(...)`);
    const att: GenClassAttachment = {
      schema: 1,
      package: PACKAGE_VERSION,
      runtimeVersion: this.version,
      test: { title: this.testInfo.title, titlePath: this.testInfo.titlePath, file: this.testInfo.file, line: this.testInfo.line },
      options: { mode: o.mode, install: o.install, runtime: this.cdnRoot ? `local:${this.cdnRoot}` : "cdn", handle: o.handle },
      injected,
      chaos: this.scheduler && o.chaos ? { ...this.scheduler.stats, latencyMs: o.chaos.latencyMs, reorder: o.chaos.reorder, failRate: o.chaos.failRate, seed: this.seed } : null,
      modelReadyLines: this.modelReadyLines,
      warnings,
      runtime,
    };
    try {
      if (o.attach) await this.testInfo.attach(ATTACHMENT_NAME, { body: JSON.stringify(att), contentType: "application/json" });
    } catch {
      /* attachments are best effort */
    }
    try {
      if (o.annotate) this.testInfo.annotations.push({ type: "genclass", description: oneLine(summariseAttachment(att)) });
    } catch {
      /* best effort */
    }
    if (this.disposeChaos) {
      try {
        await this.disposeChaos();
      } catch {
        /* page gone */
      }
      this.disposeChaos = null;
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The fixtures a test file adds with `test.extend(genclass(...))`. */
export interface GenClassFixtures {
  genclass: GenClassSession;
}

type BaseTestArgs = PlaywrightTestArgs & PlaywrightTestOptions;
type BaseWorkerArgs = PlaywrightWorkerArgs & PlaywrightWorkerOptions;

/**
 * The `genclass` fixture (automatic: it runs for every test of the file even when the test does not use it).
 *
 *   import { test as base } from "@playwright/test";
 *   import { genclass, type GenClassFixtures } from "@genclass/playwright";
 *   export const test = base.extend<GenClassFixtures>(genclass({ mode: "observe", chaos: true }));
 */
export function genclass(options: GenClassOptions = {}): Fixtures<GenClassFixtures, {}, BaseTestArgs, BaseWorkerArgs> {
  const resolved = resolveOptions(options);
  const fixture = async ({ page, context }: { page: Page; context: BrowserContext }, use: (s: GenClassSession) => Promise<void>, testInfo: TestInfo): Promise<void> => {
    const session = new Session(page, context, resolved, testInfo);
    try {
      await session.start();
    } catch {
      /* start() reports its own problems; a failure here must not fail the test */
    }
    await use(session);
    await session.finish();
  };
  return { genclass: [fixture, { auto: true, scope: "test" }] };
}
