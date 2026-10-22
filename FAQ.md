# GenClass Runtime: questions and answers

Short answers to the questions developers ask about GenClass Runtime, for `@genclass/runtime` 0.3.0-beta.0 (npm
`beta`) and 0.2.2 (npm `latest`; the dist-tags on 2026-10-22), both with the model
`@genclass/runtime-model@0.2.0`. Each answer comes first and the link after it has the details. Every measured number
is from
[RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md) (the compatibility
details from [compat/RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md)), which
say how and on what each was measured; defaults and limits come from the code. The headline numbers are under
[current numbers in one place](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#current-numbers-in-one-place).

## What is GenClass Runtime?

GenClass Runtime (`@genclass/runtime`) is an open-source (Apache-2.0) browser library that reports race conditions
in web apps while they happen: stale responses that land over newer data, duplicate requests such as double submits,
inconsistent state and failure storms. A small model runs on the user's device, in a Web Worker on WebGPU or WASM,
and each report comes with its evidence. By default it only reports (`observe`): it never holds, delays or changes a
request, a response or a state write. The opt-in `guard` mode may act on a few of them
([how often](#can-it-prevent-these-bugs-or-only-report-them)), and `heal` is experimental.

Details: [README](https://github.com/genclass-dev/GenClass-lib#readme),
[package README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md).

## How do I find race conditions in a React app?

Fix the ones you know in code: cancel the previous request in the effect's cleanup (an `AbortController` or an
ignore flag), or compare a request id. To find the rest while the app runs, put `import "@genclass/runtime/auto"`
first in your entry file. React component state is found automatically, and in `observe` each detection prints one
console line with its evidence.

Details: [guide: race conditions in React](https://genclass.dev/guides/race-conditions-react),
[what a detection looks like](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#what-it-looks-like).

## Why does my search box show results for an older query?

The response for an earlier keystroke arrived after the latest one's and overwrote it. Debouncing makes this rarer,
not impossible: cancel the older request, or ignore a response whose query is no longer current. GenClass can report
this as a stale response when it sees the state the response writes: with `/auto` or the script tag, React and Redux
state and Zustand stores with the `devtools` middleware are found automatically; register other state with `rt.atom`
or `rt.guard`. In `guard`, for state it can write, it can drop the stale write when its gate clears.

Details: [guide: stale responses out of order](https://genclass.dev/guides/stale-responses-out-of-order),
[state it can protect](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#state-it-can-protect).

## Is AbortController enough to stop stale responses?

For the requests you wire it to, yes: an aborted request's late response never reaches your state. It does not
cover requests you did not wire, or WebSocket and EventSource messages. GenClass watches fetch, XHR, WebSocket and
EventSource for writes over newer data, but it misses most stale overwrites, so it does not replace the fix.

Details: [How accurate is it?](#how-accurate-is-it)

## How do I stop a double click from submitting a form twice?

Disable the submit button while the request is in flight, and send an idempotency key that the server checks, so a
repeat creates nothing. GenClass reports a repeated request as `duplicate`: at the default profile it detected 75% of
duplicate submits on held-out real apps with the right diagnosis, under a false-detection limit of 2% per clean
decision that held on held-out test. The 0.3.0 changes to observe were not measured end to end (§11).

Details: [guide: prevent duplicate submissions](https://genclass.dev/guides/prevent-duplicate-submissions),
[RESULTS.md §11](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#observe-detection).

## Does GenClass change what my app does?

Not in `observe`, the default: it never holds, delays or changes a request, a response or a state write. Its own
work can still shift timing. In the compatibility matrix (an unpublished 0.1.0-beta.4 build with model 0.2.0,
2026-10-10; not re-run on 0.2.2 or 0.3.0) it introduced 0 bugs in 3,510 runs. In 4 runs an app's own bug did not
show with GenClass although it took no action (1 in observe, 3 in guard or heal: its own work shifted the timing of
the app's race), and in 38 more guard and heal runs where the bug showed without GenClass, it still showed but the
page or server ended in a different state. `guard` and `heal` act only when their gate clears.

Details: [RESULTS.md §16](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#16-compatibility-matrix-summary),
[INTERCEPTION.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/INTERCEPTION.md).

## How accurate is it?

At `balanced` (the default), on held-out real apps, it detected 75% of duplicate submits, 30% of stale overwrites
(on the `situation-v2.3` slice the current runtime renders; 21% on `situation-v2`) and 6% of broken state with the
right diagnosis. The report gate was fitted on development data to at most 2% false detections per clean decision
(3% on simulated apps) and met that limit on held-out test; the exact rate is not published. In 0.3.0, three observe
fixes (superseded writes, the response-body wait, the idle unload) can add likely reports, false ones included, at a
rate not measured. Guard acted on 7.5% of real-app cases where acting would help, with 0.00% false interventions
there, and on 7.8% of clear simulated cases with 0.13%.

In 0.3.0-beta.0, observe also records *possible* detections by default, at the `eager` gate (0.70), to
`console.debug`, the devtools and telemetry. Likely and possible together are expected to match the `eager`
profile's offline rates (77% of duplicate submits, 45% of stale overwrites, 40% on `situation-v2`, and 13% of broken
state; false-detection limit 5% on real apps and 6% on simulated, met on held-out test). This was not measured end to
end on 0.3.0; how many false detections the possible tier adds, and what share of possible detections is false, are
not measured.

Details: [Measured results](https://github.com/genclass-dev/GenClass-lib#measured-results),
[current numbers in one place](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#current-numbers-in-one-place) (RESULTS.md §1, §11).

## Can it prevent these bugs, or only report them?

Mostly report. `guard` (opt-in) can discard a stale write, defer a response, or coalesce or delay a request, only
when the model's gate clears, which with the shipped model is rare. In the compatibility matrix (an unpublished
0.1.0-beta.4 build with model 0.2.0, 2026-10-10; not re-run on 0.2.2 or 0.3.0), of 250 runs where an app's own bug
showed, guard left 249 buggy and heal 240 (its 10 fixes were all `block` on one data layer); guard and heal took 0
actions on correct apps in 1,760 runs. In the six demos under network chaos no mode lowered the bug rate (72% without
GenClass, 70% observe, 72% guard, 73% heal; differences under about 5 points are noise; runtime 0.1.0-beta.4, model
0.2.0), with 0 false interventions in 30 clean trials each in guard and heal.

Details: [Modes](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#modes),
[RESULTS.md §16](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#16-compatibility-matrix-summary).

## Which frameworks and data libraries does it work with?

It wraps the browser's network APIs, DOM events and timers, so it needs no framework. The compatibility matrix ran
React 19, Next.js 16, Vue 3, SvelteKit 3, Angular 22, Solid 1.9 and plain HTML with 15 data layers in every mode,
in Chromium only: 0 bugs introduced in 3,510 runs. It tested an unpublished 0.1.0-beta.4 build (commit `d04eff3`,
which does not contain 0.2.0's audit trail, protect presets, hold-budget ceilings and invariant fixes, committed on
another branch, and predates 0.2.1's first-request hold and telemetry defaults) with model 0.2.0 on 2026-10-10, and
has not been re-run on 0.2.2 or 0.3.0. With `/auto` or the script tag, React and Redux state is found
automatically, and so are Zustand stores with the `devtools` middleware (in production builds only with
`devtools(..., { enabled: true })`: found in 240 of 240 runs with it, 0 of 240 without). With `GenClass.init()`,
import `@genclass/runtime/discover` first and pass `autoState: true`. Vue / Pinia, Svelte stores, signals, MobX,
Jotai and Recoil are not discovered: register such state with `rt.atom` / `rt.guard`.

Details: [compat/RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md),
[automatic state discovery](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#automatic-state-discovery).

## How much does it add to my page?

About 108 KB of JavaScript (minified, gzip) on every page for `@genclass/runtime/auto` in 0.3.0-beta.0 (99 KB in
0.2.2), 100 KB for the main entry (92 KB) and 129 KB for the script tag (113 KB). The model loads at idle: about
13 MB downloaded once on WASM, then cached, and +190 to 280 MB of renderer memory while loaded (one pilot app,
runtime 0.1.0-beta.3). From 0.3.0, devices reporting 2 GB of memory or less, and Save-Data connections, skip it.

Details: [RESULTS.md §10](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#first-load)
and [§17](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#17-browser-cost-on-a-pilot-app-2026-10-09-and-2026-10-10),
[Costs](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#costs).

## Does it work without the model, or on phones?

Without a model it keeps observing (console, `rt.status`, devtools), but the model's detections and actions stop;
the measured visual checks and the opt-in flow expectations, which use no model, still run where they are on
(0.3.0). From 0.3.0 the model is not loaded on devices reporting 2 GB of memory or less, nor on Save-Data
connections, and one console line says why. `model.loadIf` changes that rule; `model: false` loads no model at all.
If no Web Worker can start, the model runs on the main thread unless `model: { inlineFallback: false }` (0.3.0; 0.2.x
ignores it and always falls back to the main thread); each model pass then blocks it (about 180 to 600 ms at 500 to
1,170 tokens on one WASM thread, estimated from runs in Node, not in a browser).

Details: [Costs](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#costs),
[Content-Security-Policy and self-hosting](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#content-security-policy-and-self-hosting).

## Does it send my data anywhere?

Decisions are made in the browser; nothing is sent to make one. Anonymous diagnostics are on by default on public
hosts, sent to the GenClass maintainers to improve the model, and off on local hosts from 0.2.2. They carry
GenClass's decisions and counts (in 0.3.0 also its possible detections, as `tier: "possible"`), a random per-page
session id, versions, mode, device class, and the app's hostname and id-normalised path; no page text unless the app
opts in. The collector adds a coarse country and stores no IP address or user agent. With an app token (0.3.0) they
also carry the token and the names of `protect()`ed functions. Opt out with `GenClass.init({ telemetry: false })`
(script tag: `data-telemetry="off"`; meta tag: `telemetry=off`; or `window.GENCLASS_CONFIG = { telemetry: false }`),
`npx @genclass/runtime@beta init --no-telemetry`, `?genclass=no-telemetry` or
`localStorage.setItem("genclass.telemetry", "off")`; Global Privacy Control is honoured.

Details: [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md),
[PRIVACY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md).

## What does it cost? Does it need an API key?

The runtime and model are free, open source (Apache-2.0) and need no API key or server. The plans of the optional
genclass.dev service are defined in `billing/plans.json`, which the collector and the pricing page read, and it
defines two. Free includes the dashboard, data export, forwarding and your own classifier, which GenClass trains on
request. Enterprise, agreed by email, adds GenClass's models in its cloud, a year of history and contract terms.
Nothing is sold on the site. The pricing page shows the plans in force.

Details: [genclass.dev/pricing](https://genclass.dev/pricing),
[billing/plans.json](https://github.com/genclass-dev/GenClass-lib/blob/main/billing/plans.json).

## How is it different from Sentry, Datadog or my tests?

Error trackers and APM collect exceptions, traces and timings; a stale response or a double submit usually throws
nothing they could collect. Tests usually run on fast, ordered networks, where these bugs rarely show.
GenClass looks for them inside the page while people use it, and its reports can go to your own logging.
Use it next to both.

Details: [How GenClass compares](https://github.com/genclass-dev/GenClass-lib#how-genclass-compares).

## Can it explain flaky Playwright tests?

Not as a packaged tool yet. `@genclass/playwright`, a reporter that turns what GenClass flagged in each test into
one markdown report for the pull request, is in this repository but not on npm, and the fixture it reads has not
shipped. Today you can load the runtime in the app under test and read its `[GenClass]` console lines.

Details: [packages/playwright](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/playwright/README.md).

## How do I turn it off or remove it?

`?genclass=off` in the URL installs nothing on that page load; `localStorage.genclass = "off"` does the same until
you remove it. `enabled: false` installs nothing. `rt.disable()` releases anything held and restores what GenClass
wrapped. `npx @genclass/runtime@beta remove` takes out the lines `init` added to your code and uninstalls the package
when nothing else imports it (if you edited a marked line, it changes nothing and lists where). It keeps
`.genclass.local` and its `.gitignore` line, and a dashboard `init` created stays on genclass.dev.
`?genclass=no-telemetry` turns off only the diagnostics.

Details: [INTERCEPTION.md, turning it off](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/INTERCEPTION.md#turning-it-off-and-restoring-the-page).

## How was it measured, and does that apply to my app?

On held-out data never used in training: simulated apps, real apps run in headless Chromium, a compatibility matrix
of seven apps (six frameworks and plain HTML) and six demo apps under network chaos. Each recall is reported next
to its false rate. It was not evaluated on your app, so watch `observe` before turning on `guard`.

Details: [RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md),
[model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md).

## Where can I ask something else?

In [GitHub Discussions](https://github.com/genclass-dev/GenClass-lib/discussions/categories/q-a) or on
[Discord](https://discord.gg/kN9kRnFtZm). Report bugs and false detections in
[Issues](https://github.com/genclass-dev/GenClass-lib/issues); the false-detection template asks for the console
group and `rt.explain(id)`.
