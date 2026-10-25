# @genclass/nuxt

[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) for Nuxt 3 and 4: one module entry in
`nuxt.config`, and GenClass watches your app in the browser for race conditions, stale responses, duplicate submits
and inconsistent state, and reports them while they happen.

GenClass is a browser library with a small local model (ONNX, in a Web Worker). It observes what your app does at
the network boundary (fetch, XHR, WebSocket, EventSource), user actions, timers and errors, and asks the model about
the situations that matter: a response that arrives after newer data, two identical requests in flight, a request
storm. In the default `observe` mode it reports (one console line per finding, the devtools overlay) and changes
nothing; `guard` mode, opt-in, lets it drop a stale response or reuse a duplicate's result when the model is confident.
It is Apache-2.0, runs on-device, and never sends page content unless you opt in. What it finds and how often, with
the false-intervention rate next to every recall number, is in the runtime's
[README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md) and
[RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md).

## Install

```bash
npm install @genclass/nuxt @genclass/runtime@beta
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@genclass/nuxt"],
});
```

That is all the setup. The module adds one client-only plugin, placed before your own plugins, whose first line is the
runtime's `import "@genclass/runtime/auto"`: GenClass is installed when the entry chunk runs, before Nuxt creates the
app and before any component's first request. On the server (SSR, Nitro routes, prerendering) nothing is imported and
nothing runs. The `@beta` tag gets the newest runtime line, `@genclass/runtime`
0.3.0-beta.1 or later, which the peer range asks for (the `token` option, the dashboard and interaction analytics need
it); a bare `npm install @genclass/runtime` gets npm's `latest`, the older `0.2.x`, which does not satisfy it.

With options:

```ts
export default defineNuxtConfig({
  modules: ["@genclass/nuxt"],
  genclass: {
    mode: "observe",     // or "guard"
    telemetry: false,    // no anonymous diagnostics
    devtools: "dev",     // "always" | "never"
    token: "gc_...",     // your app's dashboard token (optional)
  },
});
```

## Options

| option | values | default | what it does |
|---|---|---|---|
| `mode` | `"observe"`, `"guard"` | `"observe"` | `observe` reports what GenClass finds and never holds, delays or changes anything. `guard` also prevents failures with small, reversible actions (drop a stale response, reuse a duplicate's result) when the model is confident. The plugin imports `@genclass/runtime/auto` or `@genclass/runtime/auto/guard` accordingly. |
| `token` | `"gc_..."` | none | Your app's token from [genclass.dev](https://genclass.dev) or `npx @genclass/runtime@beta login`; with telemetry on, findings also reach your dashboard. Needs `@genclass/runtime` 0.3.0 or later (0.2.x ignores it). |
| `telemetry` | `true`, `false` | the runtime's default | Anonymous, redacted diagnostics to the GenClass maintainers ([TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md)). Unset: on from public hosts, off on localhost and private networks. `false`: off. `true`: an explicit opt-in that also sends from local hosts. |
| `devtools` | `"dev"`, `"always"`, `"never"` | `"dev"` | The devtools overlay (detections, actions, the evidence behind each decision, a mode switch). `"dev"` loads it in `nuxt dev` only; a production build carries no reference to it. `"always"` loads it in production too. The overlay is a lazy chunk, never part of the first load. |

`token` and `telemetry` are passed to the runtime as `window.GENCLASS_CONFIG`, the page configuration it documents, by
a small module the plugin imports before the runtime. Everything else GenClass offers (`policy`, `sinks`, `routes`,
`aggressiveness`, ...) still works the way it does without the module: a `<meta name="genclass" content="...">` tag in
the head, or `window.GENCLASS_CONFIG` set from a head script, is read as usual; keys set there win over the module's.

## What it sees in a Nuxt app

Automatic state discovery covers React, Redux and Zustand, not Vue refs or Pinia yet, so in a Nuxt app GenClass works
from the network and user input: stale typeahead responses, duplicate submits, failure storms, retries and stalls.
Decisions that compare a late response with newer data already in your state need that state registered
(`genclass.atom(...)` / `genclass.guard(...)`, see
[State it can protect](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#state-it-can-protect)).
The runtime the plugin started is `GenClass.runtime` from `@genclass/runtime`.

## Turning it off

- For one page load: add `?genclass=off` to the URL (nothing is installed).
- For a browser: `localStorage.genclass = "off"`.
- For good: remove the module from `nuxt.config`.

## What it sends, and how to turn that off

In a browser on a public host, GenClass sends anonymous, redacted diagnostics by default: session info, decisions and
their outcomes, detections, model errors and periodic counts; never raw input values, cookies, headers, storage or page
text unless you opt in ([TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md)).
It is off on localhost and private networks, and for visitors whose browser sends Global Privacy Control. To turn it
off for everyone:

```ts
genclass: { telemetry: false }
```

Visitors can also opt out with `?genclass=no-telemetry` or `localStorage["genclass.telemetry"] = "off"`.

## Development

```bash
npm run dev          # the playground (playground/: a search box and a mock API that answers out of order)
npm run build        # nuxt-module-build
npm test             # the generated code, and one production build of test/fixtures/basic
```

Built with `@nuxt/kit` 4 and tested with Nuxt 4.6. The module declares `nuxt: ">=3.17.0"`; Nuxt 3 is not tested.
A starter app with the module installed is in
[templates/nuxt](https://github.com/genclass-dev/GenClass-lib/tree/main/templates/nuxt).

## License

Apache-2.0.
