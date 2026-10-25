# GenClass + Astro starter

An Astro 7 site with [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) installed the
recommended way for Astro: the [`@genclass/astro`](https://www.npmjs.com/package/@genclass/astro) integration, one
line in `astro.config.mjs`.

```bash
npm install
npm run dev                  # http://localhost:4321, with the GenClass devtools overlay
npm run build && npm start   # production build (no overlay), served by the Node adapter
```

Type a city quickly in the search box. The API route (`src/pages/api/search.ts`) answers in a random 50-900 ms, so
an older answer can overwrite a newer one: the classic stale typeahead. Open the overlay (bottom right) to see what
GenClass noticed; the browser console has one plain-English line per finding.

## The one line

`astro.config.mjs`:

```js
import genclass from "@genclass/astro";

export default defineConfig({ integrations: [genclass()] });
```

The integration injects `import "@genclass/runtime/auto"` into every page as a script Vite bundles with the page's
other scripts, so GenClass is installed before your islands hydrate and before their first request. It runs in the
browser only: the build, endpoints and server rendering are untouched. It watches fetch, XHR, WebSocket, EventSource,
user input and timers; in React islands it also finds component state on its own (automatic state discovery).
`npx @genclass/runtime@beta init` installs GenClass in an existing Astro project without the integration (a `<script>` line
in your layout's head); `npx astro add @genclass/astro` adds the integration.

**What it sees here.** This starter has no framework island: the search box is a plain `<script>`, so GenClass works
from the network and user input: stale typeahead responses, duplicate submits, failure storms, retries and stalls.
Decisions that compare a late response with newer data already in your state need that state registered
(`genclass.atom(...)` / `genclass.guard(...)`, see
[State it can protect](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#state-it-can-protect)),
or a React island, whose state is discovered.

## Observe, then guard

| mode | config | what it does |
|---|---|---|
| observe (default) | `genclass()` | reports what it finds; never holds, drops or changes anything |
| guard | `genclass({ mode: "guard" })` | also prevents failures with small, reversible actions (drop a stale response, reuse a duplicate's result) when its model is confident |

Start in observe, watch the overlay and the console for a while on real traffic, then switch to `guard`. Every action
is logged with its evidence, and the overlay can undo it.

## Devtools overlay

The integration loads the overlay under `astro dev` only (`devtools: "dev"`, the default); a production build carries
no reference to it. `genclass({ devtools: "always" })` loads it in production too, `"never"` not at all.

## Turning it off

- For one page load: add `?genclass=off` to the URL (nothing is installed).
- For a browser: `localStorage.genclass = "off"`.
- For good: remove the integration from `astro.config.mjs`.

## Privacy

In a browser, GenClass sends anonymous, redacted diagnostics by default
([TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md)).
To turn that off, pass the option in `astro.config.mjs`:

```js
integrations: [genclass({ telemetry: false })],
```

## Compatibility

Astro 7 with the Node adapter (standalone). The integration needs Astro 4 or later; the frameworks behind the other
templates are covered by the [compatibility matrix](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md).
