// What one test collected -> one "genclass-races/1" file (the format in types.ts, which the reporter and the
// summariser read). Pure: no I/O here except the one writer at the bottom, no clock, no randomness; the same input
// gives the same bytes.
//
// Two sources, told apart by `trigger`:
//   - the runtime's likely detections (sink records of kind "detection"): trigger is the runtime's trigger kind,
//     diagnosis and confidence are the model's, evidence is the console line the runtime printed. Only with a model
//     on the page (`model: "load"`).
//   - the agent entry's witnesses (overwrote-newer, identical-in-flight): trigger "witness", diagnosis the witness
//     kind, confidence 1 (a fact that happened, not a probability; the summariser shows no confidence for them) and
//     an evidence line written here from the witness's fields. These need no model, so they are what the default
//     (`model: "skip"`) carries. A witness is a fact, never a diagnosis: nothing here maps one to "stale" or
//     "duplicate", and the report keeps them in their own group.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RACES_SCHEMA, type GenClassRacesFile, type RaceSignature } from "./types.js";

/** The `trigger` of a witness signature. */
export const WITNESS_TRIGGER = "witness";

/** A sink record of kind "detection", as far as the file reads it (the runtime's SinkRecord, by shape). */
export interface DetectionRecord {
  kind?: string;
  trigger?: string;
  diagnosis?: string;
  p?: number;
  detection?: string;
  evidence?: { message?: string; subject?: string };
}

/** An agent witness, as far as the file reads it (the runtime's agent Witness, by shape). */
export interface WitnessRecord {
  kind?: string;
  subject?: string;
  by?: string;
  over?: string;
  overKind?: string;
  gapMs?: number;
  change?: string;
}

export interface RacesInput {
  test: string;
  seed: number;
  mode: string | null;
  model: GenClassRacesFile["model"];
  chaos: GenClassRacesFile["chaos"];
  records: readonly unknown[];
  witnesses: readonly unknown[];
}

const METHOD_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([^\s()?#]+)/;

/** "GET /api/search?q=… (#21)" or "GET /api/search#3~retry2" -> "GET /api/search"; anything else is kept (trimmed). */
export function opOf(text: string | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  const m = METHOD_RE.exec(t);
  if (m) return `${m[1]} ${m[2]}`;
  return t.slice(0, 120);
}

function secs(ms: number | undefined): string {
  return `${((ms ?? 0) / 1000).toFixed(2)}s`;
}

/** The evidence line for a witness, from its fields (request keys as the agent names them: "GET /api/search#3"). */
export function witnessLine(w: WitnessRecord): string {
  const by = w.by ?? "?";
  if (w.kind === "overwrote-newer") {
    const over = w.overKind === "user" ? `the user (${w.over ?? "?"})` : `newer ${w.over ?? "?"}`;
    const change = w.change ? ` (${w.change})` : "";
    return `The response of ${by} wrote ${w.subject ?? "?"} over what ${over} had written ${secs(w.gapMs)} after ${by} started${change}.`;
  }
  if (w.kind === "identical-in-flight") return `${by} was sent while the identical ${w.over ?? "?"} was still in flight (${secs(w.gapMs)} earlier), from a separate user action.`;
  return `${w.kind ?? "witness"}: ${w.subject ?? ""} by ${by} over ${w.over ?? "?"}`.trim();
}

function clamp01(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function add(map: Map<string, RaceSignature>, s: RaceSignature): void {
  const prev = map.get(s.sig);
  if (!prev) map.set(s.sig, s);
  else if (s.confidence > prev.confidence) {
    prev.confidence = s.confidence;
    prev.evidence = s.evidence;
  }
}

/** The distinct signatures of a test, sorted by `sig`: detections (likely, not `expected`) and witnesses. */
export function signaturesOf(records: readonly unknown[], witnesses: readonly unknown[], seed: number): RaceSignature[] {
  const out = new Map<string, RaceSignature>();
  for (const x of records) {
    if (!x || typeof x !== "object") continue;
    const r = x as DetectionRecord;
    if (r.kind !== undefined && r.kind !== "detection") continue;
    const diagnosis = String(r.diagnosis ?? "").trim();
    if (!diagnosis || diagnosis === "expected") continue;
    const trigger = String(r.trigger ?? "unknown").trim() || "unknown";
    const op = opOf(r.evidence?.subject);
    add(out, { sig: `${trigger}|${diagnosis}|${op}`, trigger, diagnosis, op, confidence: clamp01(r.p), evidence: String(r.evidence?.message ?? "").replace(/\s+/g, " ").trim(), seeds: [seed] });
  }
  for (const x of witnesses) {
    if (!x || typeof x !== "object") continue;
    const w = x as WitnessRecord;
    const diagnosis = String(w.kind ?? "").trim();
    if (!diagnosis) continue;
    const op = opOf(w.by);
    add(out, { sig: `${WITNESS_TRIGGER}|${diagnosis}|${op}`, trigger: WITNESS_TRIGGER, diagnosis, op, confidence: 1, evidence: witnessLine(w), seeds: [seed] });
  }
  return [...out.values()].sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
}

/** The file for one test run. Validates against the reporter's schema by construction. */
export function buildRacesFile(i: RacesInput): GenClassRacesFile {
  const file: GenClassRacesFile = { schema: RACES_SCHEMA, test: i.test, seed: i.seed, signatures: signaturesOf(i.records, i.witnesses, i.seed) };
  if (i.mode) file.mode = i.mode;
  file.model = i.model ?? null;
  if (i.chaos !== undefined) file.chaos = i.chaos;
  return file;
}

/** A file name for a test: a slug of its title (at most 80 characters), its id and its seed. */
export function racesFileName(test: string, id: string, seed: number): string {
  const slug = test
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  const safeId = id.replace(/[^A-Za-z0-9_-]+/g, "");
  return `${slug || "test"}-${safeId || "0"}-s${seed}.json`;
}

/** Writes the file (creating the directory) and returns its path. */
export function writeRacesFile(dir: string, name: string, file: GenClassRacesFile): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}
