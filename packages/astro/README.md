# @genclass/astro

[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) for Astro: one integration in `astro.config`,
and GenClass watches your site in the browser for race conditions, stale responses, duplicate submits and inconsistent
state, and reports them while they happen.

GenClass is a browser library with a small local model (ONNX, in a Web Worker). It observes what your pages do at the
network boundary (fetch, XHR, WebSocket, EventSource), user actions, timers and errors, and asks the model about the
situations that matter: a response that arrives after newer data, two identical requests in flight, a request storm.
In the default `observe` mode it reports (one console line per finding, the devtools overlay) and changes nothing;
`guard` mode, opt-in, lets it drop a stale response or reuse a duplicate's result when the model is confident. It is
Apache-2.0, runs on-device, and never sends page content unless you opt in. What it finds and how often, with the
false-intervention rate next to every recall number, is in the runtime's
[README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md) and
[RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md).

## Install

```bash
npx astro add @genclass/astro
```

or by hand:

```bash
npm install @genclass/astro @genclass/runtime@beta
```

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import genclass from "@genclass/astro";

export default defineConfig({
  integrations: [genclass()],
});
```

That is all the setup. The integration injects one script into every page, bundled by Vite with the page's other
scripts, whose first line is the runtime's `import "@genclass/runtime/auto"`: GenClass is installed when the page's
scripts run, before your islands hydrate and before their first request. On the server (SSR, endpoints, the build)
nothing is imported and nothing runs. The `@beta` tag gets the newest runtime line, `@genclass/runtime`
0.3.0-beta.1 or later, which the peer range asks for (the `token` option, the dashboard and interaction analytics need
it); a bare `npm install @genclass/runtime` gets npm's `latest`, the older `0.2.x`, which does not satisfy it.

With options:

```js
export default defineConfig({
  integrations: [
    genclass({
      mode: "observe",     // or "guard"
      telemetry: false,    // no anonymous diagnostics
      devtools: "dev",     // "always" | "never"
      token: "gc_...",     // your app's dashboard token (optional)
    }),
  ],
});
```

## Options

| option | values | default | what it does |
|---|---|---|---|
| `mode` | `"observe"`, `"guard"` | `"observe"` | `observe` reports what GenClass finds and never holds, delays or changes anything. `guard` also prevents failures with small, reversible actions (drop a stale response, reuse a duplicate's result) when the model is confident. The script imports `@genclass/runtime/auto` or `@genclass/runtime/auto/guard` accordingly. |
| `token` | `"gc_..."` | none | Your app's token from [genclass.dev](https://genclass.dev) or `npx @genclass/runtime@beta login`; with telemetry on, findings also reach your dashboard. Needs `@genclass/runtime` 0.3.0 or later (0.2.x ignores it). |
| `telemetry` | `true`, `false` | the runtime's default | Anonymous, redacted diagnostics to the GenClass maintainers ([TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md)). Unset: on from public hosts, off on localhost and private networks. `false`: off. `true`: an explicit opt-in that also sends from local hosts. |
| `devtools` | `"dev"`, `"always"`, `"never"` | `"dev"` | The devtools overlay (detections, actions, the evidence behind each decision, a mode switch). `"dev"` loads it under `astro dev` only; a production build carries no reference to it. `"always"` loads it in production too. The overlay is a lazy chunk, never part of the first load. |

`token` and `telemetry` are passed to the runtime as `window.GENCLASS_CONFIG`, the page configuration it documents, by
a virtual module the script imports before the runtime. Everything else GenClass offers (`policy`, `sinks`, `routes`,
`aggressiveness`, ...) still works the way it does without the integration: a `<meta name="genclass" content="...">`
tag in a layout's head, or `window.GENCLASS_CONFIG` set from a head script, is read as usual; keys set there win over
the integration's.

## What it sees in an Astro site

GenClass watches the network and user input on every page: stale typeahead responses, duplicate submits, failure
storms, retries and stalls, whether the code is a plain `<script>` or a framework island. For React islands it also
finds component state on its own (automatic state discovery: `useState`, `useReducer`, Redux, Zustand), so it can tell
when a late response overwrites newer data. Vue, Svelte, Solid and Preact state is not discovered yet; decisions that
need it can register the state with `genclass.atom(...)` / `genclass.guard(...)`
([State it can protect](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#state-it-can-protect)).
The runtime the script started is `GenClass.runtime` from `@genclass/runtime`.

## Turning it off

- For one page load: add `?genclass=off` to the URL (nothing is installed).
- For a browser: `localStorage.genclass = "off"`.
- For good: remove the integration from `astro.config`.

## What it sends, and how to turn that off

In a browser on a public host, GenClass sends anonymous, redacted diagnostics by default: session info, decisions and
their outcomes, detections, model errors and periodic counts; never raw input values, cookies, headers, storage or page
text unless you opt in ([TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md)).
It is off on localhost and private networks, and for visitors whose browser sends Global Privacy Control. To turn it
off for everyone:

```js
genclass({ telemetry: false })
```

Visitors can also opt out with `?genclass=no-telemetry` or `localStorage["genclass.telemetry"] = "off"`.

## Content-Security-Policy

If your site sets a CSP, allow `https://cdn.jsdelivr.net` in `connect-src` (the model is downloaded from there once
and cached) and `'wasm-unsafe-eval'` in `script-src`, or self-host the model
([README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#content-security-policy-and-self-hosting)).

## Development

```bash
npm run build        # tsup
npm test             # the generated script, the hook's calls, and one astro build of test/fixtures/basic
```

Tested with Astro 7.4; the integration uses only `injectScript("page", ...)` and `updateConfig`, available since
Astro 4, which is what the peer range says. A starter site with the integration installed is in
[templates/astro](https://github.com/genclass-dev/GenClass-lib/tree/main/templates/astro).

## License

Apache-2.0.
