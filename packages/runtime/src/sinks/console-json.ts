// @genclass/runtime/sinks/console-json: one JSON line per record on the console, for log shippers that collect
// console output (headless browsers, Electron, test runners, browser log forwarders). Every kind, the session summary
// included. Zero dependencies; never throws.

import type { SinkKind, SinkObject, SinkRecord } from "../types.js";
import { globalOf } from "./common.js";

/** The part of the console the adapter uses. */
export interface ConsoleLike {
  log?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

export interface ConsoleJsonSinkOptions {
  /** Record kinds to forward (default: all, the session summary included). */
  kinds?: SinkKind[];
  /** Session-deterministic sampling (SinkObject.sampleRate). */
  sampleRate?: number;
  /** The console (default: `globalThis.console`, read on every record). */
  console?: ConsoleLike;
  /** Console method (default "log"). */
  method?: "log" | "info" | "warn" | "error";
  /** Where `console` is looked up (default `globalThis`). */
  global?: object;
}

/**
 * A sink that prints each record as one line of JSON: the SinkRecord's fields, with `source: "genclass"` first
 * (`{"source":"genclass","schema":1,"kind":"detection",...}`), the redacted evidence included.
 */
export function consoleJson(o: ConsoleJsonSinkOptions = {}): SinkObject {
  const method = o.method ?? "log";
  return {
    kinds: o.kinds,
    sampleRate: o.sampleRate,
    evidence: true,
    send(r: SinkRecord): void {
      try {
        const con = o.console ?? (globalOf(o).console as ConsoleLike | undefined);
        const fn = con?.[method] ?? con?.log;
        if (!con || typeof fn !== "function") return;
        fn.call(con, JSON.stringify({ source: "genclass", ...r }));
      } catch {
        /* never into the app */
      }
    },
  };
}

export default consoleJson;
