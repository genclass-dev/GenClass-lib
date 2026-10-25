# The Payload hunt's harness

The files that produced every number in [../payload.md](../payload.md). They drive a Payload app that is not in this
repository (section 2 of the report says how it was made: `create-payload-app` 3.92.0, blank template, SQLite, plus the
three collection configs in [collections/](collections/)). The run used `create-payload-app@latest`, which resolved to
3.92.0; pin `@3.92.0` to repeat it.

| file | role |
|---|---|
| `hunt.mjs` | the harness: starts `@genclass/mcp`'s server in-process, injects the built runtime into the admin's documents through Playwright routes, logs in once, runs one scenario per page load, drives `genclass_explore`, `genclass_explain` and `genclass_replay` over JSON-RPC, and prints its own DOM and REST comparison next to the explore verdict. `node hunt.mjs probe`, `explore <scenario> <slow_ms> [runs]`, `replay <scenario> <finding>`, `explain x <finding>`, `once <scenario>` |
| `sweep.sh` | every scenario at 300, 600 and 900 ms |
| `dup-requests.spec.mjs` | the GenClass-free reproduction of the finding: delays `/api/categories` by 1.5 s, loads the posts list, exits 1 when an id is requested twice |
| `apply-to-bundle.mjs` | applies the fix to the file the admin really loads, `@payloadcms/ui`'s bundled, minified client entry (`dist/exports/client/index.js`) in the app's `node_modules` (and `--revert`), for the fixed-variant check; `dist/elements/**` is not what Next compiles |
| `react-compiler-check.cjs` | runs one file through `@payloadcms/ui`'s SWC and `babel-plugin-react-compiler` steps and prints the memo cache (`_c(n)`) or the bail-out (report, section 7); `PAYLOAD_DIR` is a Payload checkout |
| `autosave-variants.mjs` | the probe that found which part of the injection stopped the autosave (report, section 9) |
| `seed.mjs`, `seed-pages.mjs` | the first user over `/api/users/first-register`, 20 categories, 300 posts, 3 pages, over REST |
| `collections/` | `Posts.ts`, `Categories.ts`, `Pages.ts` as added to the app's `payload.config.ts` |
| `payload-suite/` | running the regression test in Payload's own e2e suite (`test/fields`, MongoDB): `run.sh` (install, `build:core`, a MongoDB replica set from `mongo-replset.mjs`, the dev server, the test on the unfixed and the fixed code), `playwright.local.config.ts` (Payload's config with this machine's Chromium and one worker) |
| `out/` | the saved sessions: one JSON per explore session (every run's DOM snapshot, the report, status, findings, explain), the sweep logs, `explain-f6.txt`; `*-fixed.json` and `verify-fix2.log` are the first version of the fix (search on a list sorted by views), `*-fixed2.json` and `verify-fix-final.log` the final fix on the same pages as the unfixed sessions (report, section 8); `out/payload-suite/` has every run in Payload's suite, numbered in the order run |

Paths: `GENCLASS_LIB` (default: this repository, four directories up), `HUNT_OUT` (where the harness keeps its login,
the bridge state and the session files; set it outside the repository), `PAYLOAD_URL` (default
`http://localhost:3000`), `PAYLOAD_APP` (the app directory, for `apply-to-bundle.mjs`; default the current directory),
`PAYLOAD_DIR` (a Payload checkout, for `payload-suite/` and `react-compiler-check.cjs`), `CHROMIUM_PATH` (a Chromium
for Payload's Playwright). `@playwright/test` resolves from this repository's `node_modules`; Chromium is launched
with `--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers` (report, section 9).
