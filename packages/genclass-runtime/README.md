# genclass-runtime (deprecated)

`genclass-runtime` is the deprecated, unscoped short name for the command line of
[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime). Use `@genclass/runtime` instead: this package
is no longer published (the release workflow publishes only `@genclass/runtime`), and its newest version on npm
installs an unsupported runtime.

GenClass Runtime (`@genclass/runtime`) is an open-source (Apache-2.0) browser library that reports race conditions
in web apps while they happen: stale responses that land over newer data, duplicate requests such as double
submits, inconsistent state and failure storms. A small model runs on the user's device, in a Web Worker on WebGPU
or WASM, and each report comes with its evidence. By default it only reports (`observe`): since `0.2.0` it never
holds, delays or changes a request, a response or a state write. The opt-in `guard` mode can prevent a few of these
failures, and `heal` is experimental.

## What should I run instead?

```bash
npx @genclass/runtime@beta init                  # the newest line: 0.3.0-beta.4 on 2026-10-27
npx @genclass/runtime@beta init --token gc_...   # use a token you already have (no call to genclass.dev)
npx @genclass/runtime@beta init --no-token       # no token, no call to genclass.dev
```

`@beta` is the newest line of `@genclass/runtime` (`0.3.0-beta.4` on 2026-10-27); the stable line, `0.2.2` (npm's
`latest`, `npx @genclass/runtime init`), is the exception. npm's `genclass-runtime` is still at `0.1.0-beta.3`, so
`npx genclass-runtime init` runs that old CLI unless the project already has `@genclass/runtime` installed (see
below).

`init` finds your framework, shows you the diff first, then installs `@genclass/runtime` and adds one line to your
entry file. From `0.3.0`, once you approve the diff, it also creates your app's token and private dashboard link at
genclass.dev (sending your `package.json` name), writes the token into what it adds and saves the link in
`.genclass.local` (keep that link private: anyone with it sees your app's dashboard, and it is the only way to open
it). `--token gc_...` uses a token you already have and `--no-token` skips the token; neither contacts genclass.dev,
though the package manager still installs from its registry. Docs:
[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime).

## What does this package install?

The newest published version, `genclass-runtime@0.1.0-beta.3`, depends on `@genclass/runtime@0.1.0-beta.3`, which is
no longer supported ([SECURITY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/SECURITY.md)). With its
defaults that version sends anonymous diagnostics from local hosts too, and they include the redacted situation text
the model read. Its `observe` mode can also delay a `fetch` whose `Request` or `Blob` body GenClass reads to identify
it, by a few microtasks to 100 ms (fixed in `0.2.0`).

The command name itself is not going away: `@genclass/runtime` installs a command called `genclass-runtime`, so in a
project that has `@genclass/runtime` installed, `npx genclass-runtime ...` runs that installed version. Outside such
a project, `npx genclass-runtime` downloads this deprecated package.

## Privacy

`@genclass/runtime` sends **anonymous diagnostics by default** on public hosts: GenClass's decisions and counts, no
text from your page unless the app opts in, to the GenClass maintainers to improve the model; with an app token the
same diagnostics also feed your app's private dashboard. They are off on `localhost` and other local hosts from
`0.2.2`; earlier versions (`0.1.0-beta.3` to `0.2.1`) send from them too, and `0.1.0-beta.3` to `0.2.0` include the
redacted situation text by default. Opt out with `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry`,
`localStorage.setItem("genclass.telemetry", "off")` or `init --no-telemetry` (which also skips the token); browsers
sending Global Privacy Control are never collected. Details:
[TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).

<!-- Maintainers: npmjs.com shows the README and package.json fields of the published version. On 2026-10-27 npm has
genclass-runtime 0.1.0-beta.3 (latest, published 2026-10-09) with its older README and description ("Short alias for
the @genclass/runtime CLI ...") and no deprecation flag; release.yml packs and publishes only packages/runtime
(@genclass/runtime, 0.3.0-beta.4 on main), so this README and the description here do not reach npm. The notice
reaches npm users only through
`npm deprecate genclass-runtime "Deprecated: use @genclass/runtime (npx @genclass/runtime@beta init)"`, which
npmjs.com shows and npm prints when it installs the package; that is the owner's call. genclass-runtime@0.3.0-beta.1,
the version in package.json here (depending on @genclass/runtime 0.3.0-beta.1), was never published. -->
