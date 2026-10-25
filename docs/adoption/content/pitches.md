# Pitches

Status: drafts, nothing sent. Prepared 2026-10-25. Send each from a personal address, rewritten in your own words
where the channel is a community (Reactiflux) or asks for human writing; check the channel's current rules first.

## Facts every pitch can use

- **What:** GenClass (`@genclass/runtime`, Apache-2.0), a browser library that reports stale responses, double submits
  and broken state while the app runs. A 10 MB model in a Web Worker decides; observe mode, the default, only reports.
- **Try:** live demo https://genclass.dev/#lab (no signup); repo https://github.com/genclass-dev/GenClass-lib;
  install: one script tag, or `npm install @genclass/runtime@beta`.
- **Model numbers, false rate next to them** (held-out real apps, default profile): reports 75% of duplicate submits,
  30% of stale overwrites, 6% of broken state; report threshold fitted to keep false detections at or under 2% of clean
  decisions. 0 bugs introduced in 3,510 compatibility runs (7 frameworks, 15 data layers).
- **New: the fix bench** (bench/fixes): 14 pages, one per common fix, 200 seeded runs per network profile.
  No guard on a search box: wrong results in 52.5% of runs when answers arrive in any order,
  0% on a fast local server. Debounce alone: 7.5% once one request in ten takes
  1.5 to 4 s. Every real guard: 0 wrong. A button disabled while pending still double-submitted 72.5% of
  the time on a fast server. GenClass observe on the same pages: reported 70% of the stale-result runs
  and 100% of the double submits, with false reports on 0 of 1,200 runs of the correct
  search fixes; it also flagged 36.7% of the debounce page's runs (all ended right) and every second POST an
  idempotency key absorbed.
- **Costs:** about 13 MB on the first visit (cached), 190 to 280 MB in a worker while the model is loaded, anonymous
  diagnostics on by default except on local hosts (off with `telemetry: false`, `?genclass=no-telemetry`,
  localStorage, or Global Privacy Control).
- **Status:** 0.3.0 is in beta on npm (`@beta`); stable is 0.2.x.

## console.dev (newsletter): hello@console.dev

Fit: they review devtools and list "beta and early access releases"; criteria include "Does it help me reduce/manage
bugs", self-service signup ("an individual developer should be able to try it themselves without speaking to
anyone") and "Does it have any negative impact on security or privacy?" (https://console.dev/selection-criteria). No
sponsored reviews. Pitch the 0.3.0 beta, lead with privacy facts.

> Subject: Beta devtool: GenClass reports race conditions in web apps (open source)
>
> Hi David,
>
> GenClass is an Apache-2.0 browser library that reports stale responses, double submits and broken state while an app
> runs. A 10 MB model runs in a Web Worker, on the device; the default mode only reports. 0.3.0 is in beta on npm
> (`npm install @genclass/runtime@beta`), and there is a no-signup demo at https://genclass.dev/#lab.
>
> Numbers, false rates included: on held-out real apps it reports 75% of duplicate submits and 30% of stale overwrites
> at a threshold that keeps false detections at or under 2% of clean decisions. We also published a bench of the usual
> fixes: a search box with no guard was wrong in 52.5% of runs on a jittery network and
> 0% on a fast one, and on those pages GenClass reported 70% of the broken runs
> with false reports on 0 of 1,200 runs of the correct fixes (it does flag a debounced page that is
> fine; the bench says how often).
>
> Privacy, since you ask about it: decisions are local; anonymous diagnostics (decisions and counts, no page text) are
> on by default except on local hosts, with four opt-outs including Global Privacy Control. TELEMETRY.md in the repo
> lists every field.
>
> Repo: https://github.com/genclass-dev/GenClass-lib. I maintain it.
>
> Thanks,
> (name)

## Changelog News: https://changelog.com/news/submit (sign-in)

Fields: URL, Title, "What's interesting about it?". They encourage submitting your own work, exclude "How-to's and
tutorials" and "Commercial products/services", and say "Do your best to convince us why something is newsworthy."
Submit the bench results (news: measured numbers nobody had), not the product.

- URL: https://github.com/genclass-dev/GenClass-lib/blob/main/bench/fixes/RESULTS.md
- Title: How often the usual race-condition fixes fail, measured over 14,600 browser runs
- What's interesting: Every guide to stale search results shows a fix; none measures it. This open-source bench ran 14
  small pages (React, TanStack Query, SWR, RxJS, Vue, Svelte 5) 200 times per network profile with a seeded server.
  No guard: wrong results in 52.5% of runs when answers arrive in any order, 0% on a
  fast server (why it ships). Debounce alone failed in 7.5% of runs once a tenth of requests were slow.
  Every real guard: 0. Disabling the submit button still double-submitted 72.5% of the time on a fast
  server. Raw results are committed; one command reproduces it. (Disclosure: I maintain GenClass, whose repo hosts it.)

## Cooperpress (JavaScript Weekly, React Status, Frontend Focus): editor@cooperpress.com or https://cooperpress.com/submit/

They take "a fresh tutorial, great video, a new tool, or opinion piece"; no per-newsletter address. React Status suits
the React numbers; JavaScript Weekly the cross-framework bench. Keep it to what the editor can paste as a blurb.

> Subject: Measured: how often the usual race-condition fixes fail (open-source bench)
>
> Hi,
>
> For React Status or JavaScript Weekly, if it fits: we ran one small page per common fix for stale search results
> (no guard, debounce, ignore flag, AbortController, request id, TanStack Query, SWR, RxJS switchMap, Vue, Svelte 5)
> 200 times per network profile with a seeded server and Playwright. No guard ended on the wrong results in
> 52.5% of runs when answers arrived in any order, and in 0% on a fast local server.
> Debounce alone held until one request in ten was slow (7.5% wrong then). Every real guard was right in
> every run. For double submits, a button disabled while pending still created two records in 72.5% of
> double-clicks on a fast server; an idempotency key, 0.
>
> Results and code: https://github.com/genclass-dev/GenClass-lib/blob/main/bench/fixes/RESULTS.md
> Guide by framework: (genclass.dev/guides link once published)
>
> Disclosure: the bench lives in the repo of GenClass, an Apache-2.0 library I maintain that reports these races at
> runtime; it is measured in the same bench (70% of broken search runs reported, false reports on
> 0 of 1,200 runs of the correct fixes, with its caveats listed).
>
> Thanks,
> (name)

## Web Tools Weekly: DM @LouisLazaris on X or Bluesky

Tools only ("Please don't submit articles or tutorials, they will not be included"), front-end focus, submitted by
direct message. Keep it to two or three lines.

> Hi Louis, a front-end tool for Web Tools Weekly if it fits: GenClass (Apache-2.0) is one script tag that reports
> stale responses and double submits while your app runs, using a small on-device model; the default mode changes
> nothing. No-signup demo: https://genclass.dev/#lab, repo: https://github.com/genclass-dev/GenClass-lib. On held-out
> real apps it reports 75% of duplicate submits at a threshold fitted to at most 2% false detections. I maintain it.

## devtools.fm (podcast): https://www.devtools.fm/guests

Form fields: Name, Email, Twitter, Description. "Do you work on a developer tool? Do you want to share your story?"
Description (pitch an episode, not the product):

> I maintain GenClass, an open-source runtime that runs a 10 MB model inside the browser to report race conditions
> (stale responses, double submits) in web apps. Topics: why "never make a correct app worse" shaped the design
> (decisions happen at the network boundary, observe never holds anything); training a small model on simulated and
> real apps and choosing thresholds by false-intervention rate; what a bench of 14 common fixes showed (debounce is not
> a guard, a disabled button double-submits on fast servers); and shipping telemetry honestly in a library.

## PodRocket (LogRocket): producer Elizabeth, elizabeth.becz@logrocket.com (from the 2026-07-16 show notes)

No guest form; the latest episode listed is from 2026-07-16 and some recent ones are repeats, so check that the show
is still recording before sending. Pitch a front-end topic.

> Subject: Episode idea: race conditions in front-end apps, measured
>
> Hi Elizabeth,
>
> An episode idea for PodRocket: the race conditions every front-end app has (results for "rea" showing under
> "react", the double-clicked Create button) and what actually fixes them. I ran the usual fixes 200 times each across
> network profiles: no guard was wrong in 52.5% of runs on a jittery network but 0%
> on a fast one, which is why these bugs pass review; debounce is not a guard; a disabled button still double-submits
> on fast servers. I maintain GenClass, an open-source library that reports these at runtime with an on-device model,
> and can talk about the trade-offs of shipping a model in a library (13 MB first visit, telemetry defaults) as well.
> Bench: https://github.com/genclass-dev/GenClass-lib/blob/main/bench/fixes/RESULTS.md
>
> Thanks,
> (name)

## Reactiflux #i-built-this

"New side projects, libraries, or other works you want to show off ... predominantly meant as a showcase for
individuals, but may be used for launch announcements of indie works." Rules: be an active member first (they "grant
more leeway to members who have been active participants"), drop a note in #introductions, read the channel's pinned
rules in Discord, no "announcing an announcement", no asking people to subscribe
(https://www.reactiflux.com/promotion). Write the post yourself, short, in your own voice. Points to cover:

- one line on what it is and that you made it;
- the React-specific numbers: no guard in `useEffect` wrong in 52.5% of jittery runs and
  0% of fast ones; ignore flag and AbortController 0; TanStack `useMutation` with `isPending` still
  double-submitted 43.5% of the time on a fast server;
- the GenClass numbers on those pages with the false rate (70% of stale runs detected, false
  reports on 0 of 1,200 runs of the correct fixes, and the debounce caveat);
- the links (demo, repo, bench) and what feedback you want.

The bench results alone also fit #i-wrote-this as a write-up once the guide is published ("Episodic content may only be
shared once every 2 weeks").
