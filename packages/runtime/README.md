# @genclass/runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=npm)](https://www.npmjs.com/package/@genclass/runtime)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![model](https://img.shields.io/badge/model-runs%20in%20the%20browser-brightgreen)

### Your app's race conditions, stale responses and double submits, caught while they happen.

The bugs your tests never catch are the ones that depend on timing: a slow response landing after a fast one, a
button clicked twice, a save racing an edit, an endpoint that starts failing at 2 a.m.

GenClass Runtime records what your app does: user actions, async operations and their causes, fetch/XHR/WebSocket/
EventSource traffic, store writes with per-field versions, errors and timing. It computes generic facts about each
write, request and response. When a situation looks risky, a small GenClass model running in the browser (WebGPU or
WASM, in a Web Worker) answers two questions: what is happening, and which of the available actions is best. The
runtime has no list of known bugs: triage picks the situations, the model decides. By default it only reports; in
`guard` mode it can also stop the failure before your users see it.

**One line covers the whole app.** First in `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.0"></script>
```

(pin the version: the unversioned URL may serve an older release from the CDN cache) or first in your entry file (any bundler; Next.js: `instrumentation-client.ts`):

```ts
import "@genclass/runtime/auto";
```

That is the whole setup. Network traffic, user actions, errors and timing are observed, and so is your app's state:
React component state (`useState`, `useReducer`, `useSyncExternalStore`, class state), Redux and Redux Toolkit
stores, and Zustand stores with `devtools` are found automatically, with no store to register
([Automatic state discovery](#automatic-state-discovery)). It starts in observe mode: it reports, and never changes
what your app does (see Known limitations). `npx @genclass/runtime init` writes the line for you.

**New in `0.3.0`:** a per-app dashboard on genclass.dev fed by an app token, in a GenClass account
(`npx @genclass/runtime login`) or behind a private link, and `protect(name, fn)` with `scope: "functions"` to point
GenClass at a few functions instead of the whole app. See [Your dashboard](#your-dashboard) and
[Function-specific: protect()](#function-specific-protect); `0.2.x` ignores a token and has no `login` command or
`protect` export.

> **Privacy notice: anonymous diagnostics are on by default.** `GenClass.init()` in a browser sends GenClass's
> decisions and counts, without any text from your page, to the GenClass maintainers to improve the model; it is
> off on `localhost` and other local hosts (`0.2.1` sends from them too, by mistake; fixed in `0.2.2`), and the situation text is sent only if you opt in. Opt out with
> `npx @genclass/runtime init --no-telemetry`, `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry`, or
> `localStorage["genclass.telemetry"] = "off"`;
> browsers sending Global Privacy Control are never collected. Details: [Privacy and telemetry](#privacy-and-telemetry)
> and [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).

> **Status: `0.3.0-beta.0` (npm `beta` dist-tag: `npm install @genclass/runtime@beta`; the stable line is `0.2.x`),
> with model `@genclass/runtime-model@0.2.0`.**
>
> - **The model loads by default.** A default `GenClass.init()` loads `@genclass/runtime-model@0.2.0` (10.2 MB q8,
>   `genclass-runtime-r17` 2.0.0-rc4t, run `r17-v2dT`, with a gain gate and three aggressiveness profiles) from
>   jsDelivr at idle, in a Web Worker, and caches it. What that costs (memory, download) is under [Costs](#costs);
>   self-hosting (for a Content-Security-Policy) under
>   [Content-Security-Policy and self-hosting](#content-security-policy-and-self-hosting).
> - **Observe is the default.** The model diagnoses salient situations and the runtime reports likely problems; it
>   never changes what your app does and never holds or delays a response. `guard` is opt-in and `heal` is
>   experimental. Once you opt in, `aggressiveness` (`"cautious"`, `"balanced"` (default), `"eager"`) sets how eager
>   it acts.
> - **The model is precise when it acts, but misses most problems.** On held-out simulated apps, at `balanced`:
>   guard intervened wrongly on 0.13% of cases and heal on 0.59%, slightly above our 0.1% / 0.5% targets; at
>   `cautious`, 0.005% and 0.26%, under them. No wrong interventions were seen on held-out real apps. At `balanced`,
>   guard acts on under 8% of the cases where acting would help. Details: [Model quality](#model-quality) and the
>   [model card](https://www.npmjs.com/package/@genclass/runtime-model).
> - **Older versions.** `0.1.0-beta.3` has the same runtime with these problems (fixed in `0.2.0`): app builds
>   carried 41 MB of unused ONNX Runtime wasm, a CSP-blocked model failed silently, `init` could not turn telemetry
>   off, and `status.scope.mode` read "heal" in observe mode. `0.1.0-beta.2` is `0.1.0-beta.3` without telemetry. `0.1.0-beta.1` has model 0.2.0 and the new options but defaults to `guard`, and lacks the
>   observe-delivery, redaction and install fixes of `0.1.0-beta.0` (all back in `0.1.0-beta.2`). `0.1.0-beta.0`
>   ships model 0.1.0. `0.1.0-alpha.1` and `0.1.0-alpha.0` (v1 runtime: guard by default, holds store writes, `NaN`
>   crash) predate the model; do not use them.
>
> Measured results: [RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md).

Questions, bug reports and false detections: [GitHub Issues](https://github.com/genclass-dev/GenClass-lib/issues) or the [GenClass Discord](https://discord.gg/kN9kRnFtZm).

## Contents

[Install](#install) · [Function-specific: protect()](#function-specific-protect) · [Your dashboard](#your-dashboard) ·
[Automatic state discovery](#automatic-state-discovery) ·
[Why it's an easy yes](#why-its-an-easy-yes-measured) · [Modes](#modes) ·
[What it looks for](#what-it-looks-for) · [State it can protect](#state-it-can-protect) ·
[Ask it questions](#ask-it-questions) · [Observability](#observability) ·
[See it where you already look](#see-it-where-you-already-look) · [Extend it](#extend-it) ·
[Model quality](#model-quality) · [Performance](#performance) · [Costs](#costs) ·
[Content-Security-Policy and self-hosting](#content-security-policy-and-self-hosting) · [Privacy and telemetry](#privacy-and-telemetry) ·
[Known limitations](#known-limitations) · [API reference](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/API.md) ·
[Interception surface](INTERCEPTION.md) · [Security](https://github.com/genclass-dev/GenClass-lib/blob/main/SECURITY.md)

## What it looks like

Run your app as usual. When the model flags something, the console gets one plain-English line per detection or
intervention, followed by a collapsed group with the evidence. Here a typeahead's slow response for "rea" lands
after the response for "reac". This is real output (format unchanged since `0.1.0-beta.0`; q8 on WASM, in Node),
in the default observe mode. The response reaches the app at once, exactly as without GenClass, and the decision is
made in the background, for the report only:

```
[GenClass] Model ready (genclass-runtime-r17, wasm, q8, 0.43s). Mode: observe.
[GenClass] Flagged a stale response: search.results was written twice by other operations since its operation (#6)
started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later
user action (#7). (stale, 0.96)
```

The same run in guard mode. The model's `discard` (0.98) passed model 0.1.0's delivery gate (0.80), so the results
for "reac" stayed:

```
[GenClass] Prevented a stale response: search.results was written twice by other operations since its operation (#6)
started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later
user action (#7). Delivered the response to GET /api/search?q=rea (#6) and dropped the state changes it makes over
newer data (search.results). (stale, 0.97; discard 0.98)
```

In production these lines print in your users' browsers. From `0.3.0` you can send them
to Sentry, PostHog, Datadog, your log shipper or your own endpoint as well: `npx @genclass/runtime init --sink sentry`,
or `data-sink="sentry"` on the script tag ([See it where you already look](#see-it-where-you-already-look)).

## Install

Pick one. All of them start the same runtime, in observe mode unless you choose otherwise.

**1. One command.** `init` finds your framework and package manager, installs the package, adds one import as the
first line of your entry file (plus a line that loads the devtools overlay in development only), and shows you the
diff before writing anything. Running it again changes nothing; running it with another `--mode` switches the
import it added.

```bash
npx @genclass/runtime init               # observe; shows the diff, asks, then writes
npx @genclass/runtime init --mode guard  # let GenClass act (also: --mode heal); run again later to switch
npx @genclass/runtime init --yes         # no questions
npx @genclass/runtime init --dry-run     # show the diff, write nothing
npx @genclass/runtime remove             # undo exactly what init added
```

Other flags: `--no-install`, `--no-devtools`, `--cwd <dir>`, `--cdn <url>` and `--no-sri` (plain HTML),
`remove --keep-package`.

**Token and dashboard** (`0.3.0`; `init` in `0.2.x` creates no token). On a new setup, once you approve the
diff (or pass `--yes`), `init` also creates a project for your app at genclass.dev: it sends `package.json`'s `name`
to `https://genclass.dev/api/projects`, writes the token it gets back into what it adds (the diff shows
`gc_new-token-created-when-you-apply` in its place until then), and prints your private dashboard link:

```
  Your dashboard  https://genclass.dev/dashboard/...
  Keep this link private; it is the only way to open your dashboard.
  Saved in .genclass.local (added to .gitignore).
```

The link is saved in `.genclass.local` (with the token) before init writes anything else, so a failed write cannot
lose it. init asks git whether that file is ignored; if not, it adds it to the project's `.gitignore` (inside a git
repository without one there, such as a monorepo package, it creates one with that line). `remove` leaves the file
and that line alone. Declining, running without a terminal and without `--yes`, and `--dry-run` send nothing and
create nothing. Running `init` again reuses the token (no new project); on a setup made
without one it never creates a project as a side effect: pass `--token`, or sign in and run `connect`. Signed in
(`npx @genclass/runtime login`), `init` first asks whether the new app goes into your GenClass account instead of
getting a private link ([Your dashboard](#your-dashboard)).

```bash
npx @genclass/runtime init --token gc_...   # use a token you already have (no network)
npx @genclass/runtime init --no-token       # no token, no network
```

`--no-telemetry` implies `--no-token` (a dashboard only gets data while telemetry is on). If genclass.dev cannot be
reached, `init` says so, sets GenClass up without a token, and points you to
[genclass.dev/start](https://genclass.dev/start); run `init --token gc_...` later. `--dry-run` never calls the
network.

Options without editing code (also on a project `init` already set up; `remove` takes them out too):

```bash
npx @genclass/runtime init --no-telemetry                # anonymous diagnostics off (--telemetry: explicitly on)
npx @genclass/runtime init --model-url /genclass-model/  # a self-hosted model (see Content-Security-Policy below)
npx @genclass/runtime init --sink sentry                 # findings in Sentry too: also posthog, datadog, console-json,
                                                         # webhook:<url> (0.3.0; "See it where you already look")
```

They go into a marked `genclass.config.ts` (or `.js`) next to your entry, which sets `window.GENCLASS_CONFIG` and is
imported right before the `/auto` import (an ES module's imports run before its own code, so options cannot be set
above the import in the same file). Any `GenClass.init()` option works in that file. Plain HTML gets
`data-telemetry="off"` (and `data-model`, `data-ort`, `data-sink`) on the script tag, Astro a `<meta name="genclass">` line.

`init` also says that telemetry is on by default and how to turn it off, and when your app sets a
Content-Security-Policy (`next.config` headers, a proxy or middleware, a `<meta http-equiv>`, helmet, `vercel.json`,
`_headers`, ...) it prints the steps to self-host the model.

- **What `init` edits.** It only edits browser apps. It stops and says why for a Node server, a library (a UI
  framework as a peer dependency, or an `exports`, `module`, `types` or `bin` field), or an entry file that imports
  Node-only modules.
- **What `remove` deletes.** Only what `init` wrote, including lines a formatter rewrapped. If you edited a marked
  line or block, it changes nothing and lists where.

Tested end to end on fresh projects from each framework's own generator: Vite 8 (React with npm and pnpm, Vue,
Svelte), Next.js 16.4 (App and Pages Router, plus the paths for Next < 15.3), Create React App 5, SvelteKit, Astro,
Nuxt 4.6, React Router 8 (framework mode), Angular 20 and plain HTML. In all 15 projects:

- the app built and ran in Chromium after `init` (production build where the project has one);
- the model loaded in a worker, the overlay appeared only in development, and a warm load had no console errors;
- `remove` left every file byte-identical to the scaffold (node_modules, lockfiles and build output excluded).

Remix, Solid, Preact and Next.js before 15.3 are detected but were not scaffolded with their own generators.
The [compatibility matrix](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md) runs the
one line in React + Vite, Next.js 16, Vue + Pinia, SvelteKit 3, Angular 22, Solid and plain HTML, with 15 data layers
(TanStack Query, SWR, Redux Toolkit, Zustand, Apollo, WebSocket and EventSource among them), in every mode, and checks
that GenClass never makes those apps worse; starter templates are in
[templates/](https://github.com/genclass-dev/GenClass-lib/tree/main/templates).
Details: [test/install/RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/test/install/RESULTS.md).
Those scaffold runs predate the `init` / `remove` fixes in this version (`--mode`, formatter handling, server and
library detection), which are covered by unit tests; the current end-to-end evidence is the compatibility matrix above.

**2. One import** (any bundler; the package is ESM only, there is no `require` build), first in your entry file, so it is installed before your framework and stores
created at import time see the runtime (automatic state discovery is on):

```ts
import "@genclass/runtime/auto";          // observe (the default)
import "@genclass/runtime/auto/guard";    // or guard
import "@genclass/runtime/auto/heal";     // or heal (experimental)
import "@genclass/runtime/auto/observe";  // observe, explicitly

import rt from "@genclass/runtime/auto";  // the same, and the runtime it started
```

Optional page configuration, read once: `<meta name="genclass" content="mode=guard, devtools=local">` inside
`<head>` or `window.GENCLASS_CONFIG = { mode: "guard", devtools: true }` (any `InitOptions`; since `0.3.0` also
`token=gc_...` / `token: "gc_..."`), set before the import runs. During SSR or in Node, `/auto` installs nothing and
returns an inert runtime.

**3. One script tag** (no build step), first in `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime" data-mode="observe" data-devtools="local"></script>
```

It exposes `window.GenClass`, discovers the app's state like the import does, and loads the model worker, ONNX
Runtime Web and the overlay on demand from the same version on the CDN. `data-mode` takes `observe` (the default), `guard` or `heal`; `data-devtools="local"` shows the
overlay only on localhost; `data-manual` skips the automatic `GenClass.init()`. Since `0.3.0`: `data-token="gc_..."`
(your app's token), `data-scope="functions"` and `window.GenClass.protect`. Pin a version in production
(`https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.0`); the plain-HTML path of `init` writes a pinned
jsDelivr URL with SRI.

**4. By hand:**

```bash
npm install @genclass/runtime
```

```ts
// first thing in your entry file
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init(); // observe; GenClass.init({ mode: "guard" }) to let it act
```

`GenClass.init()` does not discover state on its own: register stores ([State it can protect](#state-it-can-protect)),
or import `@genclass/runtime/discover` first and pass `autoState: true`.

The unscoped `genclass-runtime` alias is deprecated; use `@genclass/runtime`.

**ESM only.** The package ships ES modules (no `require`). Jest users need a `transformIgnorePatterns` entry that lets
`@genclass/runtime` be transformed, for example `["/node_modules/(?!@genclass/runtime)"]`.

## Function-specific: protect()

**New in `0.3.0`** (`0.2.x` has no `protect` export: importing it fails). Use this when you want GenClass
on a few functions that matter (a checkout submit, a search, a save) rather than on the whole app.

```ts
import { GenClass, protect } from "@genclass/runtime";

GenClass.init({ token: "gc_...", scope: "functions" }); // early in your entry file (with /auto or the script tag: see below)

// Wrap at module level; calls made before GenClass.init() simply run fn.
export const submitOrder = protect("checkout submit", async (cart: Cart) => {
  const res = await fetch("/api/orders", { method: "POST", body: JSON.stringify(cart) });
  if (!res.ok) throw new Error(`order failed: ${res.status}`);
  return res.json();
});

export const search = protect("search", async (q: string) => {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  return (await res.json()) as Result[];
});

class CartStore {
  save = protect("cart save", function (this: CartStore, items: Item[]) {
    return api.put("/api/cart", items); // `this` is the store, as without protect
  });
}
```

What `protect(name, fn)` does:

- **Same function.** It returns a function with the same signature: `this`, arguments, return value and thrown
  errors pass through, and a sync function stays sync. For an `async` function you get a promise that settles
  exactly like `fn`'s (it is a new promise object, as with `runtime.op`). Other thenables are returned untouched.
  `protect` itself never throws.
- **Each call is tracked.** The call runs as an operation named `name`: for an `async` function the same operation,
  and the same situation, as `runtime.op(name, fn)` (a sync function's operation ends as soon as it returns). The
  requests, state writes, timers and errors it starts are linked to it, directly or through the causal chain GenClass
  already follows (a request started after an `await` on one of the function's own requests counts). Work started
  from somewhere else, such as a WebSocket message or another click handler, does not.
- **Decisions name the function.** A decision about something a protected call caused carries `fn: name`
  (`rt.on("decide", (d) => d.fn)`, and, when your app sets a token, the telemetry `decision` event and your
  dashboard; without a token the name is never sent). With nested protected functions, the outermost one is named.
  Use a fixed name: in telemetry, a label that looks like data (an e-mail address, a URL, 4 or more digits in a row,
  12 or more hex digits) is sent as `[redacted]`; `d.fn` in your app keeps it as written.
- **No runtime, no cost.** A protected function looks up `GenClass.runtime` on every call. Before `GenClass.init()`
  (or after `GenClass.destroy()`) it calls `fn` directly.
- **Also** as `GenClass.protect`, and on the script tag's `window.GenClass.protect`. With the script tag, use
  `window.GenClass.protect`: a copy imported from npm would not see the script tag's runtime.

**`scope: "functions"`** (`InitOptions.scope`; also `data-scope="functions"` / `scope=functions` in the meta tag):
GenClass still observes the whole app and keeps it as context in the situations it builds, but it raises decisions
only for activity inside protected functions; it never holds or acts on anything else. Standing questions from
plugins (`rt.question()`, a plugin's `questions`) are only asked about protected activity too. Explicit questions
(`rt.ask()`, `rt.decide()`) are still answered everywhere. The default,
`scope: "app"`, decides about the whole app as before; `protect()` then only adds the function names. The mode still
applies: in `observe` (the default) GenClass reports, in `guard` it may act on what protected functions cause.

**With `/auto` or the script tag** (what `npx @genclass/runtime init` sets up), GenClass is already running before
your code, so a later `GenClass.init({ token, scope })` is ignored (the console says so once). Set them where GenClass
starts: `window.GENCLASS_CONFIG = { token: "gc_...", scope: "functions" }` in the `genclass.config.ts`/`.js` that
`init` imports right before `/auto`, `<meta name="genclass" content="scope=functions">` in `<head>`, or
`data-scope="functions"` on the script tag. Then wrap your functions with `protect()` as above.

A per-function mode (`protect(name, fn, { mode })`) does not exist yet: use `routes` or `requests.protect` to narrow
where GenClass acts.

## Your dashboard

**New in `0.3.0`** (`0.2.x` ignores a token and has no `login`, `connect`, `whoami` or `logout`). Each
web app gets a **project key** (token: `gc_` + 22 letters and digits) that groups its diagnostics on a dashboard at
genclass.dev. The key is public: it ships in your page and can only add telemetry to its app. Keep the dashboards in
a GenClass account, or use one private link per app without an account.

**With an account:**

```bash
npx @genclass/runtime login     # sign in in the browser, then connect the app in this folder
npx @genclass/runtime connect   # connect an app folder later (or another one)
npx @genclass/runtime whoami    # your account and its apps
npx @genclass/runtime logout    # end the CLI session
```

`login` prints a code and opens `https://genclass.dev/login/device`, where you sign in (Google, GitHub or a
passkey) and approve that code. It waits until you do (Ctrl-C stops it and saves nothing), then saves the CLI
session in `~/.config/genclass/credentials.json` (`$XDG_CONFIG_HOME/genclass/`; Windows `%APPDATA%\genclass\`),
readable only by you. `--no-browser` prints the link without opening a browser (it works from any device).
Inside an app's folder, `login` then asks whether to connect that app; `connect` does that step alone:

- pick one of your account's apps, or a new one named after `package.json` (`--app <id|name>`, `--name <name>`);
  a new app is created only once you approve the changes;
- it writes the key the way `init` does (`genclass.config.*`, `data-token` on the script tag, or the Astro meta
  line), shows the diff and asks first (`--yes`: no questions; `--dry-run`: it reads your app list, and creates and
  writes nothing), and sets GenClass up first if `init` has not;
- an app `init` already created without an account (its private link in `.genclass.local`) can be added to your
  account instead, keeping its key and its data. The link is only sent to the host it belongs to.

```
  ✔ Account    you@example.com
  ✔ App        shop-web (a new app in your account, created once you apply the changes)
  ...
  Your dashboard  https://genclass.dev/account/apps/...
```

An app's dashboard in your account opens for you when you are signed in at genclass.dev. Until the app's first event
arrives it shows the key and these same two ways to connect it; you can also sign up at genclass.dev, create an app
there, and pass its key yourself (below). What the CLI sends: `login` asks genclass.dev for a sign-in code, naming
itself `genclass-runtime <version>` (the approval page shows that name and your account page lists the session
under it), and polls until you approve it, then reads your account's apps; creating an app sends its name, and
adding an existing dashboard sends its link from `.genclass.local`. Nothing is sent until you run
one of these commands (or approve `init`'s changes). The CLI session (`gcs_...`) is a secret: `logout` ends it at
genclass.dev and deletes the file, and you can revoke it from your account page. A CLI session can read your
account's apps, create apps, add an app from its private link and end itself; it cannot read stats, end other
sessions or change how you sign in. What an account stores:
[PRIVACY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md).

**Without an account:**

| | what | who may see it |
|---|---|---|
| token | `gc_` + 22 letters and digits, e.g. `gc_4fQ9...` | public: it ships in your page. It only lets your app's diagnostics be grouped together. |
| dashboard link | `https://genclass.dev/dashboard/<secret>` | **private**: anyone with the link sees your app's stats, and it is the only way to open them |

**Get one:** `npx @genclass/runtime init` (not signed in, after you approve its diff: creates both, writes the
token, prints the link and saves it in `.genclass.local`), or click "Get a token" at
[genclass.dev/start](https://genclass.dev/start). A link can be added to an account later (`connect`, or "Add an
existing dashboard" on your account page).

**Pass a key yourself:** `GenClass.init({ token })`, `data-token="..."` on the script tag,
`<meta name="genclass" content="token=...">` or `window.GENCLASS_CONFIG = { token }`. A malformed token logs one
console warning and is ignored.

**What it shows:** decisions, detections by diagnosis, actions taken, top routes and protected functions,
model load, backend (WebGPU or WASM) and latency, runtime and model versions, and recent detections.

**What it needs:** telemetry on (the default with `GenClass.init()` in a browser) on a deployed host. Local hosts
(`localhost`, `*.local`, `*.test`, private networks) do not send by default, so a page there does not feed the
dashboard (the console says so once when a token is set). `telemetry: true` or any telemetry options object (for
example `telemetry: { decisionSample: 1 }`) is an explicit opt-in that sends from local hosts too, token included. With telemetry off for any other reason, a token does nothing (with
`debug: true` the console says so once). Visitors who opt out (`?genclass=no-telemetry`,
`localStorage["genclass.telemetry"] = "off"`) or whose browser sends Global Privacy Control are not counted. With a
token, each telemetry batch carries it and decisions about protected functions carry their `fn` name; nothing else
changes about what is sent ([Privacy and telemetry](#privacy-and-telemetry)). Dashboard data is kept for 90 days.

**Which version:** the token option, `scope`, `protect()` and the `login`, `connect`, `whoami` and `logout` commands
are in `0.3.0` (first as `0.3.0-beta.0`, see the [CHANGELOG](CHANGELOG.md)). A key needs `@genclass/runtime`
`0.3.0-beta.0` or later in your app.

## Automatic state discovery

With the one line (`@genclass/runtime/auto*` or the script tag) GenClass finds the app's state on its own. It
installs itself before your framework loads (that is why the line goes first), the way React DevTools and Redux
DevTools do, and records every state change with the operation that caused it (the response, timer or user action
whose callback called `setState` or `dispatch`), exactly as for a registered store. Delivery decisions ("this
response would overwrite newer data") need those writes: without them, GenClass could only see the network.

| state | how it is found | what GenClass can do with it |
|---|---|---|
| React ≥ 16.8 (development and production builds): `useState`, `useReducer`, `useSyncExternalStore`, class component state | the React DevTools global hook (installed, or chained onto the real extension's, which keeps working); each commit, only the components that re-rendered are compared, within 1 ms | **observed only**: detections, facts, triage and delivery decisions (`deliver` / `defer`); never held, dropped, reverted or rolled back |
| Redux / Redux Toolkit (`configureStore` with `devTools` on, its default; `createStore` with the Redux DevTools compose or enhancer) | the Redux DevTools globals (forwarded to the real extension when installed) | **controllable**: GenClass's Redux enhancer, as if you had added it: delivery `discard`, late revert, `rollback`, `resync` |
| Zustand with the `devtools` middleware (and other libraries reporting to Redux DevTools' `connect`) | the Redux DevTools `connect` API. **Production builds:** Zustand turns `devtools` off when `import.meta.env.MODE` is `production` unless you pass `enabled: true`, so a production build is not discovered without it (or wrap the store with `genclass` from `@genclass/runtime/zustand`, which also makes it controllable) | **observed only** |

- **Names.** A component's store is named after the component: `SearchPage.state0`, `SearchPage.state1` (hooks in
  order), `SearchPage.external0` (`useSyncExternalStore`), or the class state's keys (`Wizard.step`). Production
  builds minify component names, so a store is then named after the element the component renders (`id`,
  `data-testid`, its first `data-*` attribute or `aria-label`: `orderChip`, `addToOrder`), else the minified name.
  At most 3 instances per component (`Item`, `Item_2`, `Item_3`) and 48 component stores. A store appears on its
  first state change; mounting alone records nothing. Redux stores are named after the devtools `name` option, else
  `redux`; Zustand stores after their `devtools` `name`, else `store`.
- **Skipped.** Anonymous components, framework internals (Next.js and React Router components, error boundaries),
  and values that are not app data: functions, promises, React elements, DOM nodes, class instances and objects
  holding them (router caches, query clients).
- **Secrets.** Field names are redacted as usual (`form.password`). A hook has no name, so a `useState` whose
  string equals what a password, card-number or one-time-code input holds is redacted from then on. Discovered
  state reaches telemetry only if you opt into sending situation text (`telemetry: { include: { situation: true } }`).
- **Turn it off:** `<meta name="genclass" content="autostate=off">`, `data-autostate="off"` on the script tag,
  `window.GENCLASS_CONFIG = { autoState: false }`, or one source only: `autoState: { react: false }` (also `redux`,
  `zustand`). `?genclass=off` installs nothing at all.
- **With `GenClass.init()`** discovery is off by default, so explicit setups do not change. To turn it on, import
  `@genclass/runtime/discover` first (before React, Redux or Zustand) and pass `autoState: true`; the runtime may start
  later, before the first render. Redux stores created before it starts are observed only.
- **Not covered yet:** Vue / Pinia, MobX, Jotai, Recoil, signals, Svelte stores, and state kept outside these
  libraries (module variables, refs). A React renderer that loaded before GenClass is observed without exact causes;
  one that rendered before GenClass is not observed at all. Register such state with `rt.atom` / `rt.guard`
  ([State it can protect](#state-it-can-protect)), which also makes it controllable.
- **Cost:** about 7 KB gzip more JavaScript in `/auto`; a commit walk of p50 below 0.2 ms and p95 under 2 ms on a
  4× throttled phone profile, about +0.5 MB heap ([Costs](#costs)).

## Why it's an easy yes (measured)

These hold for the runtime; whether the model's decisions are good is a separate question (see
[Model quality](#model-quality)).

- **It is not expected to make a working app worse.** Decisions about responses happen at the network boundary,
  which looks like ordinary latency to your app, and the default never holds or reorders your app's own store
  writes. With a model that never intervenes (heal mode, compared against observe mode), GenClass changed the
  outcome in **0 of 396** clean runs across **66 real apps in 23 frameworks** (React, Vue, Svelte, Solid, Angular,
  Ember, Elm, Lit, Redux, Zustand, MobX, TanStack Query and more, including 14 unmodified open-source RealWorld
  front-ends), 6 seeds each. What that check does and does not compare is under [Model quality](#model-quality).
- **Every mode, on idiomatic apps in seven frameworks.** The
  [compatibility matrix](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md) (React,
  Next.js, Vue, SvelteKit, Angular, Solid, plain HTML; 15 data layers; 10 seeds per cell) found 0 bugs introduced in
  3,510 runs with GenClass and 0 actions on correct apps. Observe left page and server state identical to the run
  without GenClass in every cell but one: an app's own timing race (SWR's optimistic rollback) that came out right
  with GenClass and wrong without it, with no action taken. Observe holds nothing, but its main-thread work is not
  zero.
- **Normal traffic costs little.** Facts are computed for every write and request; the model is consulted only for
  salient situations. Clean in-order typeahead makes no model calls and holds nothing. A keystroke write to a store
  holding a 5,000-item array takes about 0.22 ms.
- **The model runs in the browser.** It runs locally in a Web Worker on WebGPU or WASM and is cached after the
  first load: no inference server, no API key, and decisions never wait on the network. Anonymous diagnostics about
  its decisions (without page text unless you opt in) are sent to the GenClass maintainers by default, except on
  local hosts; one option turns that off (see [Privacy and telemetry](#privacy-and-telemetry)). Typed values of
  password and payment fields are never recorded (other redaction has gaps).
- **You can see what it did.** Every detection and action gets one plain-English console line with the evidence
  behind it, and `rt.explain(id)` shows exactly what the model read. Discards and rollbacks can be undone; responses
  it changed carry an `x-genclass` header.
- **Off in one step.** `?genclass=off` in the URL installs nothing, and observe (the default) never changes
  execution.
- **Small on the main thread.** The main entry is about 100 KB gzip in `0.3.0` (minified, without the optional
  devtools; 92 KB in `0.2.2`; see Performance). The
  default model is 10.2 MB on WASM (13.6 MB fp16 on WebGPU with `shader-f16`), downloaded once at idle and cached.
  It runs in a worker that holds 190 to 280 MB while loaded: see [Costs](#costs).

## Modes

| mode | what it does | non-passive actions |
|---|---|---|
| `observe` (**default**) | Finds and reports what it sees and what it would have done. Never holds a request or a response, never runs an action. | none |
| `guard` (opt-in) | Also prevents failures with minimal, reversible guard-tier actions: `discard`, `defer`, `coalesce`, `delay` (drop a stale response, reuse a duplicate's result, back off). Only when the model's gate says acting beats doing nothing (with model 0.2.0 at `balanced`: about 90% sure). | guard tier |
| `heal` (**experimental**) | Also recovers: `retry`, `serve_cached`, `block`, `hedge`, `rollback`, `resync`, plus your own actions. | guard + heal tier |

**Detections in observe (`0.3.0`).** A detection is *likely* when the model's top diagnosis is not `expected` and
its probability reaches the report gate (0.90 at `balanced` with model 0.2.0), and is printed as one console line
with its evidence, as before. In observe GenClass also reports *possible* detections: at least the `eager`
profile's report value (0.70) but below the report gate. They print with `console.debug` only, ending in
`(possible)` (Chrome hides them unless the console level includes "Verbose"), show as dimmed cards in the devtools,
and are counted on their own (`summary().possibleDetections`, telemetry). Your own wiring gets them only if you ask:
`rt.on("detect")`, `rt.on("report")` and `report: (r) => …` receive the likely ones unless you set
`detect: "possible"` (every decision, with `detection` set, is on `rt.on("decide")`), and sinks need
`possible: true`. `detect: "likely"` turns them off; `detect: "possible"` turns them on in guard and heal too (reporting
only: what guard and heal do is unchanged). Setting `policy.thresholds.report` turns them off unless `detect` asks.
Measured effect and false-detection bounds:
[RESULTS.md §11](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md).

Observe no longer goes blind while the model loads or the tab is hidden (`0.3.0`): situations raised then are built
at once and decided when the model is ready and the tab visible (at most 32 wait; a hidden tab never loads the
model, the tab becoming visible does). Until their false-report rate is measured, what they find is reported at the
possible tier at most. `detect: "likely"` turns this off too. In guard and heal, nothing waits: they skip, as before.
Three `0.3.0` fixes can add likely reports in observe that `detect: "likely"` does not turn off, at a rate not
measured yet (overwritten writes decided on slow devices, the body-wait and idle-unload fixes; CHANGELOG).

## How eager should it be?

Once you opt into `guard` or `heal`, GenClass only acts when the model is confident enough. You choose how confident:

```ts
GenClass.init({ aggressiveness: "cautious" }); // "cautious" | "balanced" (default) | "eager", or a number 0–1
GenClass.runtime.setAggressiveness("eager");   // change it later (the devtools have a selector too)
```

`cautious` acts less often (fewer interventions, almost never a wrong one); `eager` fixes more problems at a
somewhat higher risk of acting when it did not need to. A number in between interpolates (0 = cautious,
0.5 = balanced, 1 = eager). Try a level without redeploying with `?genclass-aggr=eager` in the URL. The model ships
tuned thresholds for each level; explicit `policy.thresholds` still override them. `runtime.gates()` shows what is
in force. In observe, aggressiveness only moves the report gate (what counts as a likely detection); the possible
tier below it stays at the `eager` value (see [Modes](#modes)).

## Connect your state (optional)

Network, user actions, errors and timing are observed with zero code. To let GenClass also protect your state
(roll back an inconsistent cart, revert a stale write), create it through GenClass or wrap the store you already
have. Each option is one line:

```ts
GenClass.init({ mode: "guard" });
```

- **Where the thresholds come from.** They were fitted on held-out dev data, including the model's own on-policy
  traffic, and ship in the model's `meta.json`
  ([model card](https://www.npmjs.com/package/@genclass/runtime-model)). A model without a `gate` gets the
  runtime's defaults: report 0.6, guard 0.9, heal 0.8. `policy.thresholds: { report, guard, heal }` overrides both.
  `rt.gates(trigger)` shows the values in force and where each came from (`"policy"`, `"model"` or `"default"`).
- **Detections.** In every mode, a decision is reported as a detection when its top diagnosis is not `expected` and
  its probability is at least the report threshold of the active profile: 0.95 / 0.90 / 0.70 for cautious /
  balanced / eager with the default model.
- **Limits.** Actions are limited to 60 per minute overall, 10 per minute on the same subject and 200 per session
  (`policy.actionLimits`). A held decision that misses the
  hold budget runs the passive action; a background write decision can still revert the write late.
- **Control.** The `allow` / `deny` lists are in `policy`. Switch at runtime with `rt.setMode(mode)`, or stop
  consulting the model with `rt.pause()` / `rt.resume()`.

**The default changed.** `0.1.0-alpha.0` and `0.1.0-beta.1` defaulted to `guard`. Now `GenClass.init()` with no `mode` (and
`@genclass/runtime/auto`, and the script tag without `data-mode`) observes only; pass `mode: "guard"` to let it act.

**Kill switch.** Append `?genclass=off` to the URL, or set `localStorage.genclass = "off"`, and nothing is installed.
`?genclass=observe|guard|heal` (or the same localStorage value) overrides the mode, including the mode of the `/auto`
entries and the script tag, within limits: `observe` always works; `guard` works when no mode, `guard` or `heal` is
configured (so on the default `/auto` and script tag, but not on `/auto/observe`); `heal` works only when `heal` is
configured, or with `debug: true` (for QA).

`GenClass.init()` never throws, and a second call returns the first runtime (its options are ignored). Outside a
browser (SSR, Node) it returns a runtime with no observers and no model. For tests and headless use, call
`createRuntime(options)` instead.

## What it looks for

At a glance (actions other than flagging need `guard` or `heal`):

| situation | example | what GenClass can do |
|---|---|---|
| Stale response | an old search response lands after a newer one | deliver it but drop its writes over newer data, or defer it (guard) |
| Race / conflict | a server echo would overwrite what the user just typed | drop the stale part, defer (guard) |
| Duplicate | a double click sends the same order twice | reuse the first response (`coalesce`, guard) |
| Inconsistent state | the cart total no longer equals the sum of the lines | roll back or resync (heal) |
| Failure pattern | an endpoint fails 5 times in a row | serve the last good response (heal) |
| Transient failure | a one-off 503 | retry (heal) |
| Slow or flooding | 8× slower than usual; a render loop hammering an API | hedge (heal), delay (guard) |
| Unusual behaviour | an operation writes different fields than it usually does | flag; roll back (heal) |
| Your own question | "is now a good moment to start the upload?" | `rt.ask()` / `rt.decide()` |

The runtime decides at nine **triggers**. Only salient ones (a conflict, a repeat, a failure, an anomaly, a broken
relation, an error) reach the model; everything else is a cheap fact computation.

| trigger | when | passive action | other actions (tier) |
|---|---|---|---|
| `delivery` | a fetch/XHR response or a WebSocket/EventSource message is about to reach the app | `deliver` | `discard` (guard): deliver, but drop the writes it makes over newer data · `defer` (guard): wait for related in-flight work, then decide again |
| `request` | a request is about to be sent | `send` | `coalesce`, `delay` (guard) · `block`, `serve_cached` (heal) |
| `failure` | a request failed (network error, timeout, 5xx/429/408) | `deliver` | `retry`, `serve_cached` (heal) |
| `stall` | a request is far slower than usual | `wait` | `hedge`, `serve_cached` (heal) |
| `mutation` | a salient store write that no delivery decision covered | `apply` | `discard`, `defer` (guard), decided in the background |
| `inconsistency` | a learned relation (`total == sum(items[*].price × qty)`) broke at a settled point | `ignore` | `rollback`, `resync` (heal) |
| `transition` | an operation wrote different fields than it usually does | `ignore` | `rollback`, `resync` (heal) |
| `error` | an uncaught error or rejection | `ignore` | `rollback` (heal) |
| `ask` | your own question (`rt.ask`, `rt.decide`) | | |

The model also gives a diagnosis: `expected`, `stale`, `conflict`, `duplicate`, `inconsistent`, `failing`, `slow`,
`overload`, `unusual` or `transient`.

**Delivery decisions (the main change in this version).** GenClass decides about responses and messages *at the
network boundary*, before the app sees them, and never holds or reorders the app's store writes. A delivery is
salient only when:

- a field the response is predicted to write already holds **newer applied data** (an operation that started later
  wrote it since) and no newer request of the same kind is still in flight;
- or it would **revert a pending local change** (an optimistic update whose request is still in flight) to the value
  the user's change replaced;
- or it would **replace text the user typed** after the request started.

The runtime predicts the write set from what the same operation wrote before. For salient candidates it reads the
response body (a clone, at most 256 KB of JSON, waiting at most 100 ms). A response equal to the current values is not
salient. The model then reads facts such as these (real output from the example above):

```
The response has search.results = 1 item ["rea-1"]: neither the current value 1 item ["react-1"], nor the value when #4 started.
In 1 earlier completions of GET /api/search its chain wrote search.results (1 of 1 wrote state).
The response to GET /api/search?q=rea (#4) arrived after 1.80s (200); the app has not seen it yet.
This request comes from user typed "rea" into input "Search" (#3), started 1.80s ago.
```

Clean in-order typeahead and autosave make no model calls and hold nothing (covered by the unit tests). Other facts
cover:

- repeats and multi-clicks;
- failure streaks and failure scope (other endpoints, `navigator.onLine`);
- whether a failed POST may have been applied;
- learned cadences (polling, debounced saves);
- latency against learned baselines;
- values known to be stale;
- read-your-writes.

It catches runtime failures that leave evidence: ordering, staleness, duplicates, broken relations, failure patterns.
It does not catch logic that is consistently wrong, CSS or security bugs, and it never rewrites your code.

**Steps that did not happen (opt-in, `0.3.0`).** `GenClass.init({ learn: { expectations: true } })` also learns what
each user action on a route usually does (the requests it sends, what their answers write, where it navigates) and
reports a usual step that did not happen this time: `[GenClass] Expected a request on /cart: clicking button "Add to
cart" usually sends POST /api/cart (...); this time nothing was sent in 2.0 s.` Deterministic counts, no model, no
action in any mode. It is off by default until its false-report rate on correct apps is measured
([RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md), "Flow expectations");
off, its code is never loaded (a lazy chunk, no first-load cost). Design and controls:
[EXPECTATIONS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/EXPECTATIONS.md).

## State it can protect

Fetch, XHR, WebSocket, EventSource, DOM user events, errors, navigation, storage, long tasks and timers are observed
automatically, with no code. With the one line, React, Redux and Zustand state is found too
([Automatic state discovery](#automatic-state-discovery)); discovered Redux stores are controllable, React and Zustand
state is observed only. A write can be dropped or reverted only when the store goes through GenClass. Each option is
one line:

```ts
const rt = GenClass.init({ mode: "guard" });

// Built-in atom
const cart = rt.atom("cart", { items: [], total: 0 }, { resync: () => loadCart() });
cart.set((c) => ({ ...c, items: [...c.items, item] }));

// React (uses GenClass.runtime, or the runtime from <GenClassProvider runtime={…}>; plain useState without one)
import { useGenClassState } from "@genclass/runtime/react";
const [results, setResults] = useGenClassState("searchResults", []);

// Redux / Redux Toolkit (put the enhancer last in compose())
import { genclassEnhancer } from "@genclass/runtime/redux";
const store = configureStore({ reducer, enhancers: (e) => e().concat(genclassEnhancer(rt, { name: "app" })) });

// Zustand
import { genclass } from "@genclass/runtime/zustand";
const useBoard = create(genclass(rt, "board")((set) => ({ cards: [], move: () => set(/* … */) })));

// Any store with get/set (and optionally subscribe)
const prefs = rt.guard("prefs", { get: () => store.prefs, set: (v) => store.setPrefs(v) });
```

What each kind of protection needs:

| protection | how | works with |
|---|---|---|
| delivery `discard` | the response is delivered; its chain's writes to the protected fields are dropped synchronously inside each write, and its other fields (loading flags, counts) apply | atoms, `rt.guard`, `useGenClassState`, Redux and Zustand adapters (also discovered Redux stores). Never offered when every field the response would write is observed only (discovered React or Zustand state): `defer` still is |
| late revert | a background `mutation` decision to `discard` reverts the write if it is at most 2 s old, its fields are unchanged since, and no later write of the same chain followed | any GenClass-aware store |
| `rollback` (heal) | restores the last settled snapshot where every learned relation held | stores GenClass can write (atoms, `rt.guard`, Redux and Zustand adapters) |
| `resync` (heal) | calls your `resync` handler | stores registered with `{ resync }` |

`{ hold: false }` on a store keeps its writes out of the opt-in write holds (`policy.holdWrites: true`, off by
default). The default never holds a store write: `set(x); get()` always returns `x`.

## Ask it questions

The model answers typed questions about what is happening now (the request shape of Jev's System One API):

```ts
const busy = await rt.ask({ type: "noul", instructions: "Is a save in flight or failing?" });
// { type: "noul", noul: <calibrated P(true)> }

const when = await rt.decide("Which upload strategy fits what is happening now?", {
  now: "start the upload immediately",
  later: "wait until the network is calm and the user is idle",
});
// "now" | "later"
```

Without a model (`model: false`, or when it cannot load) both reject with `GenClassUnavailableError` (`reason`:
`off`, `error`, `timeout` or `destroyed`). `{ timeoutMs }` bounds the wait. With the default model, short factual
questions about the current situation work best; it is not a general-purpose reasoner.

Standing questions ride along with built-in decisions: `rt.question({ id, on: ["failure"], question, onAnswer })`.

## Observability

- **Console:** one line per detection and per intervention, with the evidence collapsed below it. Identical repeats
  within a minute are summarised. `report: "silent"` or `report: (r) => …` to route them yourself. Possible
  detections (observe, `0.3.0`) are one `console.debug` line each, ending in `(possible)`; a report function gets
  them only with `detect: "possible"`.
- **Events:** `rt.on("detect" | "decide" | "act" | "event" | "status" | "report", fn)` returns an unsubscribe function.
- **`rt.explain(id)`:** the exact situation text the model read, its facts and timeline, every answer with
  probabilities, and what changed.
- **`rt.decisions()`, `rt.interventions()`, `rt.history()`, `rt.inflight()`, `rt.situation()`** for introspection.
- **Undo, where it exists:** `ActionRecord.undo()` is set for `discard` (delivery and write), late reverts,
  `rollback` and chain reverts, plus custom actions that register `onUndo`. `defer`, `coalesce`, `delay`, `block`,
  `serve_cached`, `retry`, `hedge` and `resync` cannot be undone; their record says what changed.
- **Altered responses** carry an `x-genclass` header: `coalesced`, `cached` or `blocked`.
- **Audit trail:** `rt.audit()` returns a JSON-serialisable record of every decision (acted on or not), action, undo,
  breaker trip and mode change, each with the mode, aggressiveness profile, gate thresholds, the model's
  probabilities and the model's name, version and sha256. `audit: { sink }` ships it to your logging.
- **What it touches:** [INTERCEPTION.md](INTERCEPTION.md) lists every API GenClass wraps or listens to, what each mode
  may change, what it never does, every action's preconditions and undo, and how `disable()` restores the page (a
  unit test keeps it in sync with the code). Threat model:
  [docs/runtime/THREAT-MODEL.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/THREAT-MODEL.md).
- **Devtools overlay** with four views: **Interventions** (what GenClass did, with Undo where it exists),
  **Detections** (what it noticed but did not act on), **Activity** (a live log of requests, writes, user actions and
  errors with their causal links) and **Now** (what the model would see at this moment). About 52 KB minified /
  17 KB gzip, so load it in development only (`init` does this for you):

```ts
if (import.meta.env.DEV) {
  const { mountDevtools } = await import("@genclass/runtime/devtools");
  mountDevtools(rt);
}
```

### See it where you already look

> **New in `0.3.0`.** `0.2.x` ignores `data-sink` and `sink=`, stops at `init --sink` with "unknown option", has no
> `@genclass/runtime/sinks` exports, and prints "a sink failed" for a sink name in `GENCLASS_CONFIG.sinks`. Pin
> `0.3.0-beta.0` or later in the script tag below.

In production the `[GenClass]` console lines print in your users' browsers, not yours. Sinks send every detection,
intervention, undo, breaker trip and runtime error to a tool you already open as well. The console default does not
change.

With `/auto` or the script tag you write no adapter code yourself:

```bash
npx @genclass/runtime init --sink sentry   # or posthog, datadog, console-json, webhook:/genclass; repeat it or comma-separate
```

```html
<meta name="genclass" content="sink=sentry+posthog">     <!-- + joins names: commas separate the meta keys -->
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.0" data-sink="sentry,posthog"></script>
<script>window.GENCLASS_CONFIG = { sinks: ["sentry", "webhook:/genclass"] };</script>
```

`init` suggests the flag when your `package.json` depends on a Sentry browser SDK (`@sentry/react`, `@sentry/vue`,
`@sentry/nextjs`, ...), `posthog-js` or `@datadog/browser-rum`. In a project with an entry file it writes its option
file: a sink whose SDK you install from npm is written as the adapter with your SDK passed in, since the npm Sentry
and PostHog SDKs set no page global and a name alone would reach nothing:

```js
// src/genclass.config.js, as `init --sink sentry,datadog` writes it next to @sentry/vue
import * as Sentry from "@sentry/vue";
import { sentry as sentrySink } from "@genclass/runtime/sinks/sentry";
globalThis.GENCLASS_CONFIG = { sinks: [sentrySink({ sentry: Sentry }), "datadog"] };
```

Every other sink stays a name: it loads its adapter on the first record and finds the SDK as a page global
(`window.Sentry` from the Sentry Loader Script or a CDN bundle, `window.posthog` from the PostHog snippet,
`window.DD_RUM`, which the Datadog snippets and `@datadog/browser-rum` both set). On a plain HTML page (`data-sink`)
or an Astro layout (`sink=` in the meta line) only names fit, so with an npm SDK there add `window.Sentry = Sentry;`
where your app imports it; `init` says so. An adapter that finds no SDK when a record arrives says so once in the
console. A `<meta>` tag only takes a same-origin webhook URL, checked as the browser resolves it (against the page and
`document.baseURI`); a cross-origin one is ignored with a console warning, so put a collector on another origin in
`data-sink` or `window.GENCLASS_CONFIG`. A webhook URL is made absolute once, at init, and only that endpoint (origin
and path) is excluded from what GenClass observes. Add `:noevidence` to a name (`sentry:noevidence`,
`--sink posthog:noevidence`) to send the structured fields without the evidence text. In code, pass the client to
`GenClass.init`:

```ts
import { GenClass } from "@genclass/runtime";
import { sentry } from "@genclass/runtime/sinks/sentry";
import { posthog } from "@genclass/runtime/sinks/posthog";
import { datadog } from "@genclass/runtime/sinks/datadog";
import { consoleJson } from "@genclass/runtime/sinks/console-json";
import { webhook } from "@genclass/runtime/sinks/webhook";
import * as Sentry from "@sentry/browser";
import posthogClient from "posthog-js";
import { datadogRum } from "@datadog/browser-rum";

GenClass.init({
  sinks: [
    sentry({ sentry: Sentry }),          // Sentry.captureMessage(line, { level: "warning", tags: { genclass: <diagnosis>,
                                         //   "genclass.mode", "genclass.action", ... }, extra: { genclass: <record> } }),
                                         //   one issue per bug; as: "breadcrumb" adds breadcrumbs instead
    posthog({ posthog: posthogClient }), // posthog.capture("genclass_detection", { diagnosis, p, action, route, message, ... })
    datadog({ rum: datadogRum }),        // DD_RUM.addError(GenClassDetection | GenClassIntervention), addAction("genclass_undo" | ...)
    consoleJson(),                       // console.log('{"source":"genclass","schema":1,"kind":"detection",...}') for log shippers
    webhook({ url: "/genclass" }),       // batched POSTs of { schema: "genclass-sink/1", version, records } to your endpoint
  ],
});
```

`@genclass/runtime/sinks` exports all five. No adapter adds a dependency or ever throws into your app. Without the
client option an adapter looks the global up on every record, so an SDK that loads later still gets them; without any
SDK it sends nothing and warns once. The Sentry, PostHog and Datadog adapters skip the per-session `summary` record;
they and the webhook cap repeats of one bug at 10 per page load (`maxPerSignature`). Every adapter takes `kinds`,
`sampleRate` and `evidence`.

**What a sink receives** is the record the runtime built and nothing else: `kind`, `route` (the page path with
id-like and email segments as `:id`, as telemetry sends it), `diagnosis` and its
probability `p`, `action`, `tier`, `trigger`, `mode`, `label`, `reason`, `changed` (state paths), `sessionId` and your
session `tags`, plus the evidence: the console line, the subject and the timeline, with URL query and fragment values
replaced by `…`. Timeline lines can hold short fragments of app data, as the console does (a store value summary, an
error message, text typed into an ordinary input; secret-named fields are `[redacted]`). `evidence: false` on an
adapter sends the structured fields only. A sink never gets the full situation text the model read, request or
response bodies, headers or cookies. The webhook POSTs exactly those records as
`{ schema: "genclass-sink/1", version, records }`, by `navigator.sendBeacon` (which GenClass never wraps, and which
survives page exit), else `fetch` with `keepalive`; the body is JSON sent as `text/plain` (no preflight), so parse it
as JSON. One POST carries the records GenClass hands over in one idle-time round, at most 50 records and 32,000
bytes of them, and each round sends at most one: the browser allows 64 KiB of beacons in flight per page, shared with
yours (your analytics on page exit, say), so GenClass never takes more than about half. What does not fit waits for the
next round, and on page hide one last batch goes (the session summary first) and the rest is dropped. Pass a `clock`
and `flushMs` to batch over a time window instead. `headers` switches it to `fetch`; then list the URL in
`requests.ignore` (the zero-code forms do that for you).

## Extend it

Plugins can add their own observers, facts, actions and questions:

```ts
rt.use({
  name: "sync",
  actions: [{
    name: "pause_sync",
    description: "pause background sync until the page is visible again",
    on: ["failure", "stall"],
    tier: "heal",
    run: (ctx) => { sync.pause(); ctx.describe("Paused background sync."); ctx.onUndo(() => sync.resume()); },
  }],
});
```

Plugins can add observers (`setup`), facts, actions, standing questions and diagnosis labels. The model reads each
action's description. The goal is that clearly described actions work without retraining; this has not been
measured.

## Configuration

GenClass runs with safe defaults (`mode: "observe"`, a `"balanced"` gate that applies once you opt into guard or heal, circuit breaker on). The options below narrow where it acts, cap how much it does, and send findings to your tools. None of them tell the model what a bug looks like. They only scope and limit it.

- **Your app** (`0.3.0`): `token` (your dashboard, see [Your dashboard](#your-dashboard)), `scope` (`"app"` or `"functions"`, see [protect()](#function-specific-protect)).
- **Activation**: `enabled` (a boolean, a predicate, or a subscribable feature flag; while it is false the model is never downloaded), `rt.disable({ undo: true })` (remote kill that also rolls back recent actions), `sample` (the fraction of sessions allowed to act; the rest only observe).
- **Scope**: `routes` (per-route mode and aggressiveness, which can only be lowered), `requests.ignore` (analytics traffic), `requests.protect` (endpoints that are never held, retried, cached or discarded), `requests.labels` (endpoint names for reports), `requests.correlate` (attach your trace id to records).
- **Safety**: `breaker` (automatic downgrade after undos, or after errors that follow an action), `shadow` (records what a higher mode would have done), `onBeforeAction` + `vetoMode` (a synchronous veto, or a report-only trial of one), `policy.actionLimits` (per-minute, per-subject and per-session caps), `policy.holdBudgetMs` (a hard ceiling on added latency).
- **Your own telemetry**: `sinks` (structured, redacted records; ready-made adapters in `@genclass/runtime/sinks` for Sentry, PostHog, Datadog, JSON console lines and a webhook, see "See it where you already look"), `session` (id and tags, never shown to the model), `report: "interventions"` (a quiet production console), `rt.summary()`, `rt.on("shadow" | "breaker" | "limit" | "modelBudget", cb)`.
- **Loading and cost**: `model.loadIf`, `model.threads`, `model.timeoutMs`, `model.maxDecisionsPerMinute`, `model.unloadAfterIdleMs`.

Action limits default to 60 per minute overall, 10 per minute on the same subject (store field or endpoint), and 200 per session.

URL overrides (`?genclass`, `?genclass-mode`, `?genclass-aggr`, `?genclass-sample`, and `localStorage.genclass`) can only lower settings, unless `debug: true` is set or the page is on a development host (`localhost`, `*.local`, `*.test`, private networks). Since 0.2.2 a link such as `?genclass=guard` can no longer raise a production site that set no `mode` (it stays in `observe`).

```ts
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init({
  mode: "guard",
  aggressiveness: "cautious",
  enabled: {                                         // live feature flag; flipping off disables mid-session
    get: () => flags.isEnabled("genclass") && consent.analytics,
    subscribe: (cb) => flags.onChange("genclass", cb),
  },
  sample: 0.1,                                       // 10% of sessions act, 90% observe
  routes: [
    { match: "/checkout/*", mode: "observe" },
    { match: /^\/admin/,    mode: "off" },
  ],
  requests: {
    ignore:  ["https://www.google-analytics.com/", /sentry\.io/, "*/rum/*"],
    protect: ["/api/auth/", "/api/payments/", (r) => r.method !== "GET" && r.url.includes("/billing")],
    crossOrigin: "observe",
    labels: [{ match: "/api/orders", label: "place order" }],   // reports only by default
    correlate: (r) => r.headers["x-request-id"],
  },
  breaker: { undos: 2, errorsAfterAction: 3, attributionMs: 5000, downgradeTo: "observe" },
  shadow: "heal",
  onBeforeAction: (a) => !(cart.isSubmitting && a.tier === "heal"),
  vetoMode: "enforce",
  policy: { actionLimits: { perMinute: 30, perSubject: 3, perSession: 100 }, holdBudgetMs: "auto" },
  report: import.meta.env.PROD ? "interventions" : "console",
  sinks: [
    { send: (r) => navigator.sendBeacon("/genclass", JSON.stringify(r)),
      kinds: ["intervention", "undo", "breaker", "summary"] },
    { send: (r) => Sentry.addBreadcrumb({ category: "genclass", data: r }), sampleRate: 0.2 },
  ],
  session: { tags: { release: __RELEASE__, tenant: tenantTier } },
  learn: { persist: "local", key: "genclass:shop" },  // version = session.tags.release at init
  model: {
    preload: "idle",
    loadIf: { minDeviceMemoryGB: 8, saveData: "skip" },   // default { minDeviceMemoryGB: 4, saveData: "skip" }
    threads: 2,
    timeoutMs: 10_000,
    maxDecisionsPerMinute: 30,
    unloadAfterIdleMs: 300_000,
  },
});

rt.on("breaker", (e) => log.warn("genclass downgraded", e));
onLogin((u) => rt.setSession({ tags: { plan: u.plan } }));
onLogout(() => rt.learn.clear());
onIncident(() => rt.disable({ undo: true }));
```

**What is in force:** `rt.status.effectiveMode` is the mode the runtime acts in now (the requested mode, demoted by
`sample`, the breaker and the matching `routes` rule). `rt.status.scope` is the same for the current route:
`{ route, mode, aggressiveness }`, plus `rule` (index into `routes`) and `ceiling` (that rule's mode) when a rule
matches. Route rules only ever lower the mode. `rt.gates()` carries the same `mode` next to the thresholds.

**Payments, checkout and sign-in: keep them observe-only.** Automatic intervention in money and identity flows is not
recommended. `requests.protect` is checked before everything else, in every mode, and covers the request, its
response and everything its response callbacks cause. Opt-in presets (adapt or extend them to your endpoints):

```ts
import { GenClass, protectPreset } from "@genclass/runtime";
GenClass.init({ mode: "guard", requests: { protect: [...protectPreset("payments", "auth"), "/api/cart"] } });
// JSON configs (window.GENCLASS_CONFIG, the file `init` writes): requests: { protect: ["preset:payments", "preset:auth"] }
```

`payments` matches URL words such as checkout, payment(s), payment intents, billing, invoices, charges, refunds,
subscriptions, orders, transactions, transfers, wallets and Stripe/PayPal/Braintree/Adyen/Klarna/Square; `auth`
matches login, logout, sign-in/up, oauth, tokens, sessions, SSO, MFA, OTP, passwords and verify. `npx
@genclass/runtime init` suggests them when your project uses a payment SDK. Details:
[INTERCEPTION.md](INTERCEPTION.md#money-and-identity-flows).

**Rollout recipe:** start with `mode: "observe", shadow: "guard"`, and compare the shadow records with your undo and complaint rates. Then switch to `mode: "guard", sample: 0.05`. Watch `rt.summary().undos` and `breaker` events, and widen `sample` as they stay quiet. For QA, `?genclass-sample=1` together with `debug: true` forces a session into the acting group.

## Model quality

The default model is `genclass-runtime-r17` 2.0.0-rc4t (`@genclass/runtime-model@0.2.0`, run `r17-v2dT`): a
GenClass encoder trained on simulated apps and on real apps driven in headless Chromium. It ships a gain gate (act
only when the model's expected gain over doing nothing clears a margin) with one fitted profile per aggressiveness
level. Held-out test, from
[RESULTS.md §1](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md):

| profile | guard false interventions | guard recall (clear / real) | heal false interventions | heal recall (clear / real) | report threshold |
|---|---|---|---|---|---|
| `cautious` | 0.005% | 2.4% / 1.4% | 0.26% | 3.7% / 3.8% | 0.95 |
| **`balanced` (default)** | 0.13% | 7.8% / 7.5% | 0.59% | 7.1% / 10.4% | 0.90 |
| `eager` | 0.54% | 14.2% / 21.0% | 1.84% | 17.1% / 24.2% | 0.70 |

False interventions are on simulated apps; on held-out real apps they were 0.00% for every profile. Our targets are
0.1% (guard) and 0.5% (heal): `cautious` meets both, `balanced` is slightly over both, `eager` trades well over
them for about twice `balanced`'s recall. Pick `cautious` if a wrong intervention costs more than a missed one.

The observe-mode numbers below were measured on the previous model, 0.1.0 (`r17-v2b`, report threshold 0.85), and
have not been re-measured for 0.2.0:

| model 0.1.0 | Simulated apps | Real apps |
|---|---|---|
| Diagnosis accuracy | 84.2% | 83.6% |
| Action accuracy | 77.8% | 80.0% |
| **Observe:** decisions flagged where nothing was wrong (report 0.85) | 1.41% (149 / 10,582) | 3.78% (305 / 8,079); 1.05% without one app |
| Observe: problem decisions flagged | 65% | 61% |
| Observe: flags with the right diagnosis | 94% | 89% |

What this means in practice:

- **Observe (default).** Expect roughly 1 to 4 false flags per 100 decisions where nothing was wrong (model 0.1.0;
  `cautious` raises the report threshold to 0.95, `eager` lowers it to 0.70). `0.3.0` adds *possible* detections at
  the `eager` value (0.70) in observe, on `console.debug` only. The 0.2.0 fit held eager-profile detections (likely
  and possible together) to at most 5% (real apps) / 6% (simulated) false per clean decision on held-out test,
  against 2% / 3% at `balanced`; the share of possible detections that are false is not measured and is expected to
  be well above the likely tier's
  ([RESULTS.md §11](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md)).
  - In one held-out real app, `oss-rtk-conduit`, the model flagged 25% of clean decisions as `stale`, all on its
    `article.inProgress` field. A single recurring pattern in your app can do the same.
  - Each flag names its evidence, and identical lines within a minute are summarised.
  - Raise `policy.thresholds.report` to see fewer flags. At 0.9: 0.9% (simulated) and 3.4% (real) false, with 58% and
    52% of problems flagged.
- **Guard (opt-in).** When it acts, it is almost always right, but it rarely acts. Expect it to miss most problems.
  `balanced` is slightly above the 0.1% false-intervention target; `cautious` is under it.
- **Heal (experimental).** At `balanced`, 0.59% of heal interventions were wrong on simulated apps (target 0.5%);
  with model 0.1.0, heal actions on failures (`retry`, `serve_cached`) were its least precise actions.
- **Not yet met:** diagnosis ≥ 95%, clear-case recall ≥ 80%, and false flags ≤ 1% on held-out data. Training
  continues (a larger teacher model, distillation, more real-app data).
- **Format.** The model was trained on situations rendered by the runtime at `situation-v2`. This version renders
  `situation-v2.3`:
  - an extra stall fact;
  - `retry` offered only when safe;
  - fewer learned relations;
  - redacted values printed differently.

  The retry change is accounted for in the numbers above; the others were not measured.

**Round 1** (previous format `situation-v1`, not compatible with this runtime): R17 reached 90.5% diagnosis and 81.9%
action accuracy on held-out simulated apps, with 0.05% / 0.24% guard / heal false interventions, but acted on only
7.7% of clear cases. The analysis found the limit was in the situation text and the labels, not the model size. The
v2 format adds measured facts for those cases, with relabelled data.

The "never make a correct app worse" check uses an always-passive model in heal mode, compared against observe mode,
on 66 real apps (6 seeds each), with the v2 runtime as of `0.1.0-alpha.1` (not re-run on this version).
**0 of 396 clean runs** changed, measured on final page text (inputs and alerts
excluded) and server state. The check does not compare request timing or store contents, and it does not compare
observe mode against running without GenClass. With network chaos, 3 of 198 runs differed: a request held about
25 ms changed the simulated network's draws. Details:
[RESULTS.md §4](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md).

## Performance

- **Most work never reaches the model.** Facts are computed for every write and request. Measured by the perf tests
  on a shared VM:

  | operation | time |
  |---|---|
  | keystroke write into a store holding a 5,000-item array | 0.22 ms |
  | Redux-style dispatch on 5,000 entities | about 0.7 ms |
  | settled-point check | 0.3 ms |

- **Bundle:** what every page loads is about 108 KB gzip for `@genclass/runtime/auto` with automatic state
  discovery and 100 KB for the main entry with `GenClass.init()`, which does not carry discovery: 107.56 KB and
  99.59 KB, minified and gzipped by esbuild in `test/bundle.test.ts` (CI run 38482297879), which keeps them under
  107.74 KB and 99.71 KB (the `0.3.0-beta.0` release build's 106.24 / 98.21 KB plus 1.5 KB). `0.2.2` measured
  99.17 KB and 91.70 KB; `0.3.0` adds the app token and `protect()`, the device floor, telemetry sampling, the sink
  names' proxy and the learned-state persistence (docs/runtime/RESULTS.md §10), then observe's detection tiers and
  deferred situations (+1.3 / +1.4 KB, §11). The model worker, ONNX Runtime Web's JavaScript (about
  70 KB gzip for WASM, 115 KB with WebGPU, minified), the devtools, the sink adapters and the opt-in flow
  expectations are separate chunks loaded on demand.
  ONNX Runtime's own `.wasm` (14 MB, 3.1 MB brotli; 27 MB, 5.5 MB brotli with WebGPU) is never part of your build:
  the runtime fetches it when the model loads (from jsDelivr, or `model.ortWasmPaths`). The script-tag file is about
  128 KB gzip (127.89 KB in the same CI run, with discovery, the sink names' proxy and the flow expectations inline);
  its model worker, ONNX Runtime glue and sink adapters load on demand.
- **Model:** the default model is 10.2 MB (q8, pruned 16k vocabulary) on WASM and 13.6 MB (fp16) on WebGPU with
  `shader-f16`. With onnxruntime-web 1.30 on single-thread WASM, measured in Node on the training VM, a forward pass
  took about 182 / 330 / 599 ms at 500 / 780 / 1,170 tokens: about 180 ms per decision at the single-thread budget
  (1,000 characters, about 500 tokens with the questions), which is the budget single-thread WASM uses.
- **Holds are bounded.** A held response or request waits at most the hold budget, then proceeds unchanged. The
  default `"auto"` budget is 1.5 × the median of the last 20 model latencies, clamped to 150–800 ms; it is 300 ms
  before any latency is known.
  - A hold happens only if the model is expected to answer within the budget.
  - Reading a response body for salience adds at most 100 ms.
  - Background (non-held) decisions have a 5 s deadline.
- **Situation size by device:** 2,400 characters on WebGPU; on WASM, 1,000 (1 thread) to 2,000 (4 threads).
  Override with `situation: { budget }`.
- **Threads:** serving the page with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` enables WASM threads (about 3× faster with 4 threads in Chromium,
  measured with the round-1 model of the same size).
- **Loading:** the model loads at idle after page load (`model.preload: "idle"`) from
  `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/`, except on devices that report 2 GB of
  memory or less and on Save-Data connections (the default `model.loadIf` since `0.3.0`, see [Costs](#costs)). It is cached in
  Cache Storage and checked with sha256. To self-host, see
  [Content-Security-Policy and self-hosting](#content-security-policy-and-self-hosting). `model: false` loads no
  model (nothing is detected or prevented then).

## Costs

Measured in a real app (a pilot app, 2026-10-09: a Next.js 16 ordering site, production build, Playwright Chromium,
390×844 mobile viewport, 4× CPU throttling, medians of 5 runs, observe mode, `0.1.0-beta.3`), the same build with and
without `?genclass=off`:

| | with GenClass |
|---|---|
| JavaScript on every page (first load, gzip) | about +108 KB (`/auto` with discovery; 100 KB for the main entry, see Performance) |
| Main thread: load event, LCP, long tasks | no measurable change; main JS heap +0.4 MB |
| **Memory: renderer process (holds the model worker)** | **+190 to 280 MB RSS** while the model is loaded (cold 448 vs 169 MB, warm 361 vs 171 MB) |
| **First visit download** | **about 13 MB** after the load event (q8 model 10.2 MB, ONNX Runtime wasm 3.07 MB brotli, tokenizer 207 KB); WebGPU devices: 13.6 MB fp16 model plus the larger ONNX Runtime build |
| Later visits | about 1 KB (`model.json` revalidated); the rest comes from Cache Storage, checked with sha256 |
| Model load | WASM (1 thread): 0.9 to 1.3 s cold, 0.4 s warm. WebGPU (Apple M-series): 12 s cold, 2 s warm |
| App build output | `0.1.0-beta.3`: +41 MB of unused ONNX Runtime files. `0.2.0`: none |

**Automatic state discovery** (`0.2.0`, the pilot app with only the one line, 2026-10-10; same build with
`autoState: false` as the control; Playwright Chromium, 390×844, observe mode, telemetry off):

| | cost |
|---|---|
| JavaScript (first load, bytes on the wire) | +7 KB on `/menu` (discovery's share of the `/auto` entry; `GenClass.init()` setups do not load it) |
| React commit walk, 4× CPU throttling | p50 0.2 ms, p95 1.8 ms, max 2.1 ms per commit including recording the change; total about 5 ms over the `/order` visit |
| React commit walk, no throttling, 54 bench trials (about 2,000 commits) | p50 below 0.1 ms (the timer's resolution), p95 0.8 to 0.9 ms, max 3.8 ms |
| Main-thread JS heap (after GC, 4× throttling) | 5.7 MB vs 5.2 MB without discovery |
| Long tasks (> 50 ms) | unchanged (1 per run, 65 to 70 ms, with and without) |

**On phones** the memory and the download are what matter (the page may also run a call, the camera or a
recorder). **By default the model is not loaded on devices that report 2 GB of memory or less, nor on Save-Data
connections** (since `0.3.0`; `0.2.x` loads everywhere and only lazily on Save-Data; `model.loadIf` defaults to `{ minDeviceMemoryGB: 4, saveData: "skip" }`; `navigator.deviceMemory` is
quantised to powers of two, so 4 is exactly that floor; Safari and Firefox do not report it and load). The runtime
then keeps observing without a model (nothing is detected or prevented on that device) and prints one line,
`[GenClass] Model not loaded: this device reports 2 GB of memory and model.loadIf asks for at least 4 GB. …`.
Options on top of that:

```ts
GenClass.init({
  model: {
    // no model on phones at all (Chromium reports userAgentData.mobile; Safari does not), or a higher floor
    loadIf: (env) => !env.mobile && (env.deviceMemoryGB ?? 8) >= 8,
    // or everywhere, floor and Save-Data ignored: loadIf: () => true
    preload: "lazy",            // download on the first salient situation, not at idle on every page
    unloadAfterIdleMs: 60_000,  // free the worker's memory after a minute without a decision
  },
});
```

`model: false` keeps the runtime observing (console reports, `rt.status`, devtools) with no download and no worker.

## Content-Security-Policy and self-hosting

By default the model files and ONNX Runtime's wasm come from `https://cdn.jsdelivr.net`, fetched by a worker. A
policy whose `connect-src` does not allow that origin blocks them: GenClass then keeps observing without a model and
prints **one** console warning naming the blocked origin and the fix (`status.blocked` has the details). Either allow
`https://cdn.jsdelivr.net` in `connect-src`, or self-host (no third-party origin):

```bash
npx @genclass/runtime fetch-model public/genclass-model   # model + ONNX Runtime files (into public/genclass-model/ort/)
npx @genclass/runtime init --model-url /genclass-model/   # or pass the options yourself:
```

```ts
GenClass.init({ model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" } });
```

- `fetch-model` downloads every model variant and both ONNX Runtime builds (about 64 MB). `--variant q8 --ort wasm`
  is about 24 MB; then also set `model.device: "wasm"` (`init --model-url` does it when it finds only the WASM
  build there). The WebGPU build's wasm is 27 MB, over the 25 MiB per-file limit of some static hosts (Cloudflare).
- The policy also needs `'wasm-unsafe-eval'` in `script-src` (WebAssembly) and `worker-src 'self'` (or `blob:`
  for the script tag). When the worker cannot start (a policy without it, `file:`), the default
  `model.inlineFallback: true` runs the model on the main thread instead (the `Model ready` line then says
  `inline on the main thread`; each decision then blocks the page for about 180 ms on single-thread WASM, see
  Model above). `model: { inlineFallback: false }`
  skips the model in that case (`status.state` `skipped`, reason `worker-unavailable`, one warning naming the
  worker error) and the runtime observes without it.
- Anonymous diagnostics (on by default on public hosts) go to `https://genclass.dev/api/v1/events`: add
  `https://genclass.dev` to `connect-src`, or pass `telemetry: false`. A blocked page stops trying after 3 failed
  requests, so the policy logs at most 3 violations.
- Sinks ([See it where you already look](#see-it-where-you-already-look), `0.3.0`): a webhook on another origin
  needs that origin in `connect-src` (a same-origin path such as `webhook:/genclass` needs nothing). With the script
  tag, `data-sink` (or `sink=` / `GENCLASS_CONFIG.sinks`) loads `dist/sinks/<name>.js` and the chunk the adapters
  share from the tag's own CDN path, so allow `https://cdn.jsdelivr.net` in `script-src`, or self-host this package's
  `dist/` and point `data-base` at it. With `/auto` the adapters are chunks of your own bundle. The Sentry, PostHog
  and Datadog SDKs need the CSP entries their own docs list.

## Privacy and telemetry

- **Decisions are local.** Situations are built and decided in the browser by the local model; nothing is sent anywhere to make a decision.
- **Anonymous diagnostics are on by default** with `GenClass.init()` in a browser, except on local and private hosts (`localhost`, `*.localhost`, `*.local`, `*.test`, `127.0.0.1`, `::1`, private IP ranges) (`0.2.1` sends from local hosts too, by mistake; fixed in `0.2.2`, see the CHANGELOG), in Node/SSR, and in `createRuntime()`. They go to the GenClass maintainers' collector ([`telemetry-worker/`](https://github.com/genclass-dev/GenClass-lib/tree/main/telemetry-worker), a Cloudflare Worker writing to a private R2 bucket) and are used to improve the model.
- **By default no text from your page is sent.** Sent: a random per-page session id, versions, mode, device class, the app's hostname and id-normalised path, and per decision (every detection and every decision whose diagnosis is not `expected`, every action and veto; of the routine ones, one in four and at most 200 per page load; counts are exact; `0.2.2` and earlier send every decision) the trigger, the diagnosis and its confidence, the action and gate, the outcome and latency. The collector stores no IP address or user agent. One console notice per page says it is on.
- **The situation text the model read is sent only if you opt in** with `GenClass.init({ telemetry: { include: { situation: true } } })`. It is redacted by field meaning, but can still contain route names with query strings, short error messages and short field values; read [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md) before enabling it.
- **Opt out:** `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry`, `localStorage.setItem("genclass.telemetry", "off")`; browsers sending Global Privacy Control are never collected.
- **With a token** (`0.3.0`: `token` option, `data-token`, `token=` in the meta tag), each batch also carries
  your app's public token, so the same diagnostics also show on your app's private dashboard (whoever holds its link
  can open it), and decisions about `protect()`ed functions carry the function's name (`fn`, the label you chose).
  Without a token neither is sent; without telemetry, a token does nothing.
- **Possible detections** (`0.3.0`, observe): their `detect` events carry `tier: "possible"` (a likely detection
  has no `tier`, as before), and the page-load summary counts them apart from detections (`possibleDetections`). They
  say which tier a detection was in; nothing new about the page is sent.
- **The CLI** contacts genclass.dev only for the command you run: `init` creates a dashboard only after you approve its
  diff (it sends the `name` from `package.json`); `login` asks for a sign-in code with
  `client_name: "genclass-runtime <version>"` (shown on the approval page and in your account's session list) and
  polls until you approve it; `whoami` and `connect` read your account's apps; `connect` sends a new app's name, or an
  existing dashboard's link from `.genclass.local` to add it to your account; `logout` ends the CLI session. The
  account requests carry `user-agent: genclass-runtime-cli/<version>`. What an account stores: [PRIVACY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md).
- Apps that ship GenClass may need to disclose this to their users (GDPR/CCPA). Full schema, storage and guidance: [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).
- Other telemetry options: `npx @genclass/runtime init --no-telemetry` writes the opt-out into your project (`telemetry=off` in the meta tag or `data-telemetry="off"` on the script tag do the same); `telemetry: { endpoint, sample, decisionSample, maxDecisions, flushMs, maxBatch, include }` sends to your own collector, samples page loads or decision records, caps them per page load, or tunes batching; `runtime.telemetry` tells whether it is on and why not. Privacy policy: [PRIVACY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md).
- **Inputs:** typed values of password fields, `cc-*` / `one-time-code` / password autocomplete fields, and fields
  whose name or label names a secret are never recorded.
- **Redaction:** the default redactor (`redact` option) works by the leaf field's meaning, not by substring.
  - Redacted: `auth.token`, `form.password`, `users.3.password`, `payment.card.number`, `settings.apiKey`, and
    opaque credential-like strings under `auth` / `session` / `cookie`.
  - Under a container named for a secret, strings, numbers and arrays are all redacted: `payment.cvv.value = 123`,
    `login.otp.code`, `account.password.history = [...]`. A side effect: numbers under a container whose name is
    a secret word in another sense are hidden too (`map.pin.lat`).
  - Visible: `auth.loading`, `auth.user.name`, and a kanban `card`.
  - Booleans and null are never redacted.
  - Query parameters are redacted by the same rule.
  - The "would replace text the user typed" fact shows a character diff only when the redactor leaves both values
    unchanged; otherwise it prints `[redacted] → [redacted]` (or your redactor's replacement).
  - Pass your own `redact(path, value)` for app-specific secrets or PII. The default has gaps (see below).
  - The container rule for numbers and arrays and the typed-text rule are new in `0.1.0-beta.0` (missing from
    `0.1.0-beta.1`, back in `0.1.0-beta.2`).

## Known limitations

- **The model is new and imperfect.** The numbers are under [Model quality](#model-quality).
  - In observe mode, expect some false flags: 1–4 per 100 decisions where nothing was wrong, more in some apps.
  - It misses most problems.
  - It was not evaluated on your app.
  - Heal-mode actions on failures (`retry`, `serve_cached`) are its least precise actions.

  Watch observe mode before turning on `guard` or `heal`.
- **Redaction gaps (all modes with a model).**
  - A container named by a two-word secret (`cardNumber`, `apiKey`, `creditCard`) counts as broad, like `auth`.
    So `payment.cardNumber.value = "4111 1111 1111 1111"`, or the same number, is shown. It reaches the situation
    text, `explain()`, the console evidence and devtools, and the telemetry situation text if you opted in. A leaf
    with such a name
    (`settings.apiKey`) is redacted.
  - The fact "X changed since #N started and is back to V" compares the rendered text, so two different redacted
    values read as "back to [redacted]".

  Pass a custom `redact`, and avoid keeping secrets in observed stores.
- **The discard mark lasts 10 s.** After a `discard`, writes by operations chained from the discarded one (a
  `setTimeout`-driven poll, a saga) to the protected fields are also dropped for 10 s, even when they carry fresh
  data. The marks also outlive `rt.pause()` and `setMode("observe")`.
- **`defer` can wait long.** A delivery may be deferred twice, each time until the related operations finish or
  10 s pass. A deferred WebSocket/EventSource message holds back the messages queued behind it.
- **Held messages after `close()`.** A WebSocket/EventSource message held for a decision is still dispatched if
  the app closed the socket meanwhile. EventSource `open` events are not kept in order behind held messages.
- **XHR listeners of a held response** run after the original dispatch, so `e.currentTarget` is `null`. Use the
  `xhr` object itself.
- **`retry` (heal) trusts HTTP semantics.** It is offered for idempotent methods, and for POST / PATCH only when
  the request carries an idempotency key (`policy.idempotencyHeaders`, default `Idempotency-Key`,
  `X-Idempotency-Key`). An endpoint that is not idempotent despite its method (a `PUT` that appends) can still be
  retried. HTTP 502 is described as usually not processed, which is not always true behind proxies.
- **Transport coverage.** `coalesce`, `retry`, `hedge` and failure/stall `serve_cached` are fetch-only. XHR
  failures and stalls are detection-only.
- **Synthetic events.** DOM events with `isTrusted === false` (`el.click()`, `dispatchEvent`, in-page test
  drivers) are not user actions unless you pass `observe: { untrustedEvents: true }`.
- **`policy.holdWrites: true` (opt-in).** A held write that a later write flushed early can be recorded as dropped
  while it stays applied.
- **Causality** across `await` is tracked by instrumenting fetch, XHR, timers, message events and Response bodies.
  This is best effort; wrap important work in `rt.op(name, fn)` for exact attribution.
- **Store state.** With the one line, React, Redux and Zustand (`devtools`) state is discovered; discovered React
  and Zustand state is observed only (detections and delivery `deliver` / `defer`, no write actions). Zustand's
  `devtools` middleware is off in production builds unless you pass `enabled: true`, and then nothing is discovered
  from it (measured in the [compatibility matrix](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md)). Other state
  (Vue / Pinia, MobX, Jotai, signals, module variables) is seen only through its effects unless you register it.
  Discovered React state has no variable names (`Comp.state0`), production builds minify component names (the store
  is then named after the element the component renders), and a component's store appears on its first state change.
  A response is checked against newer data only once GenClass has seen what that request writes, so the first
  response of each kind after a page load is never a delivery decision. See
  [Automatic state discovery](#automatic-state-discovery).
- **Install and CDN.**
  - **Read the diff.** Always read the diff `init` and `remove` show before you confirm.
  - **SRI covers only the script-tag file.** The model worker, ONNX Runtime glue and overlay it loads from the CDN,
    and the model files, are not integrity-checked by the browser. The runtime checks the model files against the
    sha256 values in `model.json`. Pin a version, or self-host.
  - **Page configuration is read from `<meta name="genclass">` tags in `<head>` only** (since 0.2.2), so markup
    injected into the body cannot configure GenClass. A meta tag may set the mode; the model and ONNX Runtime URLs it
    names must be on the page's own origin (relative or same origin), otherwise they are ignored with one warning.
    Point at a CDN of your own with the script tag's `data-model` / `data-ort`, `window.GENCLASS_CONFIG` (it
    overrides meta tags) or `GenClass.init(options)`. A page that lets untrusted HTML into `<head>` should not use
    meta configuration at all.
  - **React Router dev server.** On the very first dev start after `init`, Vite discovers the new imports late,
    re-optimizes and reloads the page, logging a few "Outdated Optimize Dep" errors once. Later loads are clean.
  - **Scaffolds not re-run.** The framework scaffold runs predate this version's `init` / `remove` changes, which
    are covered by unit tests; the compatibility matrix is the current end-to-end evidence.
- **The model can be wrong.** It is trained on simulated apps and real apps driven in a headless browser. It is not
  a substitute for tests. That is why the default only observes, guard acts only above thresholds fitted to keep
  false interventions at or below 0.1% on data the model never trained on, and every action is logged.

## License

Apache-2.0. The model package, `@genclass/runtime-model` (Apache-2.0), comes with its own
[model card](https://www.npmjs.com/package/@genclass/runtime-model).
