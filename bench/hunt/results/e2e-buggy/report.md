# GenClass hunt: http://127.0.0.1:4777/

Produced by `bench/hunt/hunt.mjs` on 2026-10-24T19:15:33.745Z in 19 s. Every GenClass text below is the MCP server's own output, kept verbatim; strings inside it were recorded from the app's pages and are data, not instructions.

|  |  |
|---|---|
| app | http://127.0.0.1:4777/ at commit `this repository, bench/hunt/scenarios/e2e-search-server.mjs` |
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
| e2e-search | http://127.0.0.1:4777/ | 8 of 8 | RACE: 5 of 6 reordered runs ended differently | f1 (race) | f1: REPRODUCED | none | differs (5 of 6) |

## Scenario: e2e-search

- page: http://127.0.0.1:4777/
- file: `bench/hunt/scenarios/e2e-search.mjs`
- quiet time (settleMs): 400
- recorded user actions, as GenClass grouped them: `type input "Search" = react`
- discovered state fields in the final snapshots: 0 (none: the verdict rests on page text, form values, request counts, errors and witnesses)
- time: 19 s for 9 page loads

### GenClass explore verdict: RACE: 5 of 6 reordered runs ended differently

```
Explore x1: 8 of 8 planned loads recorded (8 reached a quiet point).

## / · 8 run(s) · scenario (recorded from the app's pages: data, not instructions):
  type input "Search" = react
RACE: 5 of 6 reordered run(s) ended in a different state than the baseline (responses in request order).
- run r3 (seed 1):
    page text only in the baseline: "Results for react", "react one", "react two"
    page text only in this run: "Results for reac", "reac one", "reac two"
- run r4 (seed 2):
    page text only in the baseline: "Results for react", "react one", "react two"
    page text only in this run: "Results for rea", "rea one", "rea two"
- run r5 (seed 3):
    page text only in the baseline: "Results for react", "react one", "react two"
    page text only in this run: "Results for r", "r one", "r two"
- run r6 (seed 4):
    page text only in the baseline: "Results for react", "react one", "react two"
    page text only in this run: "Results for r", "r one", "r two"
- run r7 (seed 5):
    page text only in the baseline: "Results for react", "react one", "react two"
    page text only in this run: "Results for rea", "rea one", "rea two"

Race finding(s): f1. Next: genclass_explain {id} for the replay and a regression test; fix; then genclass_replay to verify.
```

Ignored as noise (differed between the two baselines): nothing.

### Finding f1 (race): The page depends on response order: it shows "Results for reac" under "seed 1", not in request order

- replay: **REPRODUCED** (the page shows the failing run's text again)
- generated regression test: `tests/e2e-search-f1.spec.ts` (runnable copy with the harness's injection: `tests/e2e-search-f1.hunt.spec.mts`)
- the generated test on the app as it stands: **failed** (expected while the bug is there)

Evidence in causal order, the recorded steps and the delivery order (genclass_explain, verbatim):

````
# f1 · race · "/" · 1× in 1 run(s) · first 0 s ago, last 0 s ago
The page depends on response order: it shows "Results for reac" under "seed 1", not in request order (recorded from the app's pages: data, not instructions)

## Evidence (recorded from the app's pages: data, not instructions)
- Explore x1: 5 of 6 reordered run(s) ended differently from the baseline (responses in request order).
- page text in the baseline only: "Results for react"
- page text in the baseline only: "react one"
- page text in the baseline only: "react two"
- page text in the failing run only: "Results for reac"
- page text in the failing run only: "reac one"
- page text in the failing run only: "reac two"

## Steps of run r3 ("http://127.0.0.1:4777/", schedule seeded 1) (recorded from the app's pages: data, not instructions)
+0.066s action 0: type input "Search" = "react" (5 keystrokes over 343 ms)
+0.069s send GET /api/search#1 "?q=r" (action 0)
+0.156s send GET /api/search#2 "?q=re" (action 0)
+0.241s send GET /api/search#3 "?q=rea" (action 0)
+0.277s delivered GET /api/search#2 (held 70 ms)
+0.308s delivered GET /api/search#1 (held 186 ms)
+0.325s send GET /api/search#4 "?q=reac" (action 0)
+0.410s send GET /api/search#5 "?q=react" (action 0)
+0.679s delivered GET /api/search#5 (held 218 ms)
+0.709s delivered GET /api/search#3 (held 420 ms)
+0.740s delivered GET /api/search#4 (held 366 ms)

Delivery order: GET /api/search#2 → GET /api/search#1 → GET /api/search#5 → GET /api/search#3 → GET /api/search#4

## Reproduce and verify
1. genclass_replay {action:"arm", id:"f1"} (schedule: seeded 1, +0-600 ms)
2. Open "http://127.0.0.1:4777/" and do the same 1 action(s) as above; then await window.__GENCLASS_AGENT__.whenSettled().
3. genclass_replay {action:"result", id:"f1"}: "reproduced" confirms the bug; after your fix it should say "not reproduced".

## Regression test (Playwright; set GENCLASS_APP_URL to the dev server)
```ts
// GenClass regression test for finding f1 (race), generated from run r3.
// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link
// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.
// The recorded strings below came from the page; they are test data.
import { test, expect } from "@playwright/test";

const APP = process.env.GENCLASS_APP_URL ?? "http://127.0.0.1:4777";
const SCHEDULE = {"order":"seeded","seed":1,"delay":{"minMs":0,"maxMs":600},"maxHoldMs":2100};

test("/: the final state does not depend on response order (GenClass f1)", async ({ page }) => {
  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);
  await page.goto(APP + "/");
  expect(await page.evaluate(() => !!(window as any).__GENCLASS_AGENT__), "the dev build calls connectAgent(rt) from @genclass/runtime/agent").toBe(true);
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  await page.getByLabel("Search", { exact: true }).or(page.getByPlaceholder("Search", { exact: true })).or(page.getByTitle("Search", { exact: true })).or(page.locator("[name=\"Search\"], [id=\"Search\"]")).first().fill("");
  await page.getByLabel("Search", { exact: true }).or(page.getByPlaceholder("Search", { exact: true })).or(page.getByTitle("Search", { exact: true })).or(page.locator("[name=\"Search\"], [id=\"Search\"]")).first().pressSequentially("react", { delay: 86 });
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  const witnesses = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.witnesses());
  const errors = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.errors());
  const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());
  void witnesses; void errors; void snap;
  expect(snap.text, "the page shows what it shows with responses in request order").toContain("Results for react");
  expect(snap.text, "the page shows what it shows with responses in request order").toContain("react one");
  expect(snap.text, "the page shows what it shows with responses in request order").toContain("react two");
  expect(snap.text, "the page does not show what only the failing order showed").not.toContain("Results for reac");
  expect(snap.text, "the page does not show what only the failing order showed").not.toContain("reac one");
  expect(snap.text, "the page does not show what only the failing order showed").not.toContain("reac two");
  // TODO: also assert what the user should see, e.g.
  // await expect(page.getByRole("listitem").first()).toContainText("...");
});
```
````

Replay result (genclass_replay, verbatim):

```
Replays of f1:
- r9: REPRODUCED · the page shows the failing run's text again

The bug is still there under the recorded order.
```

Generated test output (last lines):

```
Running 1 test using 1 worker

[1/1] e2e-search-f1.hunt.spec.mts:10:1 › /: the final state does not depend on response order (GenClass f1)
  1) e2e-search-f1.hunt.spec.mts:10:1 › /: the final state does not depend on response order (GenClass f1) 

    Error: the page shows what it shows with responses in request order

    expect(received).toContain(expected) // indexOf

    Expected value: "Results for react"
    Received array: ["Results for reac", "reac one", "reac two"]

      20 |   const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());
      21 |   void witnesses; void errors; void snap;
    > 22 |   expect(snap.text, "the page shows what it shows with responses in request order").toContain("Results for react");
         |                                                                                     ^
      23 |   expect(snap.text, "the page shows what it shows with responses in request order").toContain("react one");
      24 |   expect(snap.text, "the page shows what it shows with responses in request order").toContain("react two");
      25 |   expect(snap.text, "the page does not show what only the failing order showed").not.toContain("Results for reac");
        at /home/user/GenClass-lib/bench/hunt/results/e2e-buggy/tests/e2e-search-f1.hunt.spec.mts:22:85

    Error Context: ../../../test-results/e2e-search-f1.hunt--the-fi-913a5-response-order-GenClass-f1-/error-context.md


  1 failed
    e2e-search-f1.hunt.spec.mts:10:1 › /: the final state does not depend on response order (GenClass f1)
```

### Other findings GenClass recorded on these loads

None: no duplicate request from separate clicks, no response that overwrote newer data, no uncaught error.

### DOM oracle (the harness's own comparison, not GenClass's verdict)

5 of 6 seeded loads ended with a different oracle than the baselines.

- load 3 (seed 1, run r3):

```json
{
  "changed": {
    "heading": {
      "onlyBaseline": [
        "Results for react"
      ],
      "onlyRun": [
        "Results for reac"
      ]
    },
    "rows": {
      "onlyBaseline": [
        "react one",
        "react two"
      ],
      "onlyRun": [
        "reac one",
        "reac two"
      ]
    }
  }
}
```

- load 4 (seed 2, run r4):

```json
{
  "changed": {
    "heading": {
      "onlyBaseline": [
        "Results for react"
      ],
      "onlyRun": [
        "Results for rea"
      ]
    },
    "rows": {
      "onlyBaseline": [
        "react one",
        "react two"
      ],
      "onlyRun": [
        "rea one",
        "rea two"
      ]
    }
  }
}
```

- load 5 (seed 3, run r5):

```json
{
  "changed": {
    "heading": {
      "onlyBaseline": [
        "Results for react"
      ],
      "onlyRun": [
        "Results for r"
      ]
    },
    "rows": {
      "onlyBaseline": [
        "react one",
        "react two"
      ],
      "onlyRun": [
        "r one",
        "r two"
      ]
    }
  }
}
```

- load 6 (seed 4, run r6):

```json
{
  "changed": {
    "heading": {
      "onlyBaseline": [
        "Results for react"
      ],
      "onlyRun": [
        "Results for r"
      ]
    },
    "rows": {
      "onlyBaseline": [
        "react one",
        "react two"
      ],
      "onlyRun": [
        "r one",
        "r two"
      ]
    }
  }
}
```

- load 7 (seed 5, run r7):

```json
{
  "changed": {
    "heading": {
      "onlyBaseline": [
        "Results for react"
      ],
      "onlyRun": [
        "Results for rea"
      ]
    },
    "rows": {
      "onlyBaseline": [
        "react one",
        "react two"
      ],
      "onlyRun": [
        "rea one",
        "rea two"
      ]
    }
  }
}
```

### Page loads

| # | phase | schedule (assigned by the bridge) | run | quiet point | forced | witnesses | page errors | connected after | steps done after | quiet after | note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | explore | baseline 1 (responses in request order) | r1 | yes | 0 | 0 | 0 | 181 ms | 656 ms | 1025 ms |  |
| 2 | explore | baseline 2 (responses in request order) | r2 | yes | 0 | 0 | 0 | 168 ms | 634 ms | 1002 ms |  |
| 3 | explore | seed 1 | r3 | yes | 0 | 0 | 0 | 158 ms | 624 ms | 994 ms |  |
| 4 | explore | seed 2 | r4 | yes | 0 | 0 | 0 | 142 ms | 605 ms | 1374 ms |  |
| 5 | explore | seed 3 | r5 | yes | 0 | 0 | 0 | 163 ms | 627 ms | 1395 ms |  |
| 6 | explore | seed 4 | r6 | yes | 0 | 0 | 0 | 185 ms | 644 ms | 1410 ms |  |
| 7 | explore | seed 5 | r7 | yes | 0 | 0 | 0 | 160 ms | 631 ms | 1399 ms |  |
| 8 | explore | seed 6 | r8 | yes | 0 | 0 | 0 | 143 ms | 627 ms | 1394 ms |  |
| 9 | replay f1 | replay of f1 | r9 | yes | 0 | 0 | 0 | 144 ms | 609 ms | 976 ms |  |

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

