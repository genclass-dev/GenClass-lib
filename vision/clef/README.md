# Clef as a judge of visibly broken elements

Does Cloudflare's open decision model Clef (`@cf/cloudflare/clef`, 27B, vision; released 2026-10-01, Apache 2.0) tell
a visibly broken page element from a fine one better than the GenClass measured-threshold rules and the v1
visual-bug model? If it does, the page check (`scan-worker`, on Cloudflare) can ask it about its candidate elements,
and it can label data for the small in-browser model. Numbers: [`../results/clef/RESULTS.md`](../results/clef/RESULTS.md).

| file | what |
|---|---|
| `worker/` | `genclass-clef-eval`, a private Worker with an `ai` binding: POST one crop and its facts, get Clef's answers |
| `eval.py` | builds the prompt from the measured facts, calls the worker, scores the answers against the person labels |
| `remote_fetch.py` | reads the labelled crops and their element facts on the crawl node, writing only to stdout |

## The worker

`https://genclass-clef-eval.mehar-144.workers.dev`, workers.dev only, no routes, observability off, no console calls.
Every request needs `x-eval-key` equal to the `EVAL_KEY` secret (a random 24-byte hex string generated with
`openssl rand -hex 24` and piped into `npx --yes wrangler@4 secret put EVAL_KEY`; it is not in git). Without it the
answer is a bare 404.

```
POST /   x-eval-key: <key>
{ "model": "clef" | "clef-flash", "state": "...", "questions": { ... }, "image_b64": "<base64>", "content_type": "image/jpeg" }
-> { "model", "answers": { <id>: { "type", "choice", "probabilities", "confidence" } }, "usage": { "input_tokens" }, "ms" }
```

It passes the Workers AI Clef input as documented (`schema-input.json`, read 2026-10-14): `model`, `state`,
`questions` (`noul` / `choice` / `score`) and `images: [{ content_type, base64 }]`. `ms` is the time `env.AI.run`
took inside the worker. Deploy from `worker/` with `npx --yes wrangler@4 deploy`.

## Data

The 2,200 crops labelled on the v2 contact sheets (`vision/results/v2/README.md`): 1,717 not, 139 real, 344 unclear.
Unclear is left out, so 1,856 crops. Each crop is a viewport screenshot cut around one element with a 24 px margin.
Its sidecar joins it to the element's row from `vision/src/extract.js` and to the view's page record. Nothing from the
crawl is in git. To fetch it again from the crawl node (read-only, nothing is written there):

```
ssh azureuser@"${IP}" 'nice -n 19 python3 - crops' < remote_fetch.py > fetch1.tar && tar -xf fetch1.tar -C DATA/raw
ssh azureuser@"${IP}" 'nice -n 19 python3 - facts' < remote_fetch.py > DATA/facts.jsonl
```

Split by site: a salted hash of the host puts 20% of sites in **dev** (412 crops, 25 real, 215 sites) and 80% in
**report** (1,444 crops, 114 real, 767 sites). Every prompt and scoring choice below was made on dev. The report
numbers were computed once, after those choices.

## The prompt

`state` is plain text in four parts. The second part only appears when an image is sent; without an image the
caution reads "Judge whether a visitor would see a problem" and ends "A fact alone is not proof that something is broken."

1. A caution (p3, the version that won on dev): *"Judge by what the screenshot shows a visitor. The measured facts
   below come from the browser and often flag harmless things: a transparent layer over a link, a contrast computed
   against a guessed background, content that scrolls inside a box by design, an element that continues below the
   fold. Treat them as hints that explain what you see, never as proof that something is broken."*
2. Where the element is in the image: *"The image is a screenshot of the area around the element, W x H px; the
   element's box is at x, y, w x h px inside it."*
3. The page: device and viewport, the colour-scheme preference it was rendered with, its declared `color-scheme` and
   whether it themes itself dark, how far it scrolls sideways, and failed CSS, image, font and script loads.
4. The element, from its row: tag, role, display, position, whether it is interactive or disabled, its box and how
   much of it is in the viewport, the visibility verdict, its own text length, lines and font, text colour, own and
   effective background (and whether that background is known), contrast against the ancestor background and
   against what is painted under the text centre, opacity, scroll size against client size with overflow modes,
   clipping ancestors, z-index, transforms and filters, the five-point hit test, image load state, natural size,
   alt length and distortion, leak-pattern matches, undefined CSS variables, and the parent's box and overflow.

The labellers' notes, the family guess and the ids of the rules that fired are never sent.

Two `choice` questions go in each call:

- `verdict`: *"Can a visitor see and use this element as intended?"* with options `fine`, `unreadable_text`,
  `hidden_control`, `broken_image`, `cut_off`, `overlap`, `leak` and `blank`. Each has a one-sentence description,
  the `p2` set in `eval.py`. The description of `fine` names deliberate design that is not a bug: muted styling,
  icons without text, intentional cropping, carousels, sticky headers, menus that scroll inside themselves, content
  below the fold.
- `family`: *"If something is wrong with this element, which kind of problem is it?"* with options `none`, `text`,
  `dark`, `overflow`, `responsive`, `occlusion`, `media`, `leaks`, `blank`, `controls` and `other` (the labelling
  families).

**Score.** The score is 1 − P(`family` = `none`), called `anyProblem`. On dev it ranked better than
1 − P(`verdict` = `fine`) (`notFine`) for every Clef variant. With eight verdict options the probability of `fine` is
spread thin, and the answers lean towards finding a fault. Both scores are reported.

What changed results on dev (AP on dev, `anyProblem`, 25 real):

| variant | what | dev AP |
|---|---|---:|
| `clef-text-p2` | facts, no image | 0.247 |
| `clef-img-p1` | facts + image, short criteria | 0.376 |
| `clef-img-p2` | facts + image, criteria that name deliberate design | 0.353 |
| `clef-box-p2` | as p2 with the element outlined in the image | 0.394 |
| `clef-imgonly-p2` | image + tag only, no facts | 0.413 |
| **`clef-img-p3`** | **p2 + the caution line** | **0.488** |
| `clef-box-p3` | p3 with the outline | 0.464 |

The facts without the caution made Clef repeat the measurement. For example, it called 91 of 387 fine dev elements a
`hidden_control` because the hit test found another element on top, which on those pages is a transparent layer.
The image alone did better than image plus facts until the caution told it to judge by the image. The outline
did not help. On the report side the order of the two leaders flipped: image + tag only scored AP 0.668 and image +
facts + caution 0.576, a difference of +0.092 with a 95% interval of −0.007 to 0.193. With 25 dev reals the choice
between them is still open.

## What it shows

The numbers are on the report side; the tables are in RESULTS.md.

- **Clef with the screenshot beats the v1 rules and the v1 gbt-small model.** AP is 0.576 for the dev choice and
  0.668 for image + tag only, against 0.087 for gbt-small, which is no better than the base rate here. At the rules'
  recall of 0.807, Clef's precision is 0.39 and the rules' is 0.225.
- **By family:**
  - Media, clearly. Using Clef's media probability, precision is 0.90 at the image rules' recall of 0.889; the rules
    reach 0.50.
  - Occlusion and dark, with few reals (16 and 17). At the rules' recall, image + tag only reaches precision 0.37 and
    0.31 where the rules get 0.04 and 0.10. The dev choice reaches 0.07 and 0.20.
  - Overflow is the exception. `page-overflow-x` gets 0.52 at recall 0.80 and Clef gets 0.41 at that recall: a page
    that scrolls sideways is a measurement the crop cannot show. The facts help here (own-family AP 0.571 with facts,
    0.385 without).
- **The image does the work.** Facts alone give AP 0.267, and the image adds +0.309 [0.231, 0.376]. Clef-flash is
  weaker (AP 0.328 with the image) and slower (613 ms median one call at a time, against Clef's 262 ms), though it
  costs a sixth as much.

## Recommendation: both

1. **Use it in the scanner as a second stage on the rules' findings, not as a detector of its own.** With the rules
   first and Clef second at the dev threshold, precision goes from 0.225 to 0.56 to 0.65 and recall from 0.807 to
   0.54 to 0.61. Most of the gain is on the noisy rules:
   - `control-unreachable`: 195 flagged, 18 real; Clef keeps 22 to 41, of which 9 to 15 are real.
   - `css-var-undefined`: 47 flagged, none real; Clef keeps 0 to 9.

   Leave `page-overflow-x`, `image-broken` and `text-template-leak` findings as they are, because Clef drops 13 to
   14 of the 34 overflow reals. The cost is $0.0096 to $0.0125 per 40-candidate scan. Each call takes about 0.3 s on the
   server, and 40 sent at once finished in about 2 s seen from outside Cloudflare.
2. **Use it as a teacher for the in-browser model.** Recall at precision 0.8 is 0.25 to 0.40 overall and 0.89 to 1.0
   for media. The lowest-scored half of the crops holds 4 to 5% of the reals. Labelling costs $0.24 to $0.31 per
   1,000 elements.
   - Use the low end as "fine" and the media labels as they are.
   - Have a person check the other positives. Precision is about 0.6 at recall 0.4 to 0.6.
   - Do not use its family label for dark-scheme bugs; it calls them `text`.

Before fixing the prompt, settle image + tag only against image + facts on a fresh labelled batch. It decides the
overflow trade-off and saves about 300 tokens a call.

## Run

```
python3 eval.py prepare --data DATA --work WORK
export CLEF_EVAL_URL=https://genclass-clef-eval.mehar-144.workers.dev CLEF_EVAL_KEY_FILE=<file holding the key>
python3 eval.py run --work WORK --variant clef-img-p3 --split dev        # then --split report
python3 eval.py report --work WORK --out WORK/metrics.json
python3 eval.py latency --work WORK --variant clef-img-p3              # one call at a time, then 40 at once
python3 eval.py show --work WORK --variant clef-img-p3 --id <crop id>   # the exact request, without the image
```

Python 3.9+, numpy, and Pillow for the outline variants. Answers are cached one file per crop under `WORK/runs/`, so
a run resumes where it stopped.
