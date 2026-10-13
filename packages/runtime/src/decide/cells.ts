// Cell-level conflicts of a delivery (structured data only; never in situation text, so the model's input and the
// situation-v2.3 tag are unchanged): how many cells the response would change that hold newer data (a write by
// another chain since the delivering operation started) or the user's pending change. Computed from the content
// comparison the delivery path already makes (situation/content.ts → Cmp: incoming, current and start values), item
// by item on an id key for lists. Exposed as SubjectRef.cellConflicts so a decision provider (the training-data
// simulator, the real-app harness) can compare it with its own oracle before the fact is ever worded for the model.

import type { Conflict } from "../situation/conflicts.js";
import { vhash, type Cmp } from "../situation/content.js";
import { isPlainObject } from "../util.js";

/** SubjectRef.cellConflicts. */
export interface CellConflicts {
  /** Cells the response would change that hold newer data or the user's pending change. */
  cells: number;
  /** Conflicted fields with at least one such cell. */
  fields: number;
  /** Some field's history did not reach back to the operation's start, so its cells were counted as conflicting. */
  approx: boolean;
}

const ITEM_ID = ["id", "_id", "uuid", "slug", "key"];
const MAX_ITEMS = 2000;

type Obj = Record<string, unknown>;

function idKeyOf(items: unknown[]): string | undefined {
  const sample = items.find(isPlainObject) as Obj | undefined;
  return sample ? ITEM_ID.find((k) => typeof sample[k] === "string" || typeof sample[k] === "number") : undefined;
}

function byId(items: unknown[], key: string): Map<string, Obj> | null {
  const m = new Map<string, Obj>();
  for (const x of items.slice(0, MAX_ITEMS)) {
    if (!isPlainObject(x)) return null;
    const v = (x as Obj)[key];
    if (typeof v !== "string" && typeof v !== "number") return null;
    m.set(String(v), x as Obj);
  }
  return m;
}

/** Count one field: cells the incoming value changes whose current value differs from the value at the start. */
function fieldCells(cmp: Cmp): { cells: number; approx: boolean } {
  const startKnown = !!cmp.start;
  const start = cmp.start?.value;
  if (Array.isArray(cmp.current) && Array.isArray(cmp.incoming)) {
    const key = idKeyOf([...cmp.current, ...cmp.incoming]);
    const C = key ? byId(cmp.current, key) : null;
    const I = key ? byId(cmp.incoming, key) : null;
    if (key && C && I) {
      const S = startKnown && Array.isArray(start) ? byId(start, key) : null;
      let cells = 0;
      for (const [id, ci] of C) {
        const ii = I.get(id);
        if (!ii) continue;
        const si = S?.get(id);
        for (const k of Object.keys(ci)) {
          if (k === key || !(k in ii) || vhash(ii[k]) === vhash(ci[k])) continue; // the response does not change it
          if (!S) cells++; // start unknown: counted, approx
          else if (!si || !(k in si) || vhash(si[k]) !== vhash(ci[k])) cells++; // newer than at the start
        }
      }
      return { cells, approx: !S };
    }
  }
  // a scalar, an object, or a list without an id key: the whole field is one cell
  if (cmp.same) return { cells: 0, approx: false };
  if (!startKnown) return { cells: 1, approx: true };
  return { cells: vhash(start) === vhash(cmp.current) ? 0 : 1, approx: false };
}

/** The cell-level conflicts of a delivery over its conflicted fields; undefined when nothing was compared. */
export function cellConflicts(conflicts: Conflict[], cmps: Cmp[]): CellConflicts | undefined {
  if (!conflicts.length || !cmps.length) return undefined;
  const out: CellConflicts = { cells: 0, fields: 0, approx: false };
  const seen = new Set<string>();
  let compared = 0;
  for (const c of conflicts) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const cmp = cmps.find((x) => x.path === c.path);
    if (!cmp) continue;
    compared++;
    const r = fieldCells(cmp);
    out.cells += r.cells;
    if (r.cells > 0) out.fields++;
    if (r.approx && r.cells > 0) out.approx = true;
  }
  return compared ? out : undefined;
}
