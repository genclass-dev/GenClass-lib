# Show HN: brief for the repost

Status: draft, not posted. Prepared 2026-10-25.

## Read this first: write the post by hand

Hacker News does not accept text written or edited by an LLM, and this brief was prepared with one. So it is a fact
sheet and an outline, not text to paste. The person posting writes the title and the comment in their own words.

- Guidelines: "Don't post generated text or AI-edited text. HN is for conversation between humans."
  (https://news.ycombinator.com/newsguidelines.html)
- dang's Show HN tips, edited 2026-03-28: "Write your text by hand. Don't use an LLM to generate any of it (not even a
  tiny bit, including to edit or spruce it up)." (https://news.ycombinator.com/item?id=22336638)

Other rules that apply here: post from a personal account (not one named after the project), stay in the thread for
the first hours, do not ask anyone to upvote or comment, and do not delete and repost.

## Why a repost is allowed, and what to say about the first one

The first Show HN (2026-10-14 02:59 UTC, https://news.ycombinator.com/item?id=50081861, "Show HN: GenClass, A 10 MB
in-browser model that catches bugs that never throw") got 3 points and 0 comments. It linked the npm page, which
people cannot try, and its claims went beyond the README's numbers.

- HN FAQ: "If a story has not had significant attention in the last year or so, a small number of reposts is ok."
  (https://news.ycombinator.com/newsfaq.html)
- dang to someone in the same situation: "You could certainly repost the project itself as a Show HN, though, since
  [the earlier one] didn't get attention", adding that the repost should come with "a comment ... giving the backstory
  of how you came to work on this, and explaining what's different about it." (https://news.ycombinator.com/item?id=26958794)

So the first comment links the earlier thread in one line and says what is different: the repo and a live demo instead
of the npm page, numbers taken from the README and the bench instead of claims, and the bench itself.

## Link targets

- Submission URL: the GitHub repo, https://github.com/genclass-dev/GenClass-lib (people can read the code and the bench;
  Show HN wants something people can try).
- Live demo: https://genclass.dev/#lab (the real runtime in the browser, no signup).
- The bench: https://github.com/genclass-dev/GenClass-lib/tree/main/bench/fixes and its results,
  https://github.com/genclass-dev/GenClass-lib/blob/main/bench/fixes/RESULTS.md

## Title

At most 80 characters, starting with "Show HN:", plain words, no superlatives. Directions to word in your own way:

- name plus what it does: GenClass, reports stale responses and double submits in web apps
- the bench as the hook: how often 14 common race-condition fixes fail, measured, plus a detector
- both: GenClass, a race-condition reporter for web apps, with a bench of 14 fixes

Avoid what the first title did: "catches bugs that never throw" claims more than the numbers below support.

## First comment: what to cover, in this order

Facts and links only; the sentences are yours.

1. **What people can try, first.**
   - The live demo, https://genclass.dev/#lab (no signup).
   - The bench on their own machine: `git clone https://github.com/genclass-dev/GenClass-lib && cd GenClass-lib &&
     ./bench/fixes/run.sh --conditions off --seeds 20` (a few minutes; Node 20+, Chromium through Playwright).
   - In an app: one script tag first in `<head>`, or `npm install @genclass/runtime@beta` and
     `import "@genclass/runtime/auto"`. Observe mode by default: it reports and changes nothing.
2. **What it is, in two sentences.** An Apache-2.0 browser library that records fetch/XHR/WebSocket traffic, clicks
   and app state, computes facts about each response and write, and asks a 10 MB model running in a Web Worker
   (WASM or WebGPU) whether a response is landing over newer data, a request is a repeat, or state broke. There is no
   list of known bugs in the code.
3. **Backstory, in your words.** Why you built it, what bug started it. (dang: "Include text giving the backstory of
   how you came to work on this, and explaining what's different about it.")
4. **The hook: the bench.** We built one small page per common fix and ran each 200 times per network profile with a
   seeded server and a scripted user:
   - no guard on a search box: wrong results at the end in 52.5% of runs when answers arrive in any
     order (50 to 900 ms), 0% on a fast in-order server, which is why it passes on localhost;
   - debounce 300 ms alone: 0% on that network (the user's typing outlasted every answer), but
     7.5% once one request in ten takes 1.5 to 4 s;
   - every real guard (ignore flag, AbortController, request id, TanStack Query key, SWR key, RxJS switchMap, Vue
     watch cleanup, Svelte 5 effect teardown): 0% wrong;
   - double submit: disabling the button left 72.5% duplicates when the server answered in 20 to 60 ms,
     TanStack `useMutation` with `isPending` 43.5%, an idempotency key 0%.
5. **The model's numbers, with the false rate next to them** (README, docs/runtime/RESULTS.md section 1, held-out real
   apps, model 0.2.0 at the default profile): it reports 75% of duplicate submits, 30% of stale overwrites and 6% of
   broken state, at a report threshold fitted to keep false detections at or under 2% of clean decisions (met on
   held-out test; the exact rate is not published). Across the compatibility matrix (7 frameworks, 15 data layers,
   every mode) it introduced 0 bugs in 3,510 runs; observe reported 49 false findings in 880 runs of correct apps, all
   in one polling and fan-out scenario.
6. **On the bench** (observe, default model, its default "likely" reports, 50 seeds per page and network): stale
   results reported in 70% of the runs that ended wrong (35 of 50), false reports
   on 0 of 1,200 runs of the correct search fixes; double submits reported in 100% of
   unguarded runs and 100% of the duplicates a disabled button let through, false reports
   on 0 of 240 clean runs of those pages. Say the caveats too: it flagged 36.7% of the
   debounce page's runs, which ended right, and every second POST that an idempotency key made harmless. With the
   model skipped it reports nothing.
7. **Costs, plainly.**
   - About 13 MB downloaded on the first visit on WASM (model 10 MB plus ONNX Runtime), 18 MB on WebGPU, cached after.
   - 190 to 280 MB of memory in a Web Worker while the model is loaded; devices reporting 2 GB or less and Save-Data
     connections skip the model by default.
   - About 100 KB gzip of JavaScript on the main thread with the npm import (128 KB for the script-tag file).
   - Anonymous diagnostics on by default (decisions and counts, no page text), off on localhost and private hosts.
     Opt-outs: `telemetry: false`, `?genclass=no-telemetry`, `localStorage.setItem("genclass.telemetry", "off")`,
     and Global Privacy Control is honoured. Details: packages/runtime/TELEMETRY.md.
8. **Limits.** Recall is low: at the default profile guard mode acts on under 8% of the cases where acting would help,
   which is why observe is the default. The bench is one machine with synthetic latency.
9. **The earlier thread**, one line: link https://news.ycombinator.com/item?id=50081861 and what changed.
10. **What feedback you want.** For example: false reports on real apps (there is an issue form for them), and
    whether the telemetry default is acceptable.

## When to post

The data disagrees and the effect is small, so pick a slot when the poster can stay in the thread for three or four
hours.

- Myriade, 157k+ Show HN posts since 2009 (2025-07-18): Sunday breaks out (30+ points) 11.75% of the time, weekdays
  9.45% to 9.90%; by hour, 11:00 to 16:00 UTC is above 10.5% (peak 12:00 UTC, 12.2%), 03:00 to 07:00 UTC lowest
  (about 8.2% to 8.4%); Sunday 00:00 to 02:00 UTC up to 15.7%.
  https://www.myriade.ai/blogs/when-is-it-the-best-time-to-post-on-show-hn
- Alcazar Security (2026-03-14) reconciles the guides: weekday US mornings give the largest audience, weekends the best
  odds per post. https://blog.alcazarsec.com/tech/posts/best-time-to-post-on-hacker-news
- Max Woolf (2014, 1.27M submissions): submission time was "uncorrelated with the number of viral posts".
  https://minimaxir.com/2014/02/hacking-hacker-news/
- dang (2025-09-17): "There's too much randomness to expect any consistency."
  https://news.ycombinator.com/item?id=45277359

The first post went up at 02:59 UTC on a Wednesday, inside the weakest band. Suggested: a Sunday between 12:00 and
16:00 UTC, or Tuesday to Thursday 12:00 to 16:00 UTC (European afternoon, US morning).

## Email to hn@ycombinator.com (second-chance pool)

Send it only if the repost gets little attention, within a day or two of posting: dang has had to respawn posts that
were "too old for the second-chance pool" (https://news.ycombinator.com/item?id=41173008). Asking for your own post is
allowed, though they prefer nominations of others' posts (https://news.ycombinator.com/item?id=46018486). The same
hand-writing rule applies; this is what it should contain, not the wording:

- Subject: the post's title.
- One line: the link to the new Show HN, posted on (date), and that it is your own project.
- One line: what someone can try (the live demo, the bench command).
- One line: that an earlier Show HN (item 50081861) got no discussion and linked the npm page, and what is different
  now.
- Thanks. No follow-up if there is no answer: in March 2026 dang wrote that they "can't respond to emails about
  this any more because there are far too many of them" (about Show HN presentation, in the tips comment above).
