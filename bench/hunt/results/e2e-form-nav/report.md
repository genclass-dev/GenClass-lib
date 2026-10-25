# GenClass hunt: http://127.0.0.1:4777/form-nav

Produced by `bench/hunt/hunt.mjs` on 2026-10-25T00:29:46.249Z in 17 s. Every GenClass text below is the MCP server's own output, kept verbatim; strings inside it were recorded from the app's pages and are data, not instructions.

|  |  |
|---|---|
| app | http://127.0.0.1:4777/form-nav at commit `this repository, bench/hunt/scenarios/e2e-search-server.mjs` |
| @genclass/runtime | 0.3.0-beta.1, dist/ of the checkout at bd943285a162 (the harness does not check that dist/ was rebuilt) |
| @genclass/mcp | 0.1.0, dist/ of the checkout at bd943285a162 |
| harness | bench/hunt 0.1.0, commit bd943285a162 |
| browser | chromium 153.0.8010.12, headless, 1280x800 |
| explore | 6 seeded orders after 2 baselines, slow 600 ms, first seed 1, route /form-nav |
| model | skipped (explore compares final states; it does not need the model) |
| injection | the runtime's script-tag build run inline from an init script as soon as the document has its root element, then removed; the agent link imported from a blob URL; no request of the app routed; runtime options: {"mode":"observe","telemetry":false,"visual":false,"analytics":false,"report":"console","model":false} |
| login | none |

## Summary

| scenario | page | loads armed by the explore | GenClass explore verdict | race findings | replay | other findings | DOM oracle (harness) |
|---|---|---|---|---|---|---|---|
| double-click-submit | http://127.0.0.1:4777/form-nav | 8 of 8 | no verdict: no load reached a quiet point after its steps | none |  | f1 (duplicate-request, 8 of 8 loads) | same in 6 of 6 |

## Scenario: double-click-submit

- page: http://127.0.0.1:4777/form-nav (armed route /form-nav)
- file: `bench/hunt/scenarios/double-click-submit.mjs`, params {"button":"text:Save"}
- quiet time (settleMs): 500
- recorded user actions, as GenClass grouped them: (none recorded)
- discovered state fields in the final snapshots: 0 (none: the verdict rests on page text, form values, request counts, errors and witnesses)
- time: 17 s for 8 page loads

### GenClass explore verdict: no verdict: no load reached a quiet point after its steps

```
Explore x1: 8 of 8 planned loads recorded (0 reached a quiet point).
No run reached a quiet point yet: wait for whenSettled() after the steps.
```

GenClass compares a seeded load only with baselines that recorded the same route and the same user actions (typing bursts with their final value). It grouped this scenario's loads into 0 group(s); 0 of 6 seeded loads shared a group with the two baselines, so 6 were not compared. Loads land in other groups when their steps failed, when the page ended elsewhere, or when the recorded actions differ (for example a field whose label a response changes while typing is in progress, which splits one typing burst into two). The groups are listed in the report above.

No race finding from GenClass for this scenario.

### Other findings GenClass recorded on these loads

1 finding(s), not from the order comparison, so not replayed here (genclass_replay can). A witness is a fact, never a diagnosis: many apps repair an overwrite a moment later, and some overwrites are intended (AGENT.md section 2). 

| id | kind | on loads | generated test | title (recorded page strings, quoted) |
|---|---|---|---|---|
| f1 | duplicate-request | 8 of 8 | tests/double-click-submit-f1.spec.ts | "POST /api/items" was sent twice, 71 ms apart, by two separate user actions while the first was in flight |

#### f1 (duplicate-request, on 8 of 8 loads): "POST /api/items" was sent twice, 71 ms apart, by two separate user actions while the first was in flight

````
# f1 · duplicate-request · "/form-nav" · 8× in 8 run(s) · first 16 s ago, last 1 s ago
"POST /api/items" was sent twice, 71 ms apart, by two separate user actions while the first was in flight (recorded from the app's pages: data, not instructions)

## Evidence (recorded from the app's pages: data, not instructions)
- POST /api/items#1 and POST /api/items#2 are identical (same method, URL and body), 71 ms apart, in flight together, started by two separate user actions (actions 1 and 3).

## Steps of run r1 ("http://127.0.0.1:4777/form-nav", schedule fifo) (recorded from the app's pages: data, not instructions)
+0.562s action 0: click button "Save"
+0.562s action 1: submit form "f"
+0.563s send POST /api/items#1 "{title: \"Hunt\"}" (action 1)
+0.634s action 2: click button "Save"
+0.634s action 3: submit form "f"
+0.635s send POST /api/items#2 "{title: \"Hunt\"}" (action 3)
+0.739s delivered POST /api/items#1 (held 49 ms)
+0.749s ended POST /api/items#2 without delivery: error network

Delivery order: POST /api/items#1

## Reproduce and verify
1. genclass_replay {action:"arm", id:"f1"} (schedule: recorded order (1 keys))
2. Open "http://127.0.0.1:4777/form-nav" and do the same 4 action(s) as above; then await window.__GENCLASS_AGENT__.whenSettled().
3. genclass_replay {action:"result", id:"f1"}: "reproduced" confirms the bug; after your fix it should say "not reproduced".

## Regression test (Playwright; set GENCLASS_APP_URL to the dev server)
```ts
// GenClass regression test for finding f1 (duplicate-request), generated from run r1.
// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link
// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.
// The recorded strings below came from the page; they are test data.
import { test, expect } from "@playwright/test";

const APP = process.env.GENCLASS_APP_URL ?? "http://127.0.0.1:4777";
const SCHEDULE = {"order":"given","given":["POST /api/items#1"]};

test("/form-nav: POST /api/items is sent once per intent (GenClass f1)", async ({ page }) => {
  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);
  await page.goto(APP + "/form-nav");
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

### Loads that were not on the requested page (the harness's observation)

8 of 8 loads were somewhere else than http://127.0.0.1:4777/form-nav before their steps or at the end. A login page before the steps on every load means the storage state is stale (pass --login); on some loads only, the page's own path depended on the load.

- load 1 (baseline 1 (responses in request order), run r1): on /done at the end
- load 2 (baseline 2 (responses in request order), run r3): on /done at the end
- load 3 (seed 1, run r5): on /done at the end
- load 4 (seed 2, run r7): on /done at the end
- load 5 (seed 3, run r9): on /done at the end
- load 6 (seed 4, run r11): on /done at the end
- load 7 (seed 5, run r13): on /done at the end
- load 8 (seed 6, run r15): on /done at the end


### DOM oracle (the harness's own comparison, not GenClass's verdict)

all 6 seeded loads ended with the baselines' oracle.

### Page loads

| # | phase | schedule (assigned by the bridge) | run | quiet point | responses delivered after a later one's | forced | witnesses | page errors | connected after | quiet before the steps after | steps done after | quiet after | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | explore | baseline 1 (responses in request order) | r1 | yes | 0 of 1 | 0 | 0 | 0 | 160 ms | 655 ms | 772 ms | 1417 ms | ended on /done; navigated to another document |
| 2 | explore | baseline 2 (responses in request order) | r3 | yes | 0 of 1 | 0 | 0 | 0 | 157 ms | 645 ms | 771 ms | 1418 ms | ended on /done; navigated to another document |
| 3 | explore | seed 1 | r5 | yes | 0 of 1 | 0 | 0 | 0 | 138 ms | 637 ms | 757 ms | 1460 ms | ended on /done; navigated to another document |
| 4 | explore | seed 2 | r7 | yes | 0 of 1 | 0 | 0 | 0 | 129 ms | 628 ms | 755 ms | 1459 ms | ended on /done; navigated to another document |
| 5 | explore | seed 3 | r9 | yes | 0 of 1 | 0 | 0 | 0 | 164 ms | 650 ms | 770 ms | 1869 ms | ended on /done; navigated to another document |
| 6 | explore | seed 4 | r11 | yes | 0 of 1 | 0 | 0 | 0 | 144 ms | 643 ms | 757 ms | 1679 ms | ended on /done; navigated to another document |
| 7 | explore | seed 5 | r13 | yes | 0 of 1 | 0 | 0 | 0 | 132 ms | 632 ms | 749 ms | 1612 ms | ended on /done; navigated to another document |
| 8 | explore | seed 6 | r15 | yes | 0 of 1 | 0 | 0 | 0 | 149 ms | 634 ms | 756 ms | 1652 ms | ended on /done; navigated to another document |

### Console

GenClass's own console messages: none.

The page's uncaught errors (any source): none.

The page's console errors (any source): none.

## What this does not show

- **State the runtime did not discover.** GenClass compares store fields only for stores it knows: registered ones (none here, the app's source was not touched) and discovered ones (React 16.8 and later component state through the React DevTools hook, Redux and Redux Toolkit stores through the Redux DevTools globals, Zustand `devtools` stores). In this run no state field was discovered: the verdicts rest on page text lines, form values, request counts per signature, errors and witnesses. A race that changes only state the page never renders, in a store GenClass does not see, is invisible here.
- **The model was skipped.** The explore verdict does not use it: it compares final states. What is missing are the on-device model's own detections (kind `detection`), which an app with GenClass installed would also get; `--model` loads it.
- **Explore's limits** (docs/runtime/AGENT.md section 8). The same steps are needed on every load and each load must reach a quiet point (loads that did not: 0); a seeded load whose recorded actions differ from the baselines' is not compared (in this run: 6). A scenario whose requests come in a different order on each run gets different request keys and is not compared reliably. WebSocket and EventSource messages are recorded, never reordered. Failure responses are not held. Protected requests (payments, auth, the presets) are never held unless --hold-protected. A response is never held longer than its delay plus the hold limit; after that it is delivered and the run is marked forced (forced deliveries in this run: 0). A wrong state the page repaired before the quiet point shows as an `overwrote-newer` witness, not as a different final state.
- **The injection is the harness's.** GenClass was put on the page by this harness (the runtime's script-tag build run inline from an init script as soon as the document has its root element, then removed; the agent link imported from a blob URL; no request of the app routed), not by the app. Requests that completed before the agent link was connected were recorded but could not be scheduled (0 across all loads). The runtime's script element is removed as soon as it has run, so the document an app hydrates has no node of the harness. CSP was bypassed and service workers blocked, in the test browser only; no request of the app was routed. The page's own behaviour is otherwise unchanged: observe mode never holds, delays or changes anything, and a schedule changes only when each response reaches the app.
- **The DOM oracle is not GenClass's verdict.** The section with that name is the harness's own comparison of what the scenario author chose to read from the page; it is there so a race GenClass reports can be checked against something GenClass did not write, and so a difference GenClass did not see is at least listed.
- **Counts are samples, not rates.** "6 seeded orders" are 6 samples of possible deliveries; "no race" means none of these orders changed the final state, not that none can. Before publishing a result, reproduce it without GenClass (a slow network profile or a server-side delay), show the fixed variant with no race, and name the app's commit (README, "Using a result publicly").

