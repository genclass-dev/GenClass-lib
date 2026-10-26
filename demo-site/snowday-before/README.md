# Snow Day Predictor, demo version

The Snow Day Predictor ([MeharPro/snowday-predictor](https://github.com/MeharPro/snowday-predictor), MIT, see LICENSE) as of
commit 5828d79, before GenClass was added, for the GenClass demo (`../DEMO-SCRIPT.md`). It deploys to the live Worker
behind snowday-predictor.ca (`wrangler.jsonc`: same name, compatibility date and `ASSETS` binding; `worker.js` adds the
three demo endpoints in `functions/api/`). Five bugs are planted on purpose: the board search race, the double
Subscribe, the white-on-white alert bar, the scroll lock the notice leaves, the click block "Load road conditions"
leaves. It goes live only for a recording; afterwards the site is rolled back to its own version (the script, act 8).
