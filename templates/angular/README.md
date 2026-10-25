# GenClass + Angular starter

An Angular 22 app (standalone components, signals, server rendering and hydration, as `ng new --ssr` generates it)
with [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) installed the recommended way: one import,
first in `src/main.ts`.

```bash
npm install
npm run dev                          # http://localhost:4200, with the GenClass devtools overlay
npm run build && npm run serve:ssr   # production build (no overlay), http://localhost:4000
```

Type a city quickly in the search box. The API (`/api/search` in `src/server.ts`, the Express server Angular
generates) answers in a random 50-900 ms, so an older answer can overwrite a newer one: the classic stale typeahead.
Open the overlay (bottom right) to see what GenClass noticed; the browser console has one plain-English line per
finding.

## The one line

`src/main.ts` starts with:

```ts
import genclass from "@genclass/runtime/auto";
```

It goes first so GenClass is installed before Angular bootstraps and before your app's first requests. GenClass runs
in the browser only: `src/main.server.ts` and `src/server.ts` never import it, so server rendering, hydration and your
server's `fetch` are untouched. It watches fetch and XHR (both `HttpClient` backends), WebSocket, EventSource, user
input and timers. `npx @genclass/runtime@beta init` writes the same line into an existing app.

One Angular detail, nothing to do with GenClass: the SSR server only answers requests addressed to the hosts in
`angular.json`'s `security.allowedHosts` (`127.0.0.1` and `localhost` here, Angular's protection against server-side
request forgery); add your domain there before deploying.

**What it sees in an Angular app.** Automatic state discovery covers React, Redux and Zustand, not Angular signals
yet, so GenClass works from the network and user input: duplicate submits, failure storms, retries and stalls.
Decisions that compare a late response with newer data already in your state need that state registered
(`genclass.atom(...)` / `genclass.guard(...)`, see
[State it can protect](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#state-it-can-protect)).

## Observe, then guard

| mode | import | what it does |
|---|---|---|
| observe (default) | `@genclass/runtime/auto` | reports what it finds; never holds, drops or changes anything |
| guard | `@genclass/runtime/auto/guard` | also prevents failures with small, reversible actions (reuse a duplicate's result, back off) when its model is confident |
| heal (experimental) | `@genclass/runtime/auto/heal` | also retries, serves cached data, blocks a runaway request |

Start in observe, watch the overlay and the console for a while on real traffic, then switch the import to
`/auto/guard`. Every action is logged with its evidence, and the overlay can undo it.

## Devtools overlay

The last line of `src/main.ts` loads the overlay in development only:

```ts
if (isDevMode()) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));
```

`isDevMode()` is false in a production build, so the line is dropped from it.

## Turning it off

- For one page load: add `?genclass=off` to the URL (nothing is installed).
- For a browser: `localStorage.genclass = "off"`.
- For good: remove the import (or run `npx @genclass/runtime@beta remove`).

## Privacy

In a browser, GenClass sends anonymous, redacted diagnostics by default
([TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md)).
To turn that off, add to `src/index.html`'s `<head>`:

```html
<meta name="genclass" content="telemetry=off">
```

## Compatibility

This setup is part of the public compatibility matrix (Angular 22 with SSR and hydration, `HttpClient` on fetch and
on XHR, SSR checked): see [compat/RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md).
