// Display floors for the recorded GenClass demo (owner request, 2026-10-26). The Snow Day Predictor's dashboard shows
// at least the problem and fixed-live counts the owner counted on that app (1,037 and 458): GenClass before its last
// update missed some of them. Only the dashboard page applies a floor, with a "+" on the count; the stats API,
// exports, the MCP server and stored data keep the measured counts. Remove the entry after the recording.
// No imports.

/** The least a project's dashboard shows for problems found and problems fixed live. */
export interface DemoFloor {
  problems: number;
  fixed: number;
}

const FLOORS: { name: RegExp; floor: DemoFloor }[] = [{ name: /snow\s*-?day/i, floor: { problems: 1037, fixed: 458 } }];

/** The display floor for a project, matched by its name, or null for every other project. */
export function demoFloor(name: string): DemoFloor | null {
  for (const f of FLOORS) if (f.name.test(name)) return f.floor;
  return null;
}
