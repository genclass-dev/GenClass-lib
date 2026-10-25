# Installing GenClass Runtime

How to add `@genclass/runtime` to a web app and take it out again: the `init` and `remove` commands with every
flag, the app token and dashboard that `init` creates, the zero-code options, the import, the script tag and its
attributes, `GenClass.init()`, and the projects `init` was tested on. For `@genclass/runtime` 0.3.0 (`0.3.0-beta.0` on the npm
`beta` dist-tag). The short version is in the [package README](../../packages/runtime/README.md#install).

## Which version should I install?

While `0.3.0` is in beta, every npm and npx command here names the `@beta` dist-tag. Without it you get the stable
`0.2.x` (`0.2.2` was npm `latest` on 2026-10-22; `npm view @genclass/runtime dist-tags` shows them now), whose
runtime ignores a token and whose CLI has no `login`, `connect`, `whoami`, `logout`, `dashboard`, `--token` or `--sink`. Both
lines load model `@genclass/runtime-model@0.2.0` by default.

Pin the script tag's version (`https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.0`): the unversioned URL
serves the `latest` dist-tag (`0.2.2` on 2026-10-22) until 0.3.0 is released.

**Older versions.** `0.1.0-beta.3` has these problems, fixed in `0.2.0`: app builds carried 41 MB of unused ONNX
Runtime wasm, a CSP-blocked model failed silently, `init` could not turn telemetry off, and `status.scope.mode` read
"heal" in observe mode. `0.1.0-beta.2` is `0.1.0-beta.3` without telemetry. `0.1.0-beta.1` has model 0.2.0 and the
new options but defaults to `guard`, and lacks the observe-delivery, redaction and install fixes of `0.1.0-beta.0`
(all back in `0.1.0-beta.2`). `0.1.0-beta.0` ships model 0.1.0. `0.1.0-alpha.0` (v1 runtime: guard by default, holds
store writes, `NaN` crash) and `0.1.0-alpha.1` (observe by default, but no model was published for it) predate the
model; do not use them. Anonymous diagnostics are on by default from `0.1.0-beta.3`; `0.1.0-beta.3` to `0.2.1` also
send them from `localhost` and other local hosts, and `0.1.0-beta.3` to `0.2.0` send the redacted situation text by
default ([CHANGELOG](../../packages/runtime/CHANGELOG.md)).

## How do I install it with one command?

`init` finds your framework and package manager, installs the package, adds one import as the first line of your
entry file (plus a line that loads the devtools overlay in development only), and shows you the diff before writing
anything. Running it again changes nothing; running it with another `--mode` switches the import it added. All of
the ways below start the same runtime, in observe mode unless you choose otherwise.

```bash
npx @genclass/runtime@beta init               # observe; shows the diff, asks, then writes
npx @genclass/runtime@beta init --mode guard  # let GenClass act (also: --mode heal); run again later to switch
npx @genclass/runtime@beta init --yes         # no questions
npx @genclass/runtime@beta init --dry-run     # show the diff, write nothing
npx @genclass/runtime@beta remove             # undo exactly what init added
```

`init` also says that telemetry is on by default and how to turn it off, and when your app sets a
Content-Security-Policy (`next.config` headers, a proxy or middleware, a `<meta http-equiv>`, helmet, `vercel.json`,
`_headers`, ...) it prints the steps to self-host the model
([Content-Security-Policy and self-hosting](../../packages/runtime/README.md#content-security-policy-and-self-hosting)).

### Every `init` and `remove` flag

| flag | command | what it does |
|---|---|---|
| `--mode observe\|guard\|heal` | init | the mode of the import init adds (default `observe`: reports only; never holds, delays or changes a request, response or state write) |
| `--token <gc_...>` | init | use this app token; genclass.dev is not contacted |
| `--no-token` | init | no token and no dashboard; genclass.dev is not contacted (the package manager still runs unless `--no-install`; add a token later at [genclass.dev/start](https://genclass.dev/start)) |
| `--no-telemetry` | init | turn off GenClass's anonymous diagnostics; implies `--no-token` (a dashboard only gets data while telemetry is on) |
| `--telemetry` | init | undo `--no-telemetry`: back to the default (on, but never from local hosts); init takes the opt-out out and writes no telemetry option of its own |
| `--model-url <url>` | init | use a self-hosted model directory (made with `fetch-model`), with ONNX Runtime from `<url>ort/` |
| `--sink <name>` | init | also send findings to your own side: `console-json`, `console-json:noevidence` or `webhook:<url>`; repeat the flag or comma-separate ([SINKS.md](SINKS.md)) |
| `--yes`, `-y` | both | apply without asking |
| `--dry-run` | both | show what would change; write nothing, send nothing |
| `--no-install` | init | do not run the package manager |
| `--no-devtools` | init | do not add the dev-only devtools overlay |
| `--cwd <dir>` | both | the project directory (default: the current directory) |
| `--from <spec>` | init | install `@genclass/runtime` from this spec (a version, tag or tarball path) |
| `--cdn <url>` | init | plain HTML: the script URL (default: jsDelivr, this version, with an SRI hash; this version's unpkg URL gets one too; other URLs get no hash) |
| `--no-sri` | init | plain HTML: no integrity attribute |
| `--strategy instrumentation\|layout\|pages` | init | Next.js only: where the import goes. By default `instrumentation-client` on Next.js 15.3 and later, else `layout` (App Router) or `pages` (Pages Router) |
| `--keep-package` | remove | leave `@genclass/runtime` installed (by default `remove` uninstalls it if nothing else imports it) |

`npx @genclass/runtime@beta init --help` prints the same list except `--strategy` (Next.js only). The account
commands (`login`, `connect`, `whoami`, `logout`, `dashboard`) and their flags are in [DASHBOARD.md](DASHBOARD.md); `fetch-model`
and `info` are under [Content-Security-Policy and self-hosting](../../packages/runtime/README.md#content-security-policy-and-self-hosting).

### What does `init` edit, and what does `remove` delete?

- **What `init` edits.** It only edits browser apps. It stops and says why for a Node server, a library (a UI
  framework as a peer dependency, or an `exports`, `module`, `types` or `bin` field), or an entry file that imports
  Node-only modules.
- **What `remove` deletes.** Only what `init` wrote (the lines and blocks it marked), including lines a formatter
  rewrapped. If you edited a marked line or block, it changes nothing and lists where.
- **Read the diff.** Always read the diff `init` and `remove` show before you confirm.

### Options without editing code

These also work on a project `init` already set up; `remove` takes them out too:

```bash
npx @genclass/runtime@beta init --no-telemetry                # anonymous diagnostics off (--telemetry: explicitly on)
npx @genclass/runtime@beta init --model-url /genclass-model/  # a self-hosted model
npx @genclass/runtime@beta init --sink webhook:/genclass     # findings to your own endpoint too; also console-json
```

They go into a marked `genclass.config.ts` (or `.js`) next to your entry, which sets `window.GENCLASS_CONFIG` and is
imported right before the `/auto` import (an ES module's imports run before its own code, so options cannot be set
above the import in the same file). Any `GenClass.init()` option works in that file. Plain HTML gets
`data-telemetry="off"` (and `data-model`, `data-ort`, `data-sink`) on the script tag, Astro a `<meta name="genclass">`
line.

## How does `init` create a token and a dashboard?

New in `0.3.0`; `init` in `0.2.x` creates no token. On a new setup, once you approve the diff (or pass `--yes`),
`init` also creates a project for your app at genclass.dev: it sends `package.json`'s `name` to
`https://genclass.dev/api/projects`, writes the token it gets back into what it adds (the diff shows
`gc_new-token-created-when-you-apply` in its place until then), and prints your private dashboard link:

```
  Your dashboard  https://genclass.dev/dashboard/...
  Keep this link private; it is the only way to open your dashboard.
  Saved in .genclass.local (added to .gitignore).
```

From `0.3.0-beta.1`, `init` also says after the second line that the dashboard is free; from `0.3.0-beta.2` that
reads:

```
  Free for every app: what GenClass found, on which pages, and what it did, and (with analytics: true)
  how visitors use each page. Print this link again any time: npx @genclass/runtime dashboard
```

The link is saved in `.genclass.local` (with the token) before init writes anything else, so a failed write cannot
lose it. init asks git whether that file is ignored; if not, it adds it to the project's `.gitignore` (inside a git
repository without one there, such as a monorepo package, it creates one with that line). `remove` leaves the file
and that line alone. Declining, running without a terminal and without `--yes`, and `--dry-run` send nothing and
create nothing. Running `init` again reuses the token (no new project); on a setup made without one it never creates
a project as a side effect: pass `--token`, or sign in and run `connect`. Signed in
(`npx @genclass/runtime@beta login`), `init` first asks whether the new app goes into your GenClass account instead
of getting a private link ([DASHBOARD.md](DASHBOARD.md)).

```bash
npx @genclass/runtime@beta init --token gc_...   # use a token you already have (genclass.dev is not contacted)
npx @genclass/runtime@beta init --no-token       # no token; genclass.dev is not contacted
```

`--no-telemetry` implies `--no-token` (a dashboard only gets data while telemetry is on). If genclass.dev cannot be
reached, `init` says so, sets GenClass up without a token, and points you to
[genclass.dev/start](https://genclass.dev/start); run `init --token gc_...` later. `--dry-run` sends nothing and
installs nothing.

## How do I install it by hand?

**One import** (any bundler; the package is ESM only, there is no `require` build), first in your entry file, so it
is installed before your framework and stores created at import time see the runtime (automatic state discovery is
on):

```ts
import "@genclass/runtime/auto";          // observe (the default)
import "@genclass/runtime/auto/guard";    // or guard
import "@genclass/runtime/auto/heal";     // or heal (experimental)
import "@genclass/runtime/auto/observe";  // observe, explicitly

import rt from "@genclass/runtime/auto";  // the same, and the runtime it started
```

Next.js 15.3 or later: put it in `instrumentation-client.ts`; on earlier versions `init` imports it from a
`"use client"` component rendered in the root layout (App Router) or from `pages/_app` (Pages Router). Optional page
configuration, read once:
`<meta name="genclass" content="mode=guard, devtools=local">` inside `<head>` or
`window.GENCLASS_CONFIG = { mode: "guard", devtools: true }` (any `InitOptions`; since `0.3.0` also `token=gc_...` /
`token: "gc_..."`; every key: [below](#which-attributes-does-the-script-tag-take)), set before the import runs.
During SSR or in Node, `/auto` installs nothing and returns an inert runtime.

**One script tag** (no build step), first in `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.0" data-mode="observe" data-devtools="local"></script>
```

It exposes `window.GenClass` (since `0.3.0` also `window.GenClass.protect`), discovers the app's state like the
import does, and loads the model worker, ONNX Runtime Web and the overlay on demand from the same version on the CDN.
Its `data-*` attributes configure it ([every attribute](#which-attributes-does-the-script-tag-take)). Keep the
version pinned in production; the plain-HTML path of `init` writes a pinned jsDelivr URL with SRI.

**`GenClass.init()`**, the explicit setup:

```bash
npm install @genclass/runtime@beta
```

```ts
// first thing in your entry file
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init(); // observe; GenClass.init({ mode: "guard" }) to let it act
```

`GenClass.init()` does not discover state on its own: register stores
([State it can protect](../../packages/runtime/README.md#state-it-can-protect)), or import
`@genclass/runtime/discover` first and pass `autoState: true`.

The unscoped `genclass-runtime` alias is deprecated; use `@genclass/runtime`.

## Which attributes does the script tag take?

The script tag reads these `data-*` attributes; `<meta name="genclass" content="key=value, ...">` in `<head>` takes
the same keys (with `/auto` too). Later sources win: the meta tag, then the script tag, then
`window.GENCLASS_CONFIG`, then options passed to a manual `GenClass.init()`; the URL switch (`?genclass=...`) and
`localStorage.genclass` still beat all of them. Unknown keys and values are ignored.

| attribute | meta key | what it sets |
|---|---|---|
| `data-mode` | `mode` | `observe` (the default), `guard` or `heal` |
| `data-devtools` | `devtools` | the overlay: bare or `true` always, `local` only on local hosts (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.local`, `*.test`, `file:`), `off`, or a corner (`bottom-right`, `bottom-left`, `top-right`, `top-left`) |
| `data-telemetry="off"` | `telemetry=off` | no anonymous diagnostics (an opt-out only: on is the default) |
| `data-token` | `token` | the app's dashboard token, `gc_...` (`0.3.0`) |
| `data-scope` | `scope` | `app` (the default) or `functions` (`0.3.0`) |
| `data-sink` | `sink` | sinks by name: `console-json`, `console-json:noevidence`, `webhook:<url>`; commas between names on the tag, `+` in the meta tag ([SINKS.md](SINKS.md), `0.3.0`) |
| `data-detect` | `detect` | `likely` or `possible` (`0.3.0`) |
| `data-autostate="off"` | `autostate=off` | no automatic state discovery (an opt-out only) |
| `data-visual` | `visual` | measured visual checks: `on`, `off`, `local`, or `fix` (on, with runtime fixes in guard or heal mode) (`0.3.0`) |
| `data-analytics` | `analytics` | interaction analytics `on` (off by default; they need telemetry and the app's token; `0.3.0-beta.1`) |
| `data-model` | `model` | a self-hosted model directory URL, or `off` for no model |
| `data-ort` | `ort` | the directory of ONNX Runtime Web's wasm files |
| `data-device` | `device` | `auto`, `webgpu` or `wasm` |
| `data-preload` | `preload` | when the model downloads: `eager`, `idle` or `lazy` |
| `data-worker="off"` | `worker=off` | run the model on the main thread instead of a Web Worker |
| `data-report` | `report` | `console` or `silent` |
| `data-debug` | `debug` | console logging of every decision |
| `data-triage` | `triage` | `salient` (the default) or `always` |
| `data-manual` | none | expose `window.GenClass` without starting it; call `GenClass.init(options)` yourself (the page configuration still applies) |
| `data-base` | none | the URL of this package's `dist/` directory, when you self-host the script file |

A meta tag only takes same-origin URLs for `model`, `ort` and a `webhook:` sink, and only inside `<head>`; put a
cross-origin URL in the script tag's attributes or `window.GENCLASS_CONFIG` instead. The source of this list is
[`src/cdn/config.ts`](../../packages/runtime/src/cdn/config.ts).

## ESM only, and Jest

The package ships ES modules (no `require`). Jest users need a `transformIgnorePatterns` entry that lets
`@genclass/runtime` be transformed, for example `["/node_modules/(?!@genclass/runtime)"]`.

## Which projects was `init` tested on?

Tested end to end on fresh projects from each framework's own generator (a locally packed pre-release build whose
version string was `0.1.0-alpha.0`, 2026-10-08; the published `0.1.0-alpha.0` has no `init`; model files served
locally; not re-run since): Vite 8 (React with npm and pnpm, Vue, Svelte), Next.js 16.4 (App and Pages Router, plus
the paths for Next < 15.3), Create React App 5, SvelteKit, Astro, Nuxt 4.6, React Router 8 (framework mode), Angular
20 and plain HTML. In all 15 projects:

- the app built and ran in Chromium after `init` (production build where the project has one);
- the model loaded in a worker and a warm load had no console errors; the overlay appeared only in development
  (plain HTML: wherever `data-devtools="local"` sees a local host, so also in its production run on `127.0.0.1`; the
  dev server of the Pages Router `--strategy pages` variant was not run);
- `remove` left every file byte-identical to the scaffold (node_modules, lockfiles and build output excluded).

Remix, Solid, Preact and Next.js before 15.3 are detected but were not scaffolded with their own generators. Those
scaffold runs predate the `init` / `remove` changes since (`--mode`, formatter handling, server and library
detection, app tokens), which are covered by unit tests only. The compatibility matrix below adds the one line by
hand, so it is end-to-end evidence for the runtime, not for `init`. Details:
[test/install/RESULTS.md](../../packages/runtime/test/install/RESULTS.md).

The [compatibility matrix](../../compat/RESULTS.md) runs the one line in React + Vite, Next.js 16, Vue + Pinia,
SvelteKit 3, Angular 22, Solid and plain HTML, with 15 data layers (TanStack Query, SWR, Redux Toolkit, Zustand,
Apollo, WebSocket and EventSource among them), in every mode, and checks that GenClass never makes those apps worse
(runtime commit `d04eff3`, the 0.1.0-beta.4 code plus the "Model ready" log fix; the matrix has not run 0.2.0's
other changes or anything since; 2026-10-10). Starter templates are in [templates/](../../templates).

**React Router dev server.** On the very first dev start after `init`, Vite discovers the new imports late,
re-optimizes and reloads the page, logging a few "Outdated Optimize Dep" errors once. Later loads are clean.
