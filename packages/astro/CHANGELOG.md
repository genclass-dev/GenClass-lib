# Changelog

## 0.1.0 (unreleased)

- First version: an Astro integration that installs
  [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) the recommended way, in the browser only.
  In `astro:config:setup` it injects, as a `page` script on every page, the runtime's own zero-code entry
  (`@genclass/runtime/auto`, or `/auto/guard` for `mode: "guard"`); `token` and `telemetry` are written to
  `window.GENCLASS_CONFIG` by a virtual module imported before the runtime. The devtools overlay loads under
  `astro dev` only (`devtools: "dev"`, the default), also in builds with `"always"`, never with `"never"`. Nothing runs
  on the server. `astro` (4 or later; tested with 7.4) and `@genclass/runtime` (0.2.0 or later; `token` needs 0.3.0)
  are peer dependencies. Keywords `astro-integration` and `withastro` for the integrations library and `astro add`.
- The runtime modules the script imports are added to Vite's `optimizeDeps.include`: the injected script is a virtual
  module Vite's dependency scan does not see, and without this `astro dev` discovered them on the first page request
  and re-optimized with a reload (a "504 Outdated Optimize Dep" console error on a cold start).
