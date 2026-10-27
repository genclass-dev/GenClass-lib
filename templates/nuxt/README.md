# GenClass + Nuxt starter

A Nuxt 4 app with [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) installed the recommended
way for Nuxt: the [`@genclass/nuxt`](https://www.npmjs.com/package/@genclass/nuxt) module, one line in
`nuxt.config.ts`.

```bash
npm install
npm run dev                                     # http://localhost:3000, with the GenClass devtools overlay
npm run build && node .output/server/index.mjs  # production build (no overlay)
```

Type a city quickly in the search box. The API route (`server/api/search.get.ts`) answers in a random 50-900 ms, so
an older answer can overwrite a newer one: the classic stale typeahead. Open the overlay (bottom right) to see what
GenClass noticed; the browser console has one plain-English line per finding.

## The one line

`nuxt.config.ts`:

```ts
export default defineNuxtConfig({ modules: ["@genclass/nuxt"] });
```

The module adds one client-only plugin, before your own plugins, whose first line is `import "@genclass/runtime/auto"`:
GenClass is installed when the entry chunk runs, before Nuxt creates the app and before any component's first request.
It runs in the browser only: server rendering, Nitro routes and prerendering are untouched. It watches fetch, XHR,
WebSocket, EventSource, user input and timers. `npx @genclass/runtime@beta init` installs GenClass in an existing Nuxt
project without the module (a `plugins/genclass.client.ts` with the same line).

**What it sees in a Nuxt app.** Automatic state discovery covers React, Redux and Zustand, not Vue refs or Pinia
yet, so in a Nuxt app GenClass works from the network and user input: duplicate submits, failure storms, retries and
stalls. Decisions that compare a late response with newer data already in your state need that state registered
(`genclass.atom(...)` / `genclass.guard(...)`, see
[State it can protect](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#state-it-can-protect)).

## Observe, then guard

| mode | config | what it does |
|---|---|---|
| observe (default) | `genclass: {}` | reports what it finds; never holds, drops or changes anything |
| guard | `genclass: { mode: "guard" }` | also prevents failures with small, reversible actions (reuse a duplicate's result, back off) when its model is confident |

Start in observe, watch the overlay and the console for a while on real traffic, then switch to `guard`. Every action
is logged with its evidence, and the overlay can undo it.

## Devtools overlay

The module loads the overlay in `nuxt dev` only (`devtools: "dev"`, the default); a production build carries no
reference to it. `genclass: { devtools: "always" }` loads it in production too, `"never"` not at all. Nuxt's own
devtools are turned off in this starter's `nuxt.config.ts` so the page shows one overlay; turn them back on if you
like.

## Turning it off

- For one page load: add `?genclass=off` to the URL (nothing is installed).
- For a browser: `localStorage.genclass = "off"`.
- For good: remove the module from `nuxt.config.ts`.

## Privacy

In a browser, GenClass sends anonymous, redacted diagnostics by default
([TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md)).
To turn that off, pass the option in `nuxt.config.ts`:

```ts
genclass: { telemetry: false },
```

## Compatibility

Nuxt 4.6 with the module. The module declares `nuxt: ">=3.17.0"`; Nuxt 3 is not tested. Vue 3 + Vite with Pinia is
part of the public [compatibility matrix](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md).
