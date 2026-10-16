# genclass-runtime

Short alias for the [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) CLI.

```bash
npx genclass-runtime init
```

It does the same as `npx @genclass/runtime init`: it finds your framework, installs `@genclass/runtime`, adds one
line to your entry file and shows you the diff first. From `0.3.0`, once you approve the diff, it
also creates your app's token and private dashboard link at genclass.dev (sending your `package.json` name), writes
the token into what it adds, and saves the link in `.genclass.local` (keep that link private; it is the only way to
open your dashboard).

```bash
npx genclass-runtime init --token gc_...   # use a token you already have (no network)
npx genclass-runtime init --no-token       # no token, no network
npx genclass-runtime stats                 # once this package depends on 0.3.0-beta.1: a free summary of what GenClass found on your deployed site
```

Docs: [@genclass/runtime](https://www.npmjs.com/package/@genclass/runtime) (one-line setup, function-specific
`protect()`, your dashboard).

Privacy: since `0.1.0-beta.3` the installed runtime sends anonymous diagnostics (GenClass's decisions and
counts; no page text unless you opt in) to the GenClass maintainers by default. With a token the same diagnostics also
feed `stats`, a free summary in your terminal, and your app's private dashboard (the dashboard needs Pro; get a
7-day free trial for analytics). Opt out with `GenClass.init({ telemetry: false })`
or `?genclass=no-telemetry` (`init --no-telemetry` also skips the token, so `stats` and the dashboard stay empty).
Details in [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).
