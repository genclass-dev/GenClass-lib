# The Payload hunt's harness

The files that produced every number in [../payload.md](../payload.md). They drive a Payload app that is not in this
repository (section 2 of the report says how it was made: `create-payload-app` 3.92.0, blank template, SQLite, plus the
four collection configs in [collections/](collections/)).

| file | role |
|---|---|
| `hunt.mjs` | the harness: starts `@genclass/mcp`'s server in-process, injects the built runtime into the admin's documents through Playwright routes, logs in once, runs one scenario per page load, drives `genclass_explore`, `genclass_explain` and `genclass_replay` over JSON-RPC, and prints its own DOM and REST comparison next to the explore verdict. `node hunt.mjs probe`, `explore <scenario> <slow_ms> [runs]`, `replay <scenario> <finding>`, `explain x <finding>`, `once <scenario>` |
| `sweep.sh` | every scenario at 300, 600 and 900 ms |
| `dup-requests.spec.mjs` | the GenClass-free reproduction of the finding: delays `/api/categories` by 1.5 s, loads the posts list, exits 1 when an id is requested twice |
| `apply-to-bundle.mjs` | applies the fix to the file the admin really loads, `@payloadcms/ui`'s bundled, minified client entry (`dist/exports/client/index.js`) in the app's `node_modules` (and `--revert`), for the fixed-variant check; `dist/elements/**` is not what Next compiles |
| `seed.mjs`, `seed-pages.mjs` | the first user over `/api/users/first-register`, 20 categories, 300 posts, 3 pages, over REST |
| `collections/` | `Posts.ts`, `Categories.ts`, `Pages.ts` as added to the app's `payload.config.ts` |
| `out/` | the saved sessions: one JSON per explore session (every run's DOM snapshot, the report, status, findings, explain), the sweep logs, `explain-f6.txt` |

Paths: `GENCLASS_LIB` (default: this repository, four directories up), `PAYLOAD_URL` (default `http://localhost:3000`),
`PAYLOAD_APP` (the app directory, for `apply-to-bundle.mjs`). `@playwright/test` resolves from this repository's
`node_modules`; Chromium is launched with `--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers`
(report, section 9).
