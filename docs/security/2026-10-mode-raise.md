DRAFT for the owner to publish through GitHub's security advisory form. Do not publish this file as is.

<!--
Draft of a GitHub Security Advisory (GHSA) for the GenClass-lib repository. The headings follow the form's fields.
Everything below was checked against the tags, the npm tarballs and the commits named in "Evidence"; the lines marked
"owner" are decisions or follow-ups the form will ask for or that the repository still needs.
-->

# `@genclass/runtime`: a link could raise GenClass from observe to guard or heal on sites with `debug: true` and on hosts that only look local

| field | value |
|---|---|
| Ecosystem | npm |
| Package | `@genclass/runtime` |
| Affected versions | `>= 0.1.0-alpha.0, <= 0.2.2` (every 0.1.x prerelease, 0.2.0, 0.2.1, 0.2.2, npm's `latest`); `>= 0.3.0-beta.0, <= 0.3.0-beta.1` |
| Patched versions | `0.3.0-beta.2` (npm dist-tag `beta`, 2026-10-25); `0.2.3` on dist-tag `latest` (pending, not published at the time of this draft) |
| Not affected | `0.0.0-stage` (a placeholder package with no code), `0.3.0-beta.2` and later |
| Severity | Medium, CVSS 3.1 5.4 (`CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:L`), see "Severity" |
| CWE | CWE-15 (External Control of System or Configuration Setting); secondary CWE-489 (Active Debug Code) for the `debug` bypass |
| Credits | the GenClass maintainers (found while testing 0.3.0-beta.0 in a pilot app, 2026-10-17) |
| CVE | none requested yet (owner: tick "Request CVE" in the form if wanted) |

## Summary

`@genclass/runtime` runs inside a web app in one of three modes: `observe` (the default, report only), `guard` (opt-in:
holds and small reversible actions at the network boundary) and `heal` (experimental: blocking, cached and retried
requests, store rollbacks). The URL switch `?genclass=observe|guard|heal` and `localStorage.genclass` exist so a
developer can try another mode on one page load. In the affected versions that switch could also *raise* the mode on a
production site, so a crafted link opened by a visitor turned guard-tier or heal-tier actions on for that visitor's page
load, in two situations:

1. the app had `debug: true` set (documented as console logging only; from `GenClass.init()`, `window.GENCLASS_CONFIG`,
   the options file `init` writes, `<meta name="genclass" content="debug">` or `data-debug` on the script tag); then
   `?genclass=guard|heal`, `localStorage.genclass`, `?genclass-mode=`, `?genclass-aggr=` and `?genclass-sample=1`
   could raise the mode, the aggressiveness and the acting cohort on any host, and `?genclass-mode=` could even undo a
   lowering `?genclass=observe`;
2. the page's host passed telemetry's broad "local host" test (0.2.2 to 0.3.0-beta.1): intranet bare names, private
   addresses, `*.internal`, `*.local`, `*.home.arpa`, Capacitor (`https://localhost`), Tauri (`tauri.localhost`) and
   Electron (`file:`); then `?genclass=guard|heal` raised the mode without `debug`.

Versions before 0.2.2 were wider open: 0.1.0-alpha.0 to 0.1.0-beta.0 applied the switch on every host with no condition,
and 0.1.0-beta.2 to 0.2.1 let `?genclass=guard` raise a site that set no `mode` (the switch compared against a `guard`
baseline while the runtime defaulted to `observe`).

Since 0.3.0-beta.2, `debug` is console logging only; `?genclass-mode`, `?genclass-aggr` and `?genclass-sample` only
lower, on every host; `?genclass=` and `localStorage.genclass` may raise the mode only on a narrow development host
(`src/devhost.ts`: http(s) on `localhost`, `127.0.0.1`, `[::1]` or `*.localhost` with an explicit port, or a `*.test`
name). Lowering (`?genclass=off`, `?genclass=observe`) keeps working everywhere, and telemetry's own local-host rule and
opt-outs are unchanged. No model-visible text changed.

## Details

### Mechanism

`GenClass.init()` (also behind the zero-code entries `@genclass/runtime/auto` and the script tag) reads one value from
`location.search` (`genclass`) or, when the URL has none, from `localStorage.genclass`
(`packages/runtime/src/index.ts`, `killSwitch`). `off` installs nothing. `observe`, `guard` or `heal` becomes the mode
when a rule allows it. The rule, per version:

- 0.1.0-alpha.0 to 0.1.0-beta.0: no rule; the value is the mode (`index.ts:128`, `:128`, `:142`).
- 0.1.0-beta.1 to 0.2.1: `options.debug || rank(value) <= rank(options.mode ?? "guard")` (`index.ts:251`, `:265`,
  `:282`, `:292`, `:292`). The `?? "guard"` baseline was correct only in 0.1.0-beta.1, whose runtime also defaulted to
  guard; from 0.1.0-beta.2 the runtime defaults to observe (`runtime.ts:310` and later), so for an app that set no
  `mode` the comparison allowed `guard` (rank 1 is not above the baseline's rank 1) and the page went from observe to
  guard on any host, no `debug` needed. `heal` still needed `debug`.
- 0.2.2 to 0.3.0-beta.1: `options.debug || isLocalHost(location.hostname) || rank(value) <= rank(options.mode ?? "observe")`
  (`index.ts:310`, `:345`, `:348`). The baseline is right, but two bypasses stay: `debug`, and `isLocalHost`, which is
  telemetry's rule for "do not send from here" (`packages/runtime/src/telemetry/config.ts:26-38`): it accepts an empty
  hostname (`file:` pages), `localhost`, `0.0.0.0`, `::1`, `*.localhost`, `*.local`, `*.test`, `*.internal`,
  `*.home.arpa`, the private and link-local IPv4 ranges (10/8, 127/8, 0/8, 192.168/16, 172.16/12, 169.254/16,
  100.64/10), IPv6 `fc`/`fd`/`fe80:` addresses and any bare name without a dot. A false "local" there only sends less;
  used for the mode switch it let a link raise every app that ships its UI from such a host.

Independently, `createRuntime()` (reached by `GenClass.init()` too) reads `?genclass-mode=`, `?genclass-aggr=` and
`?genclass-sample=` (`packages/runtime/src/runtime.ts`). From 0.1.0-beta.1 to 0.3.0-beta.1 each had a `debug` bypass:
`if (this.debug || MODE_RANK[um] <= MODE_RANK[this._mode])`, `if (this.debug || v <= this._aggr)` and
`if (urlSample === "1" && this.debug) return true` (0.2.2: `runtime.ts:370`, `:381`, `:574`). With `debug` on,
`?genclass-mode=heal` raised the mode after `index.ts` had applied the `?genclass=` switch, so
`?genclass=observe&genclass-mode=heal` on an app in heal mode ended in heal, not observe; `?genclass-aggr=eager` raised
the aggressiveness (lower gate thresholds); `?genclass-sample=1` put a session the app's `sample` had placed in the
observe cohort into the acting cohort.

The fix (`12f4a5c` in PR #64, ported to main as `5a6b48f` / merge `c2379a7`, released in 0.3.0-beta.2): `index.ts`
drops the `debug` term and replaces `isLocalHost` with `devHost` from the new `src/devhost.ts` (http(s) on
`localhost`, `127.0.0.1`, `[::1]` or `*.localhost` with an explicit port, or `*.test`; never Capacitor, Tauri, Electron,
intranet names, private addresses, `*.internal` or `*.local`); `runtime.ts` makes the three other switches lower-only on
every host and `?genclass-sample=1` a no-op. `test/mode-switch.test.ts` pins every case above, including the
look-alike hosts. The published 0.3.0-beta.2 tarball carries the new predicate and neither `debug` pattern (checked in
`dist/`); the published 0.2.2 tarball carries both (`dist/chunk-7ODWDTWV.js`, `dist/genclass.global.js`,
`dist/genclass.global.min.js`).

### Exact conditions

All of the following must hold for a link to raise a visitor's page load:

- the page runs an affected version through `GenClass.init()`, `@genclass/runtime/auto` (or `/auto/observe`), or the
  script-tag build (`createRuntime()` alone is reached by the `?genclass-mode` / `-aggr` / `-sample` part only);
- the visitor opens a URL whose query string the attacker chose (`?genclass=guard`, `?genclass=heal`, or with `debug`
  also `?genclass-mode=`, `?genclass-aggr=`, `?genclass-sample=1`), or the attacker can set `localStorage.genclass` in
  the page's origin (which needs script execution there and is out of scope: such a script can call
  `GenClass.runtime.setMode("heal")` directly, THREAT-MODEL T1);
- and one of: the app set `debug: true` by any route (0.1.0-beta.1 to 0.3.0-beta.1); the page's host passes
  `isLocalHost` (0.2.2 to 0.3.0-beta.1); the app set no `mode` and the value is `guard` (0.1.0-beta.2 to 0.2.1); or the
  version is 0.1.0-alpha.0 to 0.1.0-beta.0 (no condition);
- a model is loaded (the default; `model: false` means the runtime only observes whatever the mode says), the page is
  visible, and the policy gate clears a model decision for a subject that is not protected, cross-origin or in an
  observe-scoped route.

The switch is read once, when GenClass starts (a page load). Nothing is written back: no version stores a
`?genclass=` value in `localStorage` or `sessionStorage` (`killSwitch` only reads; the only `genclass`-named writes are
`genclass:bucket`, the sampling bucket, which the `?genclass-sample=1` branch returns before reaching, `genclass:learn`,
the breaker's key and, since 0.3.0-beta.2, `genclass.analytics.<token>`). So one click raises that page load only; a
later page load without the parameter is back at the app's configuration. In a single-page app the raised mode lasts
while the page load lasts, however many client-side routes it visits.

### What the attacker controls, and what not

The attacker controls the query string of a link and thereby which tier is enabled (guard or heal), the aggressiveness
profile and the sampling cohort for one visitor's page load. The attacker does not control what then happens: every
action is chosen by the local model from the fixed list the runtime offers for one subject, must pass the policy gate
(`src/decide/policy.ts`), and runs only when the top diagnosis is not `expected`. The attacker cannot name an action,
a request or a store, cannot see the page, and gets nothing back; telemetry sends the same redacted diagnostics it
sends in every mode (with a `decision` event per action, no page text), and the attacker does not receive it.

### What guard and heal may do to the page (`packages/runtime/INTERCEPTION.md`, "What each mode may change" and "Actions")

observe never holds, delays, drops, retries, replays or answers anything and never writes app state. A raised page
load may instead see:

- **guard tier**: requests and responses held for the model's decision, each within the hold budget ("auto" = 1.5 x
  the model's median latency, clamped to 150 to 800 ms; fail open when the model is late); `coalesce` (an identical
  request in flight or finished up to 2 s ago is not sent again, the app gets that response, any method including
  POST); `delay` (a request sent after 250 ms x 2^(recent failure streak), at most 8 s); `discard` and `defer` of held
  store writes and of a response's writes over newer data (registered stores only; reversible).
- **heal tier** adds: `block` (the request is not sent and answered 503 with `x-genclass: blocked`); `serve_cached`
  (a GET is answered from the last good response of this page's memory, up to 256 KB); `retry` (an idempotent or
  idempotency-keyed request sent again, up to 4 attempts); `hedge` (a second identical GET); `rollback` and `resync`
  of registered stores to the last consistent snapshot. With `visual: { on: true, fix: true }` configured, the three
  measured visual fixes (one colour rule, removing a leaked inline `pointer-events: none` or `overflow: hidden`) also
  need guard or heal and so become reachable.

Bounds that hold in every mode and limit the impact: a request's URL, method, headers and body are never changed;
cookies are never read or written; a non-idempotent request is never sent twice without an idempotency key; a cached
response is served only to an identical GET; requests under `requests.protect` (the payments and auth presets, when
configured), cross-origin requests and observe-scoped routes are never acted on; discovered React, Redux or Zustand
state is never written; every action is recorded with an undo where one exists, two undos in 10 minutes or three errors
after actions trip the breaker back to observe for the session, and `rt.disable()` restores the page. Impact is
therefore limited to that visitor's page load: added latency, a request answered locally (coalesced, cached, blocked
with a 503) or retried, and reversible writes to stores the app registered.

## Affected versions

| npm version | published (npm) | affected | why |
|---|---|---|---|
| 0.0.0-stage | 2026-10-08 | no | a 367-byte placeholder tarball (`package.json` with `"stub": true` and a README); no code |
| 0.1.0-alpha.0, 0.1.0-alpha.1, 0.1.0-beta.0 | 2026-10-08 | yes, worst | `?genclass=` sets the mode on every host, no condition (unsupported line) |
| 0.1.0-beta.1 | 2026-10-08 | yes | raise needs `debug: true` (default mode was guard); `-mode` / `-aggr` / `-sample` debug bypasses |
| 0.1.0-beta.2, 0.1.0-beta.3, 0.2.0, 0.2.1 | 2026-10-08 to 2026-10-11 | yes | `?genclass=guard` raises an app that set no `mode` on every host; `heal` and the other switches need `debug` |
| 0.2.2 (`latest`) | 2026-10-15 | yes | raise needs `debug: true` or a host `isLocalHost` accepts; `-mode` / `-aggr` / `-sample` debug bypasses |
| 0.3.0-beta.0, 0.3.0-beta.1 | 2026-10-15, 2026-10-24 | yes | same as 0.2.2 |
| 0.3.0-beta.2, 0.3.0-beta.3, 0.3.0-beta.4 (`beta`) | 2026-10-25 to 2026-10-27 | no | fixed |

GHSA ranges: `>= 0.1.0-alpha.0, <= 0.2.2` and `>= 0.3.0-beta.0, < 0.3.0-beta.2`. Every version on npm except
`0.0.0-stage` has a matching `v*` tag in this repository; there is no other npm-only version.

## Patched versions

- `0.3.0-beta.2` (npm dist-tag `beta`), published 2026-10-25; `0.3.0-beta.3` and `0.3.0-beta.4` carry the fix.
  `npm install @genclass/runtime@beta`; script tags: pin `@0.3.0-beta.4` (or the newest beta).
- `0.2.3` (npm dist-tag `latest`): pending. Until it is published, a project on the stable line should either move to
  `@beta` or apply the workarounds below. (owner: publish 0.2.3 from a `v0.2.3` tag through `release.yml`, then fill
  the form's patched version for the `<= 0.2.2` range; until then the form can state "no patched version on the 0.2
  line yet".)

Where the fix lives: `packages/runtime/src/devhost.ts` (new), `src/index.ts` (`initUnsafe`), `src/runtime.ts`
(constructor and `sampleBucket`), `src/visual/start.ts` (re-exports `devHost`), `test/mode-switch.test.ts` (new) and
three flipped tests (`test/default-mode.test.ts`, `test/gates.test.ts`, `test/report.test.ts`).

## Version-by-version evidence

Paths are under `packages/runtime/src/` at the named tag (`git show <tag>:packages/runtime/src/<path>`). "public +
debug" is a public host with `debug: true`; "look-alike" is a host telemetry's `isLocalHost` accepts
(`telemetry/config.ts`) without `debug`; "no mode" is an app that set no `mode`. "persisted" asks whether a
`?genclass=` value is ever written to storage.

| version (tag) | `?genclass=` / `localStorage.genclass` raise: public + debug | look-alike host, no debug | public, no debug, no mode | `?genclass-mode` / `-aggr` / `-sample=1` debug bypass | persisted | script tag `data-debug` / meta `debug` | evidence |
|---|---|---|---|---|---|---|---|
| 0.0.0-stage (no tag) | n/a | n/a | n/a | n/a | n/a | n/a | npm tarball: `package.json` (`"stub": true`), `README.md`; no `dist/` |
| 0.1.0-alpha.0 | yes (no condition at all) | yes | yes (any value, any host) | no such switches | no | no script-tag build, no `cdn/` | `index.ts:128` `const mode = ks && MODES.includes(ks) ? ks : options.mode`; `runtime.ts:186` default `guard`; `killSwitch` `index.ts:74-91` reads only |
| 0.1.0-alpha.1 | yes (no condition) | yes | yes | no such switches | no | no `cdn/` | `index.ts:128` (same line); `runtime.ts:205` default `observe` |
| 0.1.0-beta.0 | yes (no condition) | yes | yes | no such switches | no | `cdn/config.ts:100-101` `case "debug": c.debug = !isOff(lv)` (moot: no condition); every `<meta name="genclass">` in head or body read (`cdn/config.ts:14`) | `index.ts:142`; `runtime.ts:216` default `observe` |
| 0.1.0-beta.1 | yes | yes (debug is the only gate) | no (`heal`); `guard` is the default mode here, not a raise | yes: `runtime.ts:308`, `:319`, `:496` | no | `cdn/config.ts:87-88`; meta anywhere | `index.ts:248-251` `options.debug \|\| rank(ks) <= rank(base)`, `base = options.mode ?? "guard"` (`:250`); `runtime.ts:306` default `guard` |
| 0.1.0-beta.2 | yes | yes (debug only) | yes: `guard` passes against the `guard` baseline while the runtime defaults to `observe` | yes: `runtime.ts:312`, `:323`, `:501` | no | `cdn/config.ts:100-101`; meta anywhere | `index.ts:262-265`, `base ... ?? "guard"` (`:264`); `runtime.ts:310` default `observe` |
| 0.1.0-beta.3 | yes | yes (debug only) | yes (`guard`) | yes: `runtime.ts:329`, `:340`, `:523` | no | `cdn/config.ts:100-101`; meta anywhere | `index.ts:279-282` (`:281` baseline `guard`); `runtime.ts:327` default `observe` |
| 0.2.0 | yes | yes (debug only) | yes (`guard`) | yes: `runtime.ts:367`, `:378`, `:566` | no | `cdn/config.ts:101-102`; meta anywhere | `index.ts:289-292` (`:291` baseline `guard`); `runtime.ts:365` default `observe` |
| 0.2.1 | yes | yes (debug only) | yes (`guard`) | yes: `runtime.ts:367`, `:378`, `:571` | no | `cdn/config.ts:101-102`; meta anywhere (`cdn/config.ts:15`) | `index.ts:289-292` (`:291` baseline `guard`); `runtime.ts:365` default `observe` |
| 0.2.2 | yes | yes: `isLocalHost` (`telemetry/config.ts:26-38`) | no (fixed: baseline `observe`, `index.ts:303`) | yes: `runtime.ts:370`, `:381`, `:574` | no (`sampleBucket` returns at `:574` before the `genclass:bucket` write at `:591`) | `cdn/config.ts:103-104` sets `debug` from `data-debug` / `<meta ... content="debug">`, which then feeds the bypass; meta only inside `<head>` (`cdn/config.ts:15`, `:175-176`); script `dataset` at `cdn/global.ts:92` | `index.ts:299-310`: `options.debug \|\| devHost \|\| rank(ks) <= rank(base)` (`:310`), `devHost = isLocalHost(...)` (`:306`); npm tarball: `dist/chunk-7ODWDTWV.js`, `dist/genclass.global.js` and `dist/genclass.global.min.js` carry the `debug \|\|` raise and the `=== "1" && this.debug` branch |
| 0.3.0-beta.0 | yes | yes (`isLocalHost`) | no | yes: `runtime.ts:468`, `:481`, `:721` | no | `cdn/config.ts:112-113`; meta in `<head>` only | `index.ts:334-345` (`:345`), `isLocalHost` at `:341` |
| 0.3.0-beta.1 | yes | yes (`isLocalHost`) | no | yes: `runtime.ts:471`, `:484`, `:724` | no | `cdn/config.ts:113-114`; meta in `<head>` only | `index.ts:337-348` (`:348`), `isLocalHost` at `:344` |
| 0.3.0-beta.2 | no | no (`devHost`, `devhost.ts:24-25`: http(s) on a loopback name with an explicit port, or `*.test`) | no | no: `runtime.ts:474`, `:487`, `:728-729` (no `=1` branch) | no | `cdn/config.ts:115-116` still parses `debug`, now logging only (`cdn/config.ts:27-29`) | `index.ts:15` imports `devHost`, `:345` `dev = devHost(...)`, `:349` `(dev \|\| rank(ks) <= rank(base))`; `test/mode-switch.test.ts`; npm tarball: `dist/chunk-NO4UMDVS.js`, `dist/genclass.global.js` and `dist/genclass.global.min.js` carry the `\.localhost$` predicate and no `debug \|\|` raise |
| 0.3.0-beta.3 | no | no | no | no | no | as beta.2 | `index.ts:345`, `:349`; `runtime.ts:474`, `:729` (identical lines) |
| 0.3.0-beta.4 | no | no | no | no | no | as beta.2 | `index.ts:345`, `:349`; `runtime.ts:474`, `:729` (identical lines) |

Notes on the table:

- `?genclass=observe` and `?genclass=off` lower in every version listed; `off` installs nothing and is checked before
  any other switch (`index.ts` `initUnsafe`, first statement after `killSwitch`), so a `debug` bypass cannot undo it.
- Script-tag build: `data-debug` on the tag and `debug` in `<meta name="genclass">` go through the same parser
  (`cdn/config.ts` `parsePairs` and the `case "debug"` above) into `GenClass.init()`'s options, so they enable the
  bypass exactly like `debug: true` in code. Before 0.2.2 the meta tag was read anywhere in the document, so markup
  injected into the body could set `debug` (and the mode itself, which is the larger issue the 0.2.2 entry fixed);
  from 0.2.2 only tags inside `<head>` count.
- The `?genclass-mode` / `-aggr` / `-sample` switches never raised anything without `debug` in any version
  (`runtime.ts`, the rank and level comparisons), and `?genclass-sample=0` always lowered.

## Severity

`CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:L`, base score 5.4 (Medium).

| metric | value | why |
|---|---|---|
| Attack Vector | Network (N) | the attacker sends a link; the victim's browser does the rest over the web |
| Attack Complexity | Low (L) | once the vulnerable configuration exists (`debug: true` in production, or an app served from a host `isLocalHost` accepts, or no `mode` on 0.1.0-beta.2 to 0.2.1), one URL works every time, no race or guesswork. Base metrics are scored for the vulnerable configuration; if the owner prefers to count the configuration itself as a condition beyond the attacker's control, AC:H gives `CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:L/A:L`, 4.2 (Medium) |
| Privileges Required | None (N) | no account on the site or on genclass.dev is involved |
| User Interaction | Required (R) | the victim must open the crafted link (or paste it); nothing happens otherwise |
| Scope | Unchanged (U) | the effect stays inside the page that loaded the library, for that visitor; no other origin, server or user is touched |
| Confidentiality | None (N) | nothing new is read or sent; telemetry is the same redacted diagnostics it sends in every mode, and the attacker does not receive it |
| Integrity | Low (L) | the page's behaviour can change (a request coalesced, answered from cache, retried, a store write discarded or rolled back), but only to actions the local model picks from a fixed, bounded, mostly reversible list; the attacker controls none of the content, and request bodies, headers, cookies and protected endpoints are never touched |
| Availability | Low (L) | a request can be held (at most the hold budget), delayed (at most 8 s) or answered 503 locally (`block`), for that visitor's page load only; the breaker and `?genclass=off` end it |

Conservative reading: this is a per-visitor, per-page-load downgrade of a safety setting, with no data exposure and no
cross-user effect. The versions with no condition at all (0.1.0-alpha.0 to 0.1.0-beta.0) are unsupported and were on
npm for days; the same vector applies to them with the same impact.

## Workarounds

For an affected version that cannot be upgraded yet (the stable line until `0.2.3` is out):

1. **Do not set `debug: true` in production**, from any source: `GenClass.init({ debug: true })`,
   `window.GENCLASS_CONFIG.debug`, the options file `npx @genclass/runtime init` writes, `<meta name="genclass"
   content="debug">` or `data-debug` on the script tag. With `debug` off, 0.2.2, 0.3.0-beta.0 and 0.3.0-beta.1 on a
   public host (one `isLocalHost` rejects) cannot be raised by any switch. To check a deployed page: with `debug` on,
   every decision is logged to the console as `[GenClass] decision ...`.
2. **Set `mode` explicitly** (`mode: "observe"` unless you opted into guard). On 0.1.0-beta.2 to 0.2.1 this closes the
   `guard` raise for apps that set no mode (the baseline becomes the mode you set); on every version it keeps the
   configuration visible in one place. It does not help against `debug` or the look-alike-host bypass.
3. **Apps served from a host that only looks local** (Capacitor, Tauri, Electron, intranet names, private addresses,
   `*.internal`, `*.local`) on 0.2.2 to 0.3.0-beta.1: the only configuration-side mitigation short of upgrading is to
   pin the mode again right after start, `GenClass.init(opts).setMode("observe")` (or `GenClass.runtime.setMode(...)`
   after the auto import), and to make sure deep links or intranet links cannot carry a query string into the page's
   URL. Upgrading is the real fix for these apps.
4. **A server-side or edge redirect that strips `genclass` query parameters** helps for the link vector on a site
   served by a server or CDN you control: redirect requests whose query holds `genclass=guard`, `genclass=heal`,
   `genclass-mode`, `genclass-aggr` or `genclass-sample` to the same URL without them, before the HTML is served (a
   303 to the cleaned URL). Keep `genclass=off` and `genclass=observe` working: they are the documented visitor-side
   opt-out and lowering switch. Limits: it does nothing for `localStorage.genclass` (which needs same-origin script
   access anyway), for apps served from the device (Capacitor, Tauri, Electron: there is no server in front), or for
   pages whose query string the server never sees (a static host without a rules engine); and the runtime reads
   `location.search` at start, so the parameter must be gone before the page's scripts run, not removed by the app's
   router afterwards.
5. **`?genclass=off` still lowers in every version**: a visitor (or your support team) who sees GenClass acting can
   append `?genclass=off` and nothing is installed for that page load; `?genclass=observe` keeps the reporting without
   actions (on affected versions with `debug` on, prefer `off`, since `?genclass-mode=` could undo `observe`).
6. **Limit what a raised mode could touch**: keep payment, checkout and sign-in endpoints under `requests.protect`
   (`protectPreset("payments", "auth")`), deny actions you never want with `policy.deny`, and leave `visual.fix` off.
   These are the production recommendations in SECURITY.md and INTERCEPTION.md and they apply in every mode.

## Credits

Found by the GenClass maintainers while testing `0.3.0-beta.0` in a pilot app on 2026-10-17. No external reporter.

## Timeline

| date | event |
|---|---|
| 2026-10-08 | `0.1.0-alpha.0` published; the URL switch sets the mode on every host with no condition |
| 2026-10-08 | `0.1.0-beta.1`: the switch becomes lower-only with a `debug` bypass; `?genclass-mode`, `?genclass-aggr` and `?genclass-sample` arrive with the same bypass |
| 2026-10-08 to 2026-10-11 | `0.1.0-beta.2` to `0.2.1`: the runtime's default mode returns to `observe` while the switch keeps a `guard` baseline, so `?genclass=guard` raises an app that set no `mode` |
| 2026-10-13 (tag), 2026-10-15 (npm) | `0.2.2`: the baseline is fixed (CHANGELOG "Security: a link or an injected `<meta>` tag can no longer raise GenClass's mode"); the `debug` bypass stays and the broad `isLocalHost` exception is added |
| 2026-10-15 | `0.3.0-beta.0` published with the same code |
| 2026-10-17 | found by the maintainers testing `0.3.0-beta.0` in a pilot app |
| 2026-10-20 | fix written: `12f4a5c` ("Stop debug and look-alike local hosts from letting a link raise the mode", 00:10 -0400) with `test/mode-switch.test.ts`; look-alike cases pinned in `544085c`; PR #64 opened the same day (public, with the issue described in its CHANGELOG entry) |
| 2026-10-22 (tag), 2026-10-24 (npm) | `0.3.0-beta.1` released without the fix |
| 2026-10-24 | the fix's code and tests ported onto `main` (`5a6b48f`, merge `c2379a7`) |
| 2026-10-25 | `0.3.0-beta.2` tagged and published with the fix (npm dist-tag `beta`) |
| 2026-10-26, 2026-10-27 | `0.3.0-beta.3`, `0.3.0-beta.4` carry it |
| pending | `0.2.3` on npm's `latest`; this advisory; docs on `main` updated (see the notes below) |

## References

- Fix: commit `12f4a5c` (PR #64, https://github.com/genclass-dev/GenClass-lib/pull/64), tests `544085c`; on `main`
  as `5a6b48f` (merge `c2379a7`); released in `v0.3.0-beta.2`.
- `packages/runtime/src/devhost.ts` (the development-host predicate and why it is narrow),
  `packages/runtime/test/mode-switch.test.ts` (every case above).
- `packages/runtime/INTERCEPTION.md` ("What each mode may change", "What it never does", "Actions: preconditions and
  reversibility"), `docs/runtime/THREAT-MODEL.md` T8, `SECURITY.md` ("Recommended for production").
- `packages/runtime/CHANGELOG.md`, the `0.2.2` security entry (the earlier, partial fix).

## Notes for the owner before publishing (not part of the advisory text)

- The 0.3.0-beta.2 CHANGELOG section does not carry a Security entry for this fix: the port to `main` (`5a6b48f`)
  took the code and tests only. The entry exists on PR #64's branch under "## Unreleased" (it already says "0.2.3
  carries the same fix"). Move it under `## 0.3.0-beta.2` (and `## 0.2.3` when that ships) in the same change that
  publishes this advisory.
- The docs on `main` still describe the old behaviour: `docs/runtime/THREAT-MODEL.md` T8 ("unless the app sets
  `debug: true`", "development host (`localhost`, `*.local`, `*.test`, private networks)"), `docs/runtime/CONTRACT.md`
  line 540 (`?genclass=guard` "only with `debug: true` or on a development host since 0.2.2"), `docs/runtime/OPTIONS-SPEC.md`
  §3 (URL overrides "with `debug:true` they may also raise"), `packages/runtime/README.md` lines 688-692, 1058 and 1132
  (the `?genclass-sample=1` with `debug: true` QA recipe) and `packages/runtime/INTERCEPTION.md` ("raises only with
  `debug: true` or on a development host"). PR #64 holds the updated wording (CONTRACT §2 and §13 are binding and need
  your OK).
- PR #64 is still open; the advisory can cite the commits on `main` instead if it is closed without merging.
- `0.2.3` is not tagged or published yet. The form's "patched versions" for the `<= 0.2.2` range depends on it; the
  release goes through `.github/workflows/release.yml` on a `v0.2.3` tag whose version equals
  `packages/runtime/package.json` on that branch.
- The CVSS Attack Complexity choice (L, 5.4, or H, 4.2) is yours; the table above explains both.
