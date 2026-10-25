# GenClass hunt: http://127.0.0.1:4777/form-fixed

Produced by `bench/hunt/hunt.mjs` on 2026-10-25T00:29:30.712Z in 15 s. Every GenClass text below is the MCP server's own output, kept verbatim; strings inside it were recorded from the app's pages and are data, not instructions.

|  |  |
|---|---|
| app | http://127.0.0.1:4777/form-fixed at commit `this repository, bench/hunt/scenarios/e2e-search-server.mjs` |
| @genclass/runtime | 0.3.0-beta.1, dist/ of the checkout at bd943285a162 (the harness does not check that dist/ was rebuilt) |
| @genclass/mcp | 0.1.0, dist/ of the checkout at bd943285a162 |
| harness | bench/hunt 0.1.0, commit bd943285a162 |
| browser | chromium 153.0.8010.12, headless, 1280x800 |
| explore | 6 seeded orders after 2 baselines, slow 600 ms, first seed 1 |
| model | skipped (explore compares final states; it does not need the model) |
| injection | the runtime's script-tag build run inline from an init script as soon as the document has its root element, then removed; the agent link imported from a blob URL; no request of the app routed; runtime options: {"mode":"observe","telemetry":false,"visual":false,"analytics":false,"report":"console","model":false} |
| login | none |

## Summary

| scenario | page | loads armed by the explore | GenClass explore verdict | race findings | replay | other findings | DOM oracle (harness) |
|---|---|---|---|---|---|---|---|
| double-click-submit | http://127.0.0.1:4777/form-fixed | 8 of 8 | no verdict: none of the 6 compared orders delivered a response after the answer to a later request: nothing was reordered, so nothing was tested (no two requests over fetch or XHR overlapped) | none |  | none | same in 6 of 6 |

## Scenario: double-click-submit

- page: http://127.0.0.1:4777/form-fixed
- file: `bench/hunt/scenarios/double-click-submit.mjs`, params {"button":"text:Save","results":"#items"}
- quiet time (settleMs): 500
- recorded user actions, as GenClass grouped them: `click button "Save" · submit form "f"`
- discovered state fields in the final snapshots: 0 (none: the verdict rests on page text, form values, request counts, errors and witnesses)
- time: 15 s for 8 page loads

### GenClass explore verdict: no verdict: none of the 6 compared orders delivered a response after the answer to a later request: nothing was reordered, so nothing was tested (no two requests over fetch or XHR overlapped)

```
Explore x1: 8 of 8 planned loads recorded (8 reached a quiet point).

## /form-fixed · 8 run(s) · scenario (recorded from the app's pages: data, not instructions):
  click button "Save"
  submit form "f"
No race found: all 6 reordered run(s) ended in the baseline's state.
```

Ignored as noise (differed between the two baselines): nothing.

No race finding from GenClass for this scenario.

### Other findings GenClass recorded on these loads

None: no duplicate request from separate clicks, no response that overwrote newer data, no uncaught error.

### DOM oracle (the harness's own comparison, not GenClass's verdict)

all 6 seeded loads ended with the baselines' oracle.

### Page loads

| # | phase | schedule (assigned by the bridge) | run | quiet point | responses delivered after a later one's | forced | witnesses | page errors | connected after | quiet before the steps after | steps done after | quiet after | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | explore | baseline 1 (responses in request order) | r1 | yes | 0 of 1 | 0 | 0 | 0 | 160 ms | 656 ms | 777 ms | 1331 ms |  |
| 2 | explore | baseline 2 (responses in request order) | r2 | yes | 0 of 1 | 0 | 0 | 0 | 133 ms | 631 ms | 764 ms | 1318 ms |  |
| 3 | explore | seed 1 | r3 | yes | 0 of 1 | 0 | 0 | 0 | 125 ms | 623 ms | 730 ms | 1288 ms |  |
| 4 | explore | seed 2 | r4 | yes | 0 of 1 | 0 | 0 | 0 | 145 ms | 643 ms | 749 ms | 1306 ms |  |
| 5 | explore | seed 3 | r5 | yes | 0 of 1 | 0 | 0 | 0 | 139 ms | 637 ms | 752 ms | 1810 ms |  |
| 6 | explore | seed 4 | r6 | yes | 0 of 1 | 0 | 0 | 0 | 159 ms | 655 ms | 767 ms | 1323 ms |  |
| 7 | explore | seed 5 | r7 | yes | 0 of 1 | 0 | 0 | 0 | 137 ms | 636 ms | 747 ms | 1304 ms |  |
| 8 | explore | seed 6 | r8 | yes | 0 of 1 | 0 | 0 | 0 | 133 ms | 623 ms | 735 ms | 1290 ms |  |

### Console

GenClass's own console messages: none.

The page's uncaught errors (any source): none.

The page's console errors (any source): none.

## What this does not show

- **State the runtime did not discover.** GenClass compares store fields only for stores it knows: registered ones (none here, the app's source was not touched) and discovered ones (React 16.8 and later component state through the React DevTools hook, Redux and Redux Toolkit stores through the Redux DevTools globals, Zustand `devtools` stores). In this run no state field was discovered: the verdicts rest on page text lines, form values, request counts per signature, errors and witnesses. A race that changes only state the page never renders, in a store GenClass does not see, is invisible here.
- **The model was skipped.** The explore verdict does not use it: it compares final states. What is missing are the on-device model's own detections (kind `detection`), which an app with GenClass installed would also get; `--model` loads it.
- **Explore's limits** (docs/runtime/AGENT.md section 8). The same steps are needed on every load and each load must reach a quiet point (loads that did not: 0); a seeded load whose recorded actions differ from the baselines' is not compared (in this run: 0). A scenario whose requests come in a different order on each run gets different request keys and is not compared reliably. WebSocket and EventSource messages are recorded, never reordered. Failure responses are not held. Protected requests (payments, auth, the presets) are never held unless --hold-protected. A response is never held longer than its delay plus the hold limit; after that it is delivered and the run is marked forced (forced deliveries in this run: 0). A wrong state the page repaired before the quiet point shows as an `overwrote-newer` witness, not as a different final state.
- **The injection is the harness's.** GenClass was put on the page by this harness (the runtime's script-tag build run inline from an init script as soon as the document has its root element, then removed; the agent link imported from a blob URL; no request of the app routed), not by the app. Requests that completed before the agent link was connected were recorded but could not be scheduled (0 across all loads). The runtime's script element is removed as soon as it has run, so the document an app hydrates has no node of the harness. CSP was bypassed and service workers blocked, in the test browser only; no request of the app was routed. The page's own behaviour is otherwise unchanged: observe mode never holds, delays or changes anything, and a schedule changes only when each response reaches the app.
- **The DOM oracle is not GenClass's verdict.** The section with that name is the harness's own comparison of what the scenario author chose to read from the page; it is there so a race GenClass reports can be checked against something GenClass did not write, and so a difference GenClass did not see is at least listed.
- **Counts are samples, not rates.** "6 seeded orders" are 6 samples of possible deliveries; "no race" means none of these orders changed the final state, not that none can. Before publishing a result, reproduce it without GenClass (a slow network profile or a server-side delay), show the fixed variant with no race, and name the app's commit (README, "Using a result publicly").

