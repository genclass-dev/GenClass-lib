// Cell-level conflicts of a delivery (structured data only; never in situation text, so the model's input and the
// situation-v2.3 tag are unchanged): how many cells the response would change that hold newer data (a write by
// another chain since the delivering operation started) or the user's pending change. Computed from the content
// comparison the delivery path already makes (situation/content.ts → Cmp: incoming, current and start values), item
// by item on an id key for lists. Exposed as SubjectRef.cellConflicts so a decision provider (the training-data
// simulator, the real-app harness) can compare it with its own oracle before the fact is ever worded for the model.

import type { Conflict } from "../situation/conflicts.js";
import { itemIdKey, itemMap, vhash, type Cmp } from "../situation/content.js";
import { isPlainObject } from "../util.js";

/** SubjectRef.cellConflicts. */
export interface CellConflicts {
  /** Cells the response would change that hold newer data or the user's pending change. */
  cells: number;
  /** Conflicted fields with at least one such cell. */
  fields: number;
  /** Some field's history did not reach back to the operation's start, so its changed cells were all counted. */
  approx: boolean;
}

/** One field: cells the incoming value changes whose current value differs from the value at the start. */
function fieldCells(c: Cmp): [number, boolean] {
  const st = c.start, sv = st?.value;
  if (Array.isArray(c.current) && Array.isArray(c.incoming)) {
    const sample = [...c.current, ...c.incoming].find(isPlainObject);
    const key = sample && itemIdKey(sample);
    const C = key ? itemMap(c.current, key) : null, I = key && C ? itemMap(c.incoming, key) : null;
    if (key && C && I) {
      const S = st && Array.isArray(sv) ? itemMap(sv, key) : null;
      let n = 0;
      for (const [id, ci] of C) {
        const ii = I.get(id), si = S?.get(id);
        if (ii) for (const k in ci) if (k !== key && k in ii && vhash(ii[k]) !== vhash(ci[k]) && (!S || !si || !(k in si) || vhash(si[k]) !== vhash(ci[k]))) n++;
      }
      return [n, !S];
    }
  }
  // a scalar, an object, or a list without an id key: the whole field is one cell
  if (c.same) return [0, false];
  return st ? [vhash(sv) === vhash(c.current) ? 0 : 1, false] : [1, true];
}

/** The cell-level conflicts of a delivery over its conflicted fields; undefined when nothing was compared. */
export function cellConflicts(conflicts: Conflict[], cmps: Cmp[]): CellConflicts | undefined {
  const out: CellConflicts = { cells: 0, fields: 0, approx: false };
  let compared = 0;
  for (const p of new Set(conflicts.map((x) => x.path))) {
    const c = cmps.find((x) => x.path === p);
    if (!c) continue;
    compared++;
    const [n, approx] = fieldCells(c);
    if (n) { out.cells += n; out.fields++; if (approx) out.approx = true; }
  }
  return compared ? out : undefined;
}
