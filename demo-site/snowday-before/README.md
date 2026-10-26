# Snow Day Predictor, demo version

The Snow Day Predictor ([MeharPro/snowday-predictor](https://github.com/MeharPro/snowday-predictor), MIT, see LICENSE) as of
commit 5828d79, before GenClass was added, for the GenClass demo (`../DEMO-SCRIPT.md`). It deploys to the live Worker
behind snowday-predictor.ca (`wrangler.jsonc`: same name, compatibility date and `ASSETS` binding; `worker.js` adds the
two demo endpoints in `functions/api/`: the school board finder and the community poll). Five bugs are planted on
purpose: the board finder's race, the double vote in the poll, the white-on-white banner, the scroll lock the notice
leaves, the click block Predict leaves after a mistyped postal code. It goes live only for a recording; afterwards the site is rolled back to its own version (the script, act 8).
