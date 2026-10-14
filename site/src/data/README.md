# site/src/data

Data files that `site/build.py` renders into genclass.dev. Pages never hard-code a measured number that lives here.

## visual.json: the visual-bug feature

`visual.json` holds the numbers for the visual-bug section on the homepage (`site/src/partials/visual.html`) and
for `/visual` (`site/src/pages/visual.html`). `site/visual.py` reads it.

- While `status` is `"draft"`, the build shows no numbers at all: the homepage shows the headline, the status rows
  (when the model's results are due, whether the checks are in the runtime, the model's stage) and the drawn bug
  examples, and `/visual` shows the catalog content and says that the model has no published numbers yet. The build
  prints the fields that are still missing.
- `status: "live"` with any of those fields missing stops the build and lists them. So does any value of the wrong
  type, a duplicate family id, recall that falls as the false-report rate rises, a share with float noise
  (`0.30000000000000004`), and a `ready_by` that has already passed while the status is still `"draft"`.
- With `status: "live"` and every field below filled, the homepage adds Fig. 2 (share of AI-built and regular sites
  with each of the five most common bug families, with a table view) and one line on the model, and `/visual` adds
  Table 1 (recall per family) and Table 2 (precision on pages with no injected faults, size and cost).
- `visual.sample.json` has the same shape with made-up numbers. The build ignores it. To preview the live layout,
  build with `VISUAL_DATA=site/src/data/visual.sample.json`; every figure and table is then stamped
  "Sample data, not measured", and the whole site is written to `site/.preview/` (gitignored), never to
  `site/public/`. Never copy numbers out of the sample.

### How to fill it

Write only numbers that come from a results file you can link, and say where each came from. Fractions are 0 to 1
(`0.42` renders as 42%, `0.425` as 42.5%: the precision you write is the precision shown). Counts are integers.
Text fields are short phrases in the site's voice: plain, no em dashes, no hype words, no exclamation marks.

| field | what | shown as |
|---|---|---|
| `status` | `"draft"` or `"live"` (`"sample"` only in the sample file) | |
| `updated` | ISO date the numbers were last changed | "Numbers as of October 14, 2026" |
| `ready_by` | when the model's results are due, set by the owner: an ISO date (`"2026-10-14"`) or a date-time with a zone (`"2026-10-14T22:00:00Z"`), or null. Shown while draft, in UTC. A date that has passed stops a draft build: publish the numbers, move the date and say why, or set it to null | homepage status rows ("Model results due"), the /visual notice and the Results heading ("Results due by October 14, 2026, 22:00 UTC.") |
| `scan_live` | `true` once the page check's routes (`/scan`, `/scan/about`, `genclass.dev/<address>`, branch `wave2/scan`) answer on genclass.dev. While `false` there is no scan box anywhere and the pages say the page check is not open yet | the scan box on the homepage and /visual |
| `checks_in_runtime` | the `@genclass/runtime` version that ships the visual checks, or null. While null every page says the checks are in testing and not in the pinned runtime, and describes their behaviour as in testing | "The visual checks ship in runtime {version}" |
| `model.stage` | while draft: `"planned"` (no model trained yet) or `"training"` (a training run is going). The pages say only what the stage supports | "A model is planned, to be trained on ..." / "A model is being trained on ..." |
| `model.name`, `model.version` | as published, e.g. a package name and version | every caption |
| `model.input` | what the model reads, as a phrase. Without it the pages say nothing about what the model reads | "It reads {input}." |
| `model.trained_on.sites_ai` | AI-built sites in the training crawl | |
| `model.trained_on.sites_control` | regular (not AI-built) sites in the training crawl | |
| `model.trained_on.injected_faults` | faults injected from outside the page for training | |
| `model.trained_on.elements` | labelled elements the model trained on | |
| `model.eval.data` | the data the numbers were measured on | table captions |
| `model.eval.split` | how that data was kept apart from training, e.g. "sites held out from training" | table captions |
| `model.eval.false_reports_per` | the unit of the false-report rate, e.g. "clean element" or "clean page" | "at 0.1% false reports per clean element" |
| `model.families[]` | one entry per bug family the model reports: `id` (the family ids below), `name`, `recall_at_fp_0_1` (recall when 0.1% of clean units are falsely reported), `recall_at_fp_1` (the same at 1%), `examples` (injected faults of that family in the test data) | Table 1 |
| `model.natural_precision` | share of reports that are real bugs on pages with no injected faults | Table 2 |
| `model.natural_pages` | how many such pages that precision was measured on | Table 2 |
| `model.size_kb` | download size of the model in KB | Table 2 |
| `model.ms_per_element` | inference time per element in ms | Table 2 |
| `model.cost_measured_on` | where size and time were measured, e.g. "one WASM thread on a 2020 laptop" | Table 2 |
| `crawl.date` | the date of the crawl the prevalence numbers come from | Fig. 2 subtitle |
| `crawl.sites_ai`, `crawl.sites_control` | sites behind the prevalence numbers | Fig. 2 subtitle |
| `crawl.measured_by` | what decided a site had the bug, at a site-level setting, e.g. "the measured checks" or "the model at one site-level threshold". A per-element rate is not enough: a site has hundreds of elements in each of its four views (desktop and phone, light and dark), so even 0.1% false reports per clean element would count a large share of clean sites as having a bug | Fig. 2 subtitle |
| `crawl.false_site_share` | at that same setting, the share of sites verified clean (no bug found by hand review) that were flagged anyway | Fig. 2 subtitle: "At that setting, 1% of 300 sites verified clean were flagged as well." |
| `crawl.clean_sites` | how many verified-clean sites that share was measured on | Fig. 2 subtitle |
| `crawl.prevalence[]` | `id`, `name`, `share_of_ai_sites`, `share_of_control_sites`: the share of crawled sites with at least one bug of that family; at least five entries | Fig. 2 shows the five with the highest AI share |
| `sources[]` | `id`, `title`, and `url` or `path` (a file in this repo, linked to GitHub only once it is committed on `origin/main`; until then the entry is left out), `used_for`. Live needs one entry with `"id": "results"` that links the results the numbers came from | "Sources" on /visual |

Family ids follow `research/visual/injectors.json`: `text`, `media`, `styles`, `overflow`, `occlusion`, `controls`,
`leaks`, `blank`, `motion`, `dark`, `responsive`, `design`, `other`.

Check after editing: `site/build.py` prints `visual: live` or `visual: draft, model planned, results due ..., scan box
off; no numbers shown (missing: ...)`.
