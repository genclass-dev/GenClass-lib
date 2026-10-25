# Changelog

## 0.1.0 (unreleased)

- First version: a Nuxt module (`@nuxt/kit`, built with `@nuxt/module-builder`) that installs
  [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) the recommended way, in the browser only.
  From the `genclass` key of `nuxt.config` (`mode`, `token`, `telemetry`, `devtools`) it generates one client-only
  plugin that imports the runtime's own zero-code entry (`@genclass/runtime/auto`, or `/auto/guard` for
  `mode: "guard"`) first, before the app's own plugins; `token` and `telemetry` are written to
  `window.GENCLASS_CONFIG` by a module imported before the runtime. The devtools overlay loads in `nuxt dev` only
  (`devtools: "dev"`, the default), also in production with `"always"`, never with `"never"`. Nothing runs on the
  server. `@genclass/runtime` is a peer dependency (`>=0.3.0-beta.1`, the newest line: `npm install @genclass/runtime@beta`;
  npm's `latest`, 0.2.x, has no token, dashboard or analytics and does not satisfy it). Tested with Nuxt 4.6; the
  module declares `nuxt: ">=3.17.0"`.
