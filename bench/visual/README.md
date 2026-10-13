# bench/visual: how often the measured visual checks are wrong, and how often they miss

The bench for the measured visual checks (`packages/runtime/src/visual/`, design in
[docs/runtime/VISUAL.md](../../docs/runtime/VISUAL.md), section 15). It runs on GitHub runners only
(`.github/workflows/visual-measure.yml`); it starts Chromium, which never runs on the 8 GB development Mac.

It measures:

- **false reports on clean pages**: every finding on a page that is not broken is a candidate false report until a
  person looks at it. Clean pages are the six demos and their index (`demos/`, built and served the way
  `demos/README.md` says), the four starter templates (`templates/`, `npm install && npm run dev`) and the seven compat
  apps (`compat/`, their production builds through `compat/harness/front.mjs`, scenarios c, d and h), each at
  1280 x 800 and 390 x 844, light and dark, with scripted hover and keyboard focus and a pass at the top and at the
  end of the page;
- **a sanity rate on public sites**: about 40 public home pages (`sites.json`), one load per site and configuration
  (desktop and phone, light, and dark where the site has a dark design), no clicks, no forms, no crawling. Bot
  challenges and failed loads are "not measured", never clean;
- **recall on planted faults**: faults applied from the harness (`faults.ts`) to the demos, templates and compat apps,
  one group per load, with a check afterwards that each fault really took;
- **cost**: check time, longest slice and elements read for the first pass, at 1x and at 4x CPU throttling;
- **the real integration**: on the compat apps, `window.GENCLASS_CONFIG = { visual: true }` with no harness, for the
  stub's timing and the chunk's size.

## How it works

`page.ts` is bundled by `build.mjs` into one IIFE (`.out/page.js`) that the runner adds with `page.addInitScript`. It
runs the engine from `packages/runtime/src/visual/engine.ts` with a harness host instead of a runtime and keeps every
finding. Nothing is added to the demos, templates, compat apps or sites (AGENTS.md rule 4); their own GenClass runtime
is told to leave visual checks off (`?genclass-visual=off`), so the harness is the only checker on the page. Local
pages run in guard mode with fixes on, so a fix applied on a clean page is counted as a false fix; public sites run in
observe mode, report-only.

| file | what |
|---|---|
| `page.ts` | the page side: engine, harness host, request counting, dark-design detection, hover targets |
| `faults.ts` | planted faults (seeded), and the check that each one took |
| `corpus.mjs` | prepare and serve each group of pages |
| `run.mjs` | the runner: clean, cost, faults and integration loads; per-load JSON and element crops |
| `summarize.mjs` | counts per check kind for the repository; `detail.md` (every finding, with its crop) for a person |
| `sites.json` | the public sites |
| `labels.json` | verdicts (real or false) for findings on the local pages |
| `results/` | the committed summaries |

## Privacy of the public-site results

The per-load JSON, `detail.md` and the crops name public sites. They stay in the CI artifacts, kept 7 days. The
repository keeps counts per check kind and configuration only (`results/*.json`, docs/runtime/RESULTS.md section 9):
no site is named as having a bug. Verdicts on public-site findings are counted the same way.

## Run

```bash
gh workflow run visual-measure.yml --repo genclass-dev/GenClass-lib --ref <branch>   # once the workflow is on main
gh run list --repo genclass-dev/GenClass-lib --workflow visual-measure.yml --limit 1
gh run download <id> --repo genclass-dev/GenClass-lib --name visual-summary
```

On the visual branch, a push that changes `bench/visual/` starts it (`[smoke]` in the commit message: two pages per
group). Locally, only `summarize.mjs` runs: `node bench/visual/summarize.mjs <downloaded artifacts> --labels
bench/visual/labels.json`.
