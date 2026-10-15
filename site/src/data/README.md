# site/src/data

Data files that `site/build.py` renders into genclass.dev. Pages never hard-code a measured number that lives here.

## visual.json: the visual-bug feature

`visual.json` holds the numbers for the visual-bug section on the homepage (`site/src/partials/visual.html`) and
for `/visual` (`site/src/pages/visual.html`). `site/visual.py` reads it.

The file has four blocks of numbers, each with its own switch, so the feature can go live on the measured checks
alone while the learned model is still being evaluated:

| block | switch | what the pages show when it is on |
|---|---|---|
| `checks` | top-level `status: "live"` | homepage: four numbers under the scan box (kinds, planted faults found, false reports on unmodified pages, public-site findings confirmed real). /visual: key lines and Tables 1 to 4 (recall per kind, findings on unmodified pages, public sites per run, cost) |
| `model` | `model.status: "live"` (needs `status: "live"`) | homepage: one line on the model. /visual: Tables 5 and 6 (recall per family, precision on pages with no injected faults, size and cost) |
| `crawl` | `crawl.status: "live"` (needs `status: "live"`) | homepage: Fig. 2, measured signals on crawled pages, AI-built against regular sites, labelled as upper bounds |
| `vision` | `vision.status: "live"` (needs `status: "live"`) | GenClass Vision, the page check's screenshot model (beta, not scored). Homepage: one line under the proof line. /visual: the `#vision` section (ranking against Clef and OpenAI, behind the measured rules, size and speed, why it is a beta), a sentence in step 02, and llms.txt. Every number comes from `vision/results/vision-v2/RESULTS.md` (source `vision`, pinned to a commit) and Clef's size from Cloudflare's model card (source `clef`). The build checks the fields and that `kept_real <= kept <= flags` |

- While `status` is `"draft"`, the build shows no numbers at all: the homepage shows the headline, the status rows
  (when the model's results are due, whether the checks are in the runtime, the model's stage) and the drawn bug
  examples, and `/visual` shows the catalog content and says that the model has no published numbers yet. The build
  prints the fields that are still missing.
- A block switched on with any of its fields missing stops the build and lists them. So does any value of the wrong
  type, a number that does not agree with its parts (recall that is not found / planted, rows that do not add up to
  the total, a per-load rate that is not findings / loads, confirmed + check errors + unconfirmed that is not the
  findings), a duplicate kind or family id, model recall that falls as the false-report rate rises, a share with
  float noise (`0.30000000000000004`), and a `ready_by` that has already passed while the model is still draft.
- While the model is draft, every page says it is still being trained and evaluated (`model.stage: "training"`) or
  planned, that it has no published numbers, and that none of the numbers shown come from it.
- `visual.sample.json` has the same shape with made-up numbers and every block on. The build ignores it. To preview
  the live layout, build with `VISUAL_DATA=site/src/data/visual.sample.json`; every figure and table is then stamped
  "Sample data, not measured", and the whole site is written to `site/.preview/` (gitignored), never to
  `site/public/`. Never copy numbers out of the sample.

### How to fill it

Write only numbers that come from a results file you can link, and say where each came from. Fractions are 0 to 1
(`0.42` renders as 42%, `0.425` as 42.5%: the precision you write is the precision shown). Counts are integers.
Text fields are short phrases in the site's voice: plain, no em dashes, no hype words, no exclamation marks.

| field | what | shown as |
|---|---|---|
| `status` | `"draft"` or `"live"` (`"sample"` only in the sample file); `"live"` shows the checks block | |
| `updated` | ISO date the file's numbers were last changed | the model's "numbers as of" |
| `ready_by` | when the model's results are due, set by the owner: an ISO date (`"2026-10-14"`) or a date-time with a zone (`"2026-10-14T22:00:00Z"`), or null. Shown while the model is draft, in UTC. A date that has passed stops the build: publish the model's numbers, move the date and say why, or set it to null | homepage status rows, the /visual notice |
| `scan_live` | `true` once the page check's routes (`genclass.dev/scan*` and `genclass.dev/api/scan*` on the scan worker, branch `wave2/scan-launch`) answer on genclass.dev. Deploy the scan worker and add its routes first, check that `/scan` and `/api/scan/health` answer on genclass.dev, then deploy the site with `true`: before the routes exist, the scan box's `/scan` is the site's 404 and the scanner's `POST /api/scan` reaches the telemetry worker. The same deploy sets the page check's line in `billing/plans.json` to available. While `false` there is no scan box anywhere and the pages say the page check is not open yet | the scan box on the homepage and /visual |
| `scan_runs` | What the page check runs. `"chunk"`: the runtime's visual chunk, every kind except `click-blocked`, which needs a visitor's clicks (branch `wave2/scan-launch`, `scan-worker/README.md`). `"all"`: every kind, only once the scanner runs `click-blocked` too. `"subset"`: the old built-in checks of branch `wave2/scan` (`scan-worker/src/checks.ts`, deleted on `wave2/scan-launch`; the list is `SCAN_SUBSET` in `site/visual.py`) | "The page check runs the same checks on one public page, except `click-blocked` ...", the homepage status row, /visual, /docs, llms.txt |
| `checks_in_runtime` | the `@genclass/runtime` version that ships the visual checks, or null. While null every page says the checks are not in the pinned runtime yet | "The visual checks ship in runtime {version}" |
| `checks.name`, `.version`, `.branch`, `.measured_on`, `.date`, `.kinds` | what was measured, where and when; `kinds` must equal the rows of `checks.recall.rows` | every caption |
| `checks.fixtures` | `planted`, `found`, `kinds`, `tests_passed`, `on` (what the fixture pages are) | "35 of 35 planted faults found" |
| `checks.recall` | `run`, `on`, `misses` (why the misses happen), `rows[]`: `kind`, `planted` (faults that took), `found`, `recall` as written in the results (2 decimals, must be found / planted) | Table 1 |
| `checks.clean` | `runs`, `loads`, `page_views`, `false_reports`, `fixes_applied` (totals of the rows), `real` (what the real findings were), `rows[]`: `pages`, `page_views`, `findings`, `confirmed_real`, `false_reports`, `fixes_applied`; an unlabelled finding counts as false | the homepage's "0 false reports", Table 2 |
| `checks.public` | `sites` (in the list), `run` (the headline run; its findings must have been looked at), `on`, `real`, `runs[]`: `run`, `sites` (measured), `loads`, `findings`, `per_load` (as written), `confirmed_real`, `check_errors`, `unconfirmed`; `looked_at: false` when nobody looked, and then the first two stay null | the homepage's "5 of 8", Table 3 |
| `checks.cost` | `run`, `chunk_kb_gzip`, `chunk_kb_min`, `first_load_bytes`, `first_load_entry`, `slice_budget_ms`, `pass_budget_ms`, `note` (the gates not met), `passes[]`: `on`, `loads`, `p50_ms`, `p95_ms`, `max_ms`, `within_budget` (a share), `slice_p50_ms`, `slice_p95_ms`, `slice_max_ms` | Table 4 |
| `model.status` | `"draft"` or `"live"`; the fields below are needed only once it is `"live"` | |
| `model.stage` | while draft: `"planned"` (no model trained yet) or `"training"` (being trained and evaluated). The pages say only what the stage supports | "A learned model is still being trained and evaluated ..." |
| `model.name`, `model.version` | as published, e.g. a package name and version | every caption |
| `model.input` | what the model reads, as a phrase. Without it the pages say nothing about what the model reads | "It reads {input}." |
| `model.trained_on.sites_ai` | AI-built sites in the training crawl | |
| `model.trained_on.sites_control` | regular (not AI-built) sites in the training crawl | |
| `model.trained_on.injected_faults` | faults injected from outside the page for training | |
| `model.trained_on.elements` | labelled elements the model trained on | |
| `model.eval.data` | the data the numbers were measured on | table captions |
| `model.eval.split` | how that data was kept apart from training, e.g. "sites held out from training" | table captions |
| `model.eval.false_reports_per` | the unit of the false-report rate, e.g. "clean element" or "clean page" | "at 0.1% false reports per clean element" |
| `model.families[]` | one entry per bug family the model reports: `id` (the family ids below), `name`, `recall_at_fp_0_1` (recall when 0.1% of clean units are falsely reported), `recall_at_fp_1` (the same at 1%), `examples` (injected faults of that family in the test data) | Table 5 |
| `model.natural_precision` | share of reports that are real bugs on pages with no injected faults | Table 6 |
| `model.natural_pages` | how many such pages that precision was measured on | Table 6 |
| `model.size_kb` | download size of the model in KB | Table 6 |
| `model.ms_per_element` | inference time per element in ms | Table 6 |
| `model.cost_measured_on` | where size and time were measured, e.g. "one WASM thread on a 2020 laptop" | Table 6 |
| `crawl.status` | `"draft"` or `"live"`; Fig. 2 shows only once it is `"live"` | |
| `crawl.date`, `crawl.sites_ai`, `crawl.sites_control` | the crawl behind the signals | Fig. 2 subtitle |
| `crawl.basis` | what each share counts, e.g. "Share of clean page views with at least one element showing the signal" | Fig. 2 subtitle |
| `crawl.signals[]` | at least three: `name`, `view` (e.g. "desktop" or "phone"), `share_ai`, `share_control`. These are measured signals, not verified bugs: the figure says so and calls each share an upper bound, in the file's order. Needs a `sources` entry `"crawl"` with a link | Fig. 2 |
| `sources[]` | `id`, `title`, and `url` or `path` (a file in this repo, linked to GitHub only once it is committed on `origin/main`; until then the entry is left out), `used_for`. Live needs one entry with `"id": "results"` that links the results the numbers came from | "Sources" on /visual |

Family ids follow `research/visual/injectors.json`: `text`, `media`, `styles`, `overflow`, `occlusion`, `controls`,
`leaks`, `blank`, `motion`, `dark`, `responsive`, `design`, `other`.

Check after editing: `site/build.py` prints `visual: checks live, model training (no numbers), crawl figure off, scan box
on` or `visual: draft, model planned, results due ..., scan box off; no numbers shown (missing: ...)`.
