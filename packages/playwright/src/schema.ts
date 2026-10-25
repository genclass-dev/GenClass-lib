// Validation of "genclass-races/1" files. Pure (no Node APIs): it runs in the reporter, in a CI script and in tests.
// A file that fails validation is never half-read: the summariser lists it under "Files skipped" with these
// messages, so a change of format on the fixture's side shows up in the pull-request comment instead of silently
// producing an empty report. A file with another `schema` value is rejected on that field alone (its other fields
// may legitimately differ).

import { RACES_SCHEMA, type GenClassRacesFile, type RaceSignature, type RacesParseResult } from "./types.js";

/** At most this many messages per file; the rest are counted. */
export const MAX_ERRORS = 8;

function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "object") return "an object";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 39)}…` : v);
  return String(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function fail(errors: string[]): RacesParseResult {
  if (errors.length > MAX_ERRORS) {
    const more = errors.length - MAX_ERRORS;
    errors = [...errors.slice(0, MAX_ERRORS), `and ${more} more error${more === 1 ? "" : "s"}`];
  }
  return { ok: false, errors };
}

function signature(v: unknown, at: string, errors: string[]): RaceSignature | null {
  if (!isObject(v)) {
    errors.push(`${at}: expected an object, got ${describe(v)}`);
    return null;
  }
  const before = errors.length;
  if (typeof v.sig !== "string" || v.sig.trim() === "") errors.push(`${at}.sig: expected a non-empty string, got ${describe(v.sig)}`);
  for (const k of ["trigger", "diagnosis"] as const)
    if (typeof v[k] !== "string" || (v[k] as string).trim() === "") errors.push(`${at}.${k}: expected a non-empty string, got ${describe(v[k])}`);
  if (typeof v.op !== "string") errors.push(`${at}.op: expected a string, got ${describe(v.op)}`);
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1)
    errors.push(`${at}.confidence: expected a number from 0 to 1, got ${describe(v.confidence)}`);
  if (typeof v.evidence !== "string") errors.push(`${at}.evidence: expected a string, got ${describe(v.evidence)}`);
  if (!Array.isArray(v.seeds)) errors.push(`${at}.seeds: expected an array of integers, got ${describe(v.seeds)}`);
  else
    v.seeds.forEach((s, i) => {
      if (!isInt(s)) errors.push(`${at}.seeds[${i}]: expected an integer, got ${describe(s)}`);
    });
  if (errors.length > before) return null;
  return {
    sig: (v.sig as string).trim(),
    trigger: (v.trigger as string).trim(),
    diagnosis: (v.diagnosis as string).trim(),
    op: (v.op as string).trim(),
    confidence: v.confidence as number,
    evidence: v.evidence as string,
    seeds: [...new Set(v.seeds as number[])].sort((a, b) => a - b),
  };
}

/**
 * Validates a parsed "genclass-races/1" value. On success the file is a normalised copy: only the fields of the
 * format, strings trimmed, each signature's seeds de-duplicated and sorted. Never throws.
 */
export function validateRaces(value: unknown): RacesParseResult {
  if (!isObject(value)) return fail([`expected a JSON object, got ${describe(value)}`]);
  if (value.schema !== RACES_SCHEMA) {
    if (value.schema !== undefined) return fail([`schema: expected "${RACES_SCHEMA}", got ${describe(value.schema)}`]);
    const hint = value.format === RACES_SCHEMA ? ` (the file has "format": "${RACES_SCHEMA}"; the field is named "schema")` : "";
    return fail([`schema: missing, expected "${RACES_SCHEMA}"${hint}`]);
  }
  const errors: string[] = [];
  if (typeof value.test !== "string" || value.test.trim() === "") errors.push(`test: expected a non-empty string, got ${describe(value.test)}`);
  if (!isInt(value.seed)) errors.push(`seed: expected an integer, got ${describe(value.seed)}`);
  const signatures: RaceSignature[] = [];
  if (!Array.isArray(value.signatures)) errors.push(`signatures: expected an array, got ${describe(value.signatures)}`);
  else
    value.signatures.forEach((s, i) => {
      const r = signature(s, `signatures[${i}]`, errors);
      if (r) signatures.push(r);
    });
  if (value.mode !== undefined && typeof value.mode !== "string") errors.push(`mode: expected a string when present, got ${describe(value.mode)}`);
  if (value.model !== undefined && value.model !== null) {
    if (!isObject(value.model)) errors.push(`model: expected an object or null when present, got ${describe(value.model)}`);
    else
      for (const k of ["state", "name", "version", "device"])
        if (value.model[k] !== undefined && typeof value.model[k] !== "string") errors.push(`model.${k}: expected a string when present, got ${describe(value.model[k])}`);
  }
  if (value.chaos !== undefined && value.chaos !== null && !isObject(value.chaos)) errors.push(`chaos: expected an object or null when present, got ${describe(value.chaos)}`);
  if (value.fixture !== undefined) {
    const x = value.fixture;
    if (!isObject(x)) errors.push(`fixture: expected an object when present, got ${describe(x)}`);
    else {
      if (x.model !== "skip" && x.model !== "load") errors.push(`fixture.model: expected "skip" or "load", got ${describe(x.model)}`);
      if (x.agent !== null && typeof x.agent !== "string") errors.push(`fixture.agent: expected a string or null, got ${describe(x.agent)}`);
      if (x.chaosApplied !== null && !(isInt(x.chaosApplied) && x.chaosApplied >= 0)) errors.push(`fixture.chaosApplied: expected a whole number or null, got ${describe(x.chaosApplied)}`);
      if (typeof x.serviceWorker !== "boolean") errors.push(`fixture.serviceWorker: expected true or false, got ${describe(x.serviceWorker)}`);
      if (x.modeOverridden !== undefined && typeof x.modeOverridden !== "string") errors.push(`fixture.modeOverridden: expected a string when present, got ${describe(x.modeOverridden)}`);
    }
  }
  if (errors.length) return fail(errors);

  const file: GenClassRacesFile = { schema: RACES_SCHEMA, test: (value.test as string).trim(), seed: value.seed as number, signatures };
  if ("shadow" in value) file.shadow = value.shadow;
  if (typeof value.mode === "string") file.mode = value.mode;
  if (value.model === null) file.model = null;
  else if (isObject(value.model)) {
    const m: NonNullable<GenClassRacesFile["model"]> = {};
    for (const k of ["state", "name", "version", "device"] as const) if (typeof value.model[k] === "string") m[k] = value.model[k] as string;
    file.model = m;
  }
  if (value.chaos === null) file.chaos = null;
  else if (isObject(value.chaos)) {
    const c = value.chaos;
    const out: NonNullable<GenClassRacesFile["chaos"]> = {};
    if (Array.isArray(c.latencyMs) && c.latencyMs.length === 2 && c.latencyMs.every((n) => typeof n === "number" && Number.isFinite(n)))
      out.latencyMs = [c.latencyMs[0] as number, c.latencyMs[1] as number];
    if (typeof c.reorder === "boolean") out.reorder = c.reorder;
    if (typeof c.failRate === "number" && Number.isFinite(c.failRate)) out.failRate = c.failRate;
    if (Array.isArray(c.routes)) out.routes = c.routes.slice();
    file.chaos = out;
  }
  if (isObject(value.fixture)) {
    const x = value.fixture;
    file.fixture = { model: x.model as "skip" | "load", agent: x.agent as string | null, chaosApplied: x.chaosApplied as number | null, serviceWorker: x.serviceWorker as boolean };
    if (typeof x.modeOverridden === "string") file.fixture.modeOverridden = x.modeOverridden;
  }
  return { ok: true, file };
}

/** Parses and validates the text of one file (a leading byte-order mark is ignored). Never throws. */
export function parseRaces(text: string): RacesParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return fail([`not valid JSON (${e instanceof Error ? e.message : String(e)})`]);
  }
  return validateRaces(value);
}
