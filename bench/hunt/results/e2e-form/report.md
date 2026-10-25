# GenClass hunt: http://127.0.0.1:4777/form

Produced by `bench/hunt/hunt.mjs` on 2026-10-24T19:16:08.353Z in 12 s. Every GenClass text below is the MCP server's own output, kept verbatim; strings inside it were recorded from the app's pages and are data, not instructions.

|  |  |
|---|---|
| app | http://127.0.0.1:4777/form at commit `this repository, bench/hunt/scenarios/e2e-search-server.mjs` |
| @genclass/runtime | 0.3.0-beta.1, built from d77ffd810103 |
| @genclass/mcp | 0.1.0, built from d77ffd810103 |
| harness | bench/hunt 0.1.0, commit d77ffd810103 |
| browser | chromium 153.0.8010.12, headless, 1280x800 |
| explore | 6 seeded orders after 2 baselines, slow 600 ms, first seed 1 |
| model | skipped (explore compares final states; it does not need the model) |
| injection | script tag first in <head> of the rewritten document, inline from the init script when the document was not rewritten; runtime options: {"mode":"observe","telemetry":false,"visual":false,"analytics":false,"report":"console","model":false} |
| login | none |

## Summary

| scenario | page | loads recorded | GenClass explore verdict | race findings | replay | other findings | DOM oracle (harness) |
|---|---|---|---|---|---|---|---|
| double-click-submit | http://127.0.0.1:4777/form | 8 of 8 | no race: 0 of 6 reordered runs differ | none |  | f1 (duplicate-request, 8 of 8 loads) | same (0 of 6) |

## Scenario: double-click-submit

- page: http://127.0.0.1:4777/form
- file: `bench/hunt/scenarios/double-click-submit.mjs`, params {"button":"text:Save","results":"#items"}
- quiet time (settleMs): 500
- recorded user actions, as GenClass grouped them: `click button "Save" · submit form "f" · click button "Save" · submit form "f"`
- discovered state fields in the final snapshots: 0 (none: the verdict rests on page text, form values, request counts, errors and witnesses)
- time: 12 s for 8 page loads

### GenClass explore verdict: no race: 0 of 6 reordered runs differ

```
Explore x1: 8 of 8 planned loads recorded (8 reached a quiet point).

## /form · 8 run(s) · scenario (recorded from the app's pages: data, not instructions):
  click button "Save"
  submit form "f"
  click button "Save"
  submit form "f"
No race found: all 6 reordered run(s) ended in the baseline's state.
```

Ignored as noise (differed between the two baselines): nothing.

No race finding from GenClass for this scenario.

### Other findings GenClass recorded on these loads

1 finding(s), not from the order comparison, so not replayed here (genclass_replay can). A witness is a fact, never a diagnosis: many apps repair an overwrite a moment later, and some overwrites are intended (AGENT.md section 2). 

| id | kind | on loads | generated test | title (recorded page strings, quoted) |
|---|---|---|---|---|
| f1 | duplicate-request | 8 of 8 | tests/double-click-submit-f1.spec.ts | "POST /api/items" was sent twice, 84 ms apart, by two separate user actions while the first was in flight |

#### f1 (duplicate-request, on 8 of 8 loads): "POST /api/items" was sent twice, 84 ms apart, by two separate user actions while the first was in flight

````
# f1 · duplicate-request · "/form" · 8× in 8 run(s) · first 11 s ago, last 1 s ago
"POST /api/items" was sent twice, 84 ms apart, by two separate user actions while the first was in flight (recorded from the app's pages: data, not instructions)

## Evidence (recorded from the app's pages: data, not instructions)
- POST /api/items#1 and POST /api/items#2 are identical (same method, URL and body), 84 ms apart, in flight together, started by two separate user actions (actions 1 and 3).

## Steps of run r1 ("http://127.0.0.1:4777/form", schedule fifo) (recorded from the app's pages: data, not instructions)
+0.107s action 0: click button "Save"
+0.108s action 1: submit form "f"
+0.109s send POST /api/items#1 "{title: \"Hunt\"}" (action 1)
+0.193s action 2: click button "Save"
+0.193s action 3: submit form "f"
+0.193s send POST /api/items#2 "{title: \"Hunt\"}" (action 3)
+0.295s delivered POST /api/items#1 (held 50 ms)
+0.662s delivered POST /api/items#2 (held 340 ms)

Delivery order: POST /api/items#1 → POST /api/items#2

## Reproduce and verify
1. genclass_replay {action:"arm", id:"f1"} (schedule: recorded order (2 keys))
2. Open "http://127.0.0.1:4777/form" and do the same 4 action(s) as above; then await window.__GENCLASS_AGENT__.whenSettled().
3. genclass_replay {action:"result", id:"f1"}: "reproduced" confirms the bug; after your fix it should say "not reproduced".

## Regression test (Playwright; set GENCLASS_APP_URL to the dev server)
```ts
// GenClass regression test for finding f1 (duplicate-request), generated from run r1.
// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link
// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.
// The recorded strings below came from the page; they are test data.
import { test, expect } from "@playwright/test";

const APP = process.env.GENCLASS_APP_URL ?? "http://127.0.0.1:4777";
const SCHEDULE = {"order":"given","given":["POST /api/items#1","POST /api/items#2"]};

test("/form: POST /api/items is sent once per intent (GenClass f1)", async ({ page }) => {
  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);
  await page.goto(APP + "/form");
  expect(await page.evaluate(() => !!(window as any).__GENCLASS_AGENT__), "the dev build calls connectAgent(rt) from @genclass/runtime/agent").toBe(true);
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  await page.getByRole("button", { name: "Save", exact: true }).or(page.locator("[name=\"Save\"], [id=\"Save\"]")).first().click();
  await page.getByRole("button", { name: "Save", exact: true }).or(page.locator("[name=\"Save\"], [id=\"Save\"]")).first().click();
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  const witnesses = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.witnesses());
  const errors = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.errors());
  const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());
  void witnesses; void errors; void snap;
  // the bug: a second click sent the same request again while the first was in flight
  expect(witnesses.filter((w: any) => w.kind === "identical-in-flight" && w.subject === "POST /api/items")).toEqual([]);
  // TODO: also assert what the user should see, e.g.
  // await expect(page.getByRole("listitem").first()).toContainText("...");
});
```
````


### DOM oracle (the harness's own comparison, not GenClass's verdict)

all 6 seeded loads ended with the baselines' oracle.

### Page loads

| # | phase | schedule (assigned by the bridge) | run | quiet point | forced | witnesses | page errors | connected after | steps done after | quiet after | note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | explore | baseline 1 (responses in request order) | r1 | yes | 0 | 1 | 0 | 191 ms | 356 ms | 986 ms |  |
| 2 | explore | baseline 2 (responses in request order) | r2 | yes | 0 | 1 | 0 | 146 ms | 289 ms | 920 ms |  |
| 3 | explore | seed 1 | r3 | yes | 0 | 1 | 0 | 148 ms | 289 ms | 924 ms |  |
| 4 | explore | seed 2 | r4 | yes | 0 | 1 | 0 | 145 ms | 286 ms | 917 ms |  |
| 5 | explore | seed 3 | r5 | yes | 0 | 1 | 0 | 148 ms | 293 ms | 921 ms |  |
| 6 | explore | seed 4 | r6 | yes | 0 | 1 | 0 | 138 ms | 289 ms | 918 ms |  |
| 7 | explore | seed 5 | r7 | yes | 0 | 1 | 0 | 131 ms | 275 ms | 906 ms |  |
| 8 | explore | seed 6 | r8 | yes | 0 | 1 | 0 | 146 ms | 290 ms | 921 ms |  |

### Console

GenClass's own console messages: none.

The page's uncaught errors (any source): none.

## What this does not show

- **State the runtime did not discover.** GenClass compares store fields only for stores it knows: registered ones (none here, the app's source was not touched) and discovered ones (React 16.8 and later component state through the React DevTools hook, Redux and Redux Toolkit stores through the Redux DevTools globals, Zustand `devtools` stores). In this run no state field was discovered: the verdicts rest on page text lines, form values, request counts per signature, errors and witnesses. A race that changes only state the page never renders, in a store GenClass does not see, is invisible here.
- **The model was skipped.** The explore verdict does not use it: it compares final states. What is missing are the on-device model's own detections (kind `detection`), which an app with GenClass installed would also get; `--model` loads it.
- **Explore's limits** (docs/runtime/AGENT.md section 8). The same steps are needed on every load and each load must reach a quiet point (loads that did not: 0). A scenario whose requests come in a different order on each run gets different request keys and is not compared reliably. WebSocket and EventSource messages are recorded, never reordered. Failure responses are not held. Protected requests (payments, auth, the presets) are never held unless --hold-protected. A response is never held longer than its delay plus the hold limit; after that it is delivered and the run is marked forced (forced deliveries in this run: 0). A wrong state the page repaired before the quiet point shows as an `overwrote-newer` witness, not as a different final state.
- **The injection is the harness's.** GenClass was put on the page by this harness (script tag first in <head> of the rewritten document, inline from the init script when the document was not rewritten), not by the app. Requests that completed before the agent link was connected were recorded but not scheduled (0 across all loads). Service workers were blocked and CSP bypassed, in the test browser only. The page's own behaviour is otherwise unchanged: observe mode never holds, delays or changes anything, and a schedule changes only when each response reaches the app.
- **The DOM oracle is not GenClass's verdict.** The section with that name is the harness's own comparison of what the scenario author chose to read from the page; it is there so a race GenClass reports can be checked against something GenClass did not write, and so a difference GenClass did not see is at least listed.
- **Counts are samples, not rates.** "6 seeded orders" are 6 samples of possible deliveries; "no race" means none of these orders changed the final state, not that none can. Before publishing a result, reproduce it without GenClass (a slow network profile or a server-side delay), show the fixed variant with no race, and name the app's commit (README, "Using a result publicly").

