# Sinks: GenClass findings in your own logs and endpoints

How to send GenClass's detections, interventions and other records to your own side: the `console-json` and
`webhook` adapters, sinks by name in the zero-code setups, a sink of your own, what a record holds and what the webhook
sends. For `@genclass/runtime` 0.3.0 (`0.3.0-beta.0` on the npm `beta` dist-tag). The option reference is in
[API.md](API.md#see-it-where-you-already-look) and [OPTIONS-SPEC.md](OPTIONS-SPEC.md) (§4.11).

## Which versions have sinks?

The `sinks` option, with a function or a `{ send }` object of your own, exists since `0.1.0-beta.1`. The ready-made
`console-json` and `webhook` adapters, sinks by name (`data-sink`, `sink=`, `init --sink`, names in
`GENCLASS_CONFIG.sinks`), the `possible` option and `check` records are `0.3.0` and later. `0.2.x` ignores `data-sink`
and `sink=`, stops at `init --sink` with "unknown option", has no `@genclass/runtime/sinks` exports, and prints "a sink
failed" for a sink name in `GENCLASS_CONFIG.sinks`. Pin `0.3.0-beta.0` or later in the script tag to use the adapters.

## Why use a sink?

In production the `[GenClass]` console lines print in your users' browsers, not yours. Sinks send every detection,
intervention, undo, breaker trip and runtime error to your own side as well: one JSON line per record on the console
for a log shipper (`console-json`), batched POSTs to an endpoint you own (`webhook`), or a function or `{ send }`
object of yours. The records go only where you point them. The console default does not change. Sinks are separate
from GenClass's anonymous diagnostics ([TELEMETRY.md](../../packages/runtime/TELEMETRY.md)): turning those off does
not turn a sink off, and a sink sends nothing to GenClass.

## How do I add a sink without code?

With `/auto` or the script tag you write no adapter code yourself:

```bash
npx @genclass/runtime@beta init --sink webhook:/genclass   # or console-json; repeat it or comma-separate
```

```html
<meta name="genclass" content="sink=webhook:/genclass+console-json">     <!-- + joins names: commas separate the meta keys -->
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.0" data-sink="webhook:/genclass,console-json"></script>
<script>window.GENCLASS_CONFIG = { sinks: ["webhook:https://collector.example/genclass"] };</script>
```

In a project with an entry file `init` writes the names to its option file; on a plain HTML page it sets `data-sink`,
in an Astro layout `sink=` in the meta line. A name loads its adapter on the first record, never before. A `<meta>`
tag only takes a same-origin webhook URL, checked as the browser resolves it (against the page and
`document.baseURI`); a cross-origin one is ignored with a console warning, so put a collector on another origin in
`data-sink` or `window.GENCLASS_CONFIG`. A webhook URL is made absolute once, at init, and only that endpoint (origin
and path) is excluded from what GenClass observes. Add `:noevidence` to `console-json`
(`--sink console-json:noevidence`) to print the structured fields without the evidence text.

## How do I add a sink in code?

Pass the adapters to `GenClass.init`:

```ts
import { GenClass } from "@genclass/runtime";
import { consoleJson } from "@genclass/runtime/sinks/console-json";
import { webhook } from "@genclass/runtime/sinks/webhook";

GenClass.init({
  sinks: [
    consoleJson(),                 // console.log('{"source":"genclass","schema":1,"kind":"detection",...}') for log shippers
    webhook({ url: "/genclass" }), // batched POSTs of { schema: "genclass-sink/1", version, records } to your endpoint
  ],
});
```

`@genclass/runtime/sinks` exports both. Neither adds a dependency or ever throws into your app. Both forward every
record kind except the visual checks' `check` records (below), the per-session `summary` record included, with the
redacted evidence unless you pass `evidence: false`; the webhook caps repeats of one bug at 10 per page load
(`maxPerSignature`, `0` for no cap). Both take `kinds`, `sampleRate`, `possible` and `evidence`. A sink's
`sampleRate` below 1 can drop detections.

A sink of your own is a function or a `{ send }` object. A plain function gets likely detections and every other
record kind except `check`, without evidence. A `{ send }` object takes `kinds`, `sampleRate`, `possible` and
`evidence` (default false, unlike the adapters):

```ts
GenClass.init({
  sinks: [
    { send: (r) => navigator.sendBeacon("/genclass", JSON.stringify(r)),
      kinds: ["intervention", "undo", "breaker", "summary"] },
    { send: (r) => myLogger.info("genclass", r), sampleRate: 0.2 },
  ],
});
```

Observe mode's *possible* detections reach a sink only with `possible: true`; the measured visual checks only when
its `kinds` lists `"check"`.

## What does a sink receive?

The record the runtime built and nothing else: `kind`, `route` (the page path with id-like segments and segments
holding an `@`, such as an e-mail address, as `:id`, as telemetry sends it from 0.3.0), `diagnosis` and its
probability `p`, `action`, `tier`, `trigger`, `mode`, `label`, `reason`, `changed` (state paths), `sessionId` and your
session `tags`, plus the evidence: the console line, the subject and the timeline, with URL query and fragment values
replaced by `…`. Timeline lines can hold short fragments of app data, as the console does (a store value summary, an
error message, text typed into an ordinary input; secret-named fields are `[redacted]`). `evidence: false` on an
adapter sends the structured fields only. A sink never gets the full situation text the model read, request or
response bodies, headers or cookies.

## What does the webhook send?

The webhook POSTs exactly those records as `{ schema: "genclass-sink/1", version, records }`, by
`navigator.sendBeacon` (which GenClass never wraps, and which survives page exit), else `fetch` with `keepalive`; the
body is JSON sent as `text/plain` (no preflight), so parse it as JSON. One POST carries the records GenClass hands
over in one idle-time round, at most 50 records and 32,000 bytes of them, and each round sends at most one: the
browser allows 64 KiB of beacons in flight per page, shared with yours (your analytics on page exit, say), so GenClass
never takes more than about half. What does not fit waits for the next round, and on page hide one last batch goes
(the session summary first) and the rest is dropped. Pass a `clock` and `flushMs` to batch over a time window
instead. `headers` switches it to `fetch`; then list the URL in `requests.ignore` (the zero-code forms do that for
you).

## Can GenClass send findings to Sentry, PostHog or Datadog?

Not from the runtime: it has no adapter for them. For an app in a genclass.dev account, on any plan, Free included
(the `forwarding` entitlement in [`billing/plans.json`](../../billing/plans.json)), the GenClass collector forwards
each likely detection to them (or to Slack, or a signed webhook) once you turn it on in the dashboard
([genclass.dev/pricing](https://genclass.dev/pricing), [DASHBOARD.md](DASHBOARD.md)). Possible detections are not
forwarded. That path uses the anonymous diagnostics, so it needs telemetry on, a token and the app in a GenClass
account: nothing is forwarded for apps without an account. A forwarded record holds the problem type, confidence,
trigger, page route, versions and time, never page text ([TELEMETRY.md](../../packages/runtime/TELEMETRY.md)). The
same diagnosis on the same route goes at most once per UTC hour, and an app sends at most 60 records an hour
(`HOURLY_CAP` in the collector's `telemetry-worker/src/forward.ts`).

A page config that still names `sentry`, `posthog` or `datadog` gets one console warning, and nothing is loaded or
sent for those names; `init --sink sentry` stops with a usage error that says the same.

## What does a sink need from a Content-Security-Policy?

A webhook on another origin needs that origin in `connect-src` (a same-origin path such as `webhook:/genclass` needs
nothing). With the script tag, `data-sink` (or `sink=` / `GENCLASS_CONFIG.sinks`) loads `dist/sinks/<name>.js` and
the chunk the adapters share from the tag's own CDN path, so allow `https://cdn.jsdelivr.net` in `script-src`, or
self-host this package's `dist/` and point `data-base` at it. With `/auto` the adapters are chunks of your own bundle.
