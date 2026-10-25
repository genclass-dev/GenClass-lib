# @genclass/sv

A community add-on for the [Svelte CLI](https://svelte.dev/docs/cli/sv-add) that sets up
[GenClass](https://github.com/genclass-dev/GenClass-lib) in a SvelteKit app. GenClass is a browser library that
reports race conditions while your app runs: a stale response landing over newer data, duplicate submits, failure
storms, retries and stalls.

> [!IMPORTANT]
> Svelte maintainers have not reviewed community add-ons for malicious code. This one is open source:
> [packages/sv](https://github.com/genclass-dev/GenClass-lib/tree/main/packages/sv). Read it before you run it.

## Install

```sh
npx sv add @genclass
```

Or when you create the app:

```sh
npx sv create --add @genclass
```

On Windows PowerShell, quote it: `npx sv add '@genclass'`. The add-on only works in SvelteKit projects; in a plain
Svelte + Vite project it stops with "Requires SvelteKit".

## What it changes

| file | change |
|---|---|
| `package.json` | adds `@genclass/runtime` `^0.3.0-beta.1` to `dependencies` (the release the GenClass README documents; the range takes later 0.3.0 betas and 0.3.x) |
| `src/hooks.client.ts` (or `.js`) | `import genclass from "@genclass/runtime/auto";` as the first line, and at the end `if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));`. Creates the file if the app has none; an existing file keeps all its code |
| `src/app.html` | with telemetry off (the default): `<meta name="genclass" content="telemetry=off" />` in `<head>` |

SvelteKit runs `src/hooks.client` in the browser before the app starts, so GenClass is installed before your
components and stores. Server rendering, hydration and your server code are not touched. The overlay import sits
behind `import.meta.env.DEV`, so it is never in a production build.

Every line it adds carries the `genclass:init` marker that `npx @genclass/runtime@beta init` writes, so GenClass's own
CLI recognises the setup and can take it out again. Running the add-on twice adds nothing twice; running it again
with other answers switches the mode or the telemetry line in place.

## Options

| option | values | default |
|---|---|---|
| `mode` | `observe`: reports what it finds and never holds, drops or changes a request. `guard`: also prevents some failures with small, reversible actions (reuse a duplicate's result, back off) when its model is confident; every action is logged with its evidence | `observe` |
| `telemetry` | `yes`: GenClass's default, anonymous diagnostics from your deployed site. `no`: writes the opt-out | `no` |

```sh
npx sv add @genclass="mode:guard+telemetry:no"
```

Start in observe, watch the console and the overlay on real traffic, then switch to guard. The runtime also has an
experimental `heal` mode, which this add-on does not offer: change the import to `@genclass/runtime/auto/heal`
yourself.

## What happens in the browser

- **The model download.** On a browser's first visit, GenClass downloads its model from jsDelivr: about 13 MB on
  WASM (the model plus ONNX Runtime's wasm) or 18 MB on WebGPU, cached afterwards, and run in a Web Worker
  (190 to 280 MB of memory while loaded). Devices that report 2 GB of memory or less and Save-Data connections do
  not load it and observe without it. For a strict Content-Security-Policy or to serve the model yourself, see
  [self-hosting](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#content-security-policy-and-self-hosting).
- **The console.** One line when the model is ready (`[GenClass] Model ready (...). Mode: observe.`), then one
  plain-English line per finding. The overlay (development only) sits bottom right; `Alt+Shift+G` toggles it.
- **What it sees in Svelte.** Automatic state discovery covers React, Redux and Zustand, not Svelte runes or stores
  yet, so in SvelteKit GenClass works from the network and user input. To compare a late response with newer data in
  your state, register that state (`genclass.atom(...)`, see
  [State it can protect](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#state-it-can-protect)).

## What GenClass sends, and why this add-on turns it off

With telemetry on, GenClass sends anonymous diagnostics about its own decisions to the GenClass maintainers: the
trigger, the diagnosis and its confidence, the chosen action, latency and counts, plus your site's hostname and the
route with ids replaced by `:id`. No text from the page unless the app opts in. It never sends from `localhost`,
private networks or `*.local` / `*.test` hosts, browsers with Global Privacy Control are never collected, and it
never feeds a decision. The full list is in
[TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).

GenClass itself sends by default. This add-on writes the opt-out unless you answer yes, because `npx sv create --add`
often installs several add-ons in one go, and a site deployed from that scaffold would then send diagnostics from
your visitors' browsers without anyone having decided to. If you want to help improve the model, answer yes, or
delete the meta line later.

Other ways to turn it off: `?genclass=no-telemetry` in the URL (one page load),
`localStorage.setItem("genclass.telemetry", "off")` (one browser), or `GenClass.init({ telemetry: false })`.
To turn GenClass off for a page load: `?genclass=off`.

## Remove it

```sh
npx @genclass/runtime@beta remove
```

It deletes the marked lines and the hooks file if the add-on created it, gives `src/app.html` back as it was, and
uninstalls `@genclass/runtime` if nothing else imports it. It changes nothing if you edited a marked line, and says
where. By hand: delete the two marked lines in `src/hooks.client.ts` (or the file), the marked meta line in
`src/app.html`, and run `npm uninstall @genclass/runtime`.

## Development

From the GenClass repository root (Node 20 or later; the end-to-end test also needs pnpm and Chromium):

```sh
npm ci
npm run build -w @genclass/runtime              # the end-to-end test installs this build
npm run build -w @genclass/sv
cd packages/sv
npx vitest run --project unit                   # the edits, no network
npx vitest run --project e2e                    # sv's add-on harness: scaffold, apply, build, Chromium
npx sv add file:../path/to/GenClass-lib/packages/sv   # try it in an app of your own
```

The end-to-end test scaffolds SvelteKit apps in TypeScript and JavaScript with `sv/testing`, applies the add-on,
applies it again (nothing may change), runs `svelte-check`, builds the app, loads the production build in Chromium
(the runtime must be installed, its model must load, and the console must show no errors), then runs
`genclass-runtime remove` and checks that the files are back. `GENCLASS_SV_RUNTIME=registry` installs the runtime
from npm instead of this repository's build.

Apache-2.0.
