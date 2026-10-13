// Console reporting (CONTRACT §0.5, §8): one plain-English line per detection and per intervention, built from
// the decision's facts with generic templates (reporting only, never decisions), followed by a collapsed group
// with the evidence. Identical repeats within a minute are summarised as "×N in the last minute". A "possible"
// detection (observe's lower tier, InitOptions.detect) is the same line ending in "(possible)", printed with
// console.debug only (hidden at Chrome's default console level); its evidence is in explain(id). Unless the app asked
// for possible detections (`detect: "possible"`), the runtime emits them `quiet`: the console only, no listener and
// no report function.

import type { ActionRecord, Clock, Decision, Expectation, Explanation, Report, TriggerKind } from "../types.js";

const NOUN: Record<TriggerKind, string> = {
  mutation: "write",
  request: "request",
  delivery: "response",
  failure: "request failure",
  stall: "slow request",
  inconsistency: "state",
  transition: "state change",
  error: "error",
  ask: "question",
};

const LEAD: Record<string, string> = {
  discard: "Prevented",
  defer: "Held back",
  coalesce: "Prevented",
  delay: "Slowed down",
  block: "Stopped",
  serve_cached: "Recovered from",
  retry: "Recovered from",
  hedge: "Worked around",
  rollback: "Repaired",
  resync: "Repaired",
};

function an(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function p2(x: number | undefined): string {
  return x === undefined || !Number.isFinite(x) ? "?" : x.toFixed(2);
}

function noun(d: Decision): string {
  const n = d.trigger === "delivery" && !d.subject.startsWith("response") ? "message" : NOUN[d.trigger];
  if (d.diagnosis === "expected") return an(n);
  if (d.trigger === "inconsistency" && d.diagnosis === "inconsistent") return "inconsistent state";
  // Don't repeat a word the noun already carries ("slow request", not "slow slow request").
  return an(n.split(" ").includes(d.diagnosis) ? n : `${d.diagnosis} ${n}`);
}

function topFact(d: Decision): string {
  const f = d.facts.find((x) => !/^This (write|request) (comes from|has no known cause)/.test(x)) ?? d.facts[0] ?? "";
  return f.endsWith(".") ? f : f + ".";
}

export function interventionLine(d: Decision, a: ActionRecord): string {
  const lead = a.late ? "Reverted" : LEAD[a.action] ?? "Handled";
  return `[GenClass] ${lead} ${noun(d)}: ${topFact(d)} ${a.changed}${a.ok ? "" : ` (failed: ${a.error ?? "error"})`} (${d.diagnosis}, ${p2(d.diagnosisConfidence)}; ${a.action} ${p2(d.confidence)})`;
}

export function detectionLine(d: Decision): string {
  let why = "";
  if (d.reason && !d.executed) {
    const would = d.candidate && d.candidate !== d.action && d.mass !== undefined ? `${d.candidate} ${p2(d.mass)} for permitted actions` : `${d.action} ${p2(d.confidence)}`;
    why = ` Not acted on (would have done ${would}): ${d.reason}.`;
  }
  return `[GenClass] Flagged ${noun(d)}: ${topFact(d)}${why} (${d.diagnosis}, ${p2(d.diagnosisConfidence)})${d.detection === "possible" ? " (possible)" : ""}`;
}

/** A possible detection's report (printed with console.debug). */
const possible = (r: Report): boolean => r.kind === "detect" && r.decision?.detection === "possible";

/** A decision that was neither a detection nor an intervention (for explain()). */
export function decisionLine(d: Decision): string {
  const ran = d.ran === d.action ? d.ran : `${d.ran} (the model chose ${d.action}${d.reason ? `; ${d.reason}` : ""})`;
  return `[GenClass] Checked ${d.subject}: ${d.diagnosis} (${p2(d.diagnosisConfidence)}); ran ${ran}.`;
}

type Sink = "console" | "silent" | ((r: Report) => void);

const WINDOW_MS = 60_000;

export class Reporter {
  /** Open dedupe windows: the first report printed, repeats counted, a summary printed when the window ends. */
  private seen = new Map<string, { n: number; first: Report; timer: unknown }>();

  constructor(
    private sink: Sink,
    private readonly clock: Clock,
    private readonly explain: (id: string) => Explanation | null,
    private readonly listener?: (r: Report) => void,
  ) {}

  setSink(s: Sink): void {
    this.sink = s;
  }

  private key(kind: string, d: Decision | undefined, a: ActionRecord | undefined, e?: Expectation): string {
    if (e) return `${kind}|${e.kind}|${e.route}|${e.action.replace(/\d+(\.\d+)?/g, "n")}|${e.signature ?? ""}|${e.field ?? ""}|${e.after ?? ""}|${e.to ?? ""}`;
    const subj = (d?.subject ?? "").replace(/#\d+/g, "#").replace(/\d+(\.\d+)?/g, "n");
    return `${kind}|${a?.action ?? d?.action ?? ""}|${d?.diagnosis ?? ""}|${d?.trigger ?? ""}|${subj}${kind === "detect" && d?.detection === "possible" ? "|possible" : ""}`;
  }

  /** The collapsed evidence of an expectation report: what was learned, what happened, how to see the flows. */
  private printExpectation(con: Console, r: Report, e: Expectation): void {
    if (typeof con.groupCollapsed !== "function") return void (con.info ?? con.log).call(con, r.message);
    con.groupCollapsed(r.message);
    const usual = e.usualMs !== undefined ? ` within ${p2(e.usualMs / 1000)} s` : "";
    const what = e.kind === "request" ? `${e.action} sends ${e.signature}` : e.kind === "follow-up" ? `${e.signature} follows ${e.after}` : e.kind === "write" ? `the response to ${e.signature} writes ${e.field}` : e.kind === "navigation" ? `${e.action} leads to ${e.to}` : `${e.action} answers`;
    con.log(`Learned on ${e.route}: ${what}${usual} (${e.seen} of ${e.of}, ${e.sessions} session${e.sessions === 1 ? "" : "s"}).`);
    con.log(`This time: nothing after ${p2(e.waitedMs / 1000)} s (op #${e.op}).`);
    con.log("Deterministic report from learned counts; no model, no action taken in any mode.");
    con.log("Flows learned for this page: GenClass.runtime.learned()");
    con.log("Turn this off: GenClass.init({ learn: { expectations: false } })");
    con.groupEnd();
  }

  /** True when the report should be printed now (first of its window); repeats are counted for the summary. */
  private dedupe(k: string, r: Report): boolean {
    const s = this.seen.get(k);
    if (s) {
      s.n++;
      return false;
    }
    const timer = this.clock.setTimeout(() => this.flush(k), WINDOW_MS);
    this.seen.set(k, { n: 0, first: r, timer });
    return true;
  }

  /** End of a dedupe window: print how many identical reports were folded. */
  private flush(k: string): void {
    const s = this.seen.get(k);
    this.seen.delete(k);
    if (!s || s.n === 0 || typeof this.sink !== "string" || this.sink !== "console") return;
    const con = (globalThis as { console?: Console }).console;
    const line = `${s.first.message} (×${s.n} more in the last minute)`;
    (s.first.kind === "intervene" ? con?.warn ?? con?.log : possible(s.first) ? con?.debug ?? con?.log : con?.info ?? con?.log)?.call(con, line);
  }

  dispose(): void {
    for (const s of this.seen.values()) this.clock.clearTimeout(s.timer);
    this.seen.clear();
  }

  /** `quiet`: the console only (a possible detection nobody asked for: no listener, no report function). */
  emit(r: Report, quiet = false): void {
    const sink = this.sink;
    try {
      if (!quiet) this.listener?.(r);
      if (typeof sink === "function") return void (quiet || sink(r));
    } catch {
      /* listeners and report functions never break reporting or the app */
    }
    if (sink === "silent" || typeof sink === "function") return;
    if (r.kind !== "status" && !this.dedupe(this.key(r.kind, r.decision, r.action, r.expectation), r)) return;
    const con = (globalThis as { console?: Console }).console;
    if (!con) return;
    const line = r.message;
    if (r.kind === "status") {
      con.info?.(line);
      return;
    }
    if (r.kind === "expectation" && r.expectation) return this.printExpectation(con, r, r.expectation);
    if (possible(r)) return void (con.debug ?? con.log)?.call(con, line);
    const ev = r.action ? this.explain(r.action.id) : r.decision ? this.explain(r.decision.id) : null;
    if (ev && typeof con.groupCollapsed === "function") {
      con.groupCollapsed(line);
      con.log("Facts:\n  " + ev.facts.join("\n  "));
      if (ev.timeline.length) con.log("Timeline:\n  " + ev.timeline.join("\n  "));
      con.log("Situation sent to the model:\n" + ev.situationText);
      con.log("Answers:", ev.answers);
      if (r.action) {
        con.log(`Changed: ${r.action.changed}`);
        con.log(r.action.undo ? `Undo: GenClass.runtime.interventions().find(a => a.id === "${r.action.id}").undo()` : "Undo: not reversible");
        con.log(`Deny this action: GenClass.init({ policy: { deny: ["${r.action.action}"] } })`);
      }
      con.log(`explain: GenClass.runtime.explain("${r.action?.id ?? r.decision?.id}")`);
      con.groupEnd();
    } else {
      (r.kind === "intervene" ? con.warn ?? con.log : con.info ?? con.log).call(con, line);
    }
  }
}
