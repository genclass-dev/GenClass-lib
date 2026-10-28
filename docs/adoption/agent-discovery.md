# Getting coding agents to recommend and use GenClass

Research, 2026-10-27. This combines eight parallel research sweeps (training data, web search, docs indexes,
catalogs, pickup once installed, case studies, scaffolders and CI, plus a measured baseline of 121 headless Claude
Code runs). It then folds in an adversarial check of every claim the plan leans on, plus a completeness critique.
Nothing was submitted, posted or published. The raw data and drafts are in the session scratchpad (paths at the
end).

## The short version

1. **No model knows GenClass, and none will for about a year.** The repo was created on 2026-10-07 and the domain
   on 2026-10-09. Every current Claude model has a June 2026 training cutoff and is committed to stay available
   until at least September 2027 (GPT-5.5's cutoff is December 2025). Measured with no tools: **0 of 55** answers to
   non-brand prompts named GenClass (Opus 27, Sonnet 14, Haiku 14). Until about 2027, every recommendation has to
   come from what the agent reads during the task: installed context, a catalog it consults, or a web search.
2. **Agents barely search on symptom questions.** With WebSearch allowed, Opus searched on only **4 of 28**
   non-brand prompts, and never on a symptom, hardening or visual prompt. So web content cannot change the answer to
   "my search box sometimes shows an older query" today. Agents search only for ecosystem questions. For "Is
   there an MCP server that helps a coding agent find frontend race conditions?" Claude did name GenClass in 2 of
   2 runs. Both times it found it through merged PR #68, and repeated that PR's outdated caveats: not published,
   8 tools. "What is GenClass?" returned a different project (itsoulos/GenClass, a C++ classifier) in 2 of 2 runs.
3. **Once installed, Claude reaches for it, then hits a dead end.** With `@genclass/mcp` connected, Claude called
   a GenClass tool in **9 of 9** symptom runs, `genclass_status` first. That is an upper bound: tools were loaded
   upfront, GenClass was the only MCP server, the prompts used the trigger words, and there were only 2 control
   prompts. **Every run then stopped at "no page connected".** The limit on real use is wiring `connectAgent`, not
   discovery.
4. **The one catalog Claude consults to suggest installs does not have GenClass, and the repo is too big to
   submit.** Claude's own plugin suggestions (SearchPlugins, SuggestPluginInstall, claude.ai Discover,
   `/plugin directory`) come from the Anthropic directory. Anthropic's docs say a listing in the open MCP Registry
   "doesn't surface your server in Claude". The portal refuses repositories whose archive is over 50 MiB.
   GenClass-lib measures **51.1 MiB** (tar.gz) and 52.6 MiB (zip).
5. **Fix what agents read before amplifying it.** Every index (Context7, DeepWiki, search, training data) copies
   whatever is on the page. Today that includes:
   - `llms.txt` says `@genclass/mcp 0.1.0` and "GitHub issues are not enabled".
   - `/docs/mcp` lists 8 tools.
   - The root README calls the MCP server "unreleased".
   - Bare `npm install @genclass/runtime` lines install 0.2.2, which has no agent link.
   - Three guides and the home page overclaim guard mode (see "Overclaims to fix now").

## Plan, in dependency order

### 0. Owner decisions that unblock most of the rest

- **When 0.3.0 becomes `latest`.** This one step fixes several things:
  - Every bare install line (site, `llms.txt`, the GitHub repo description) currently gets 0.2.2, which has no
    agent link.
  - npm, unpkg and jsDelivr show 0.2.2's README, which never mentions the MCP server or `scan`.
  - Until then, follow AGENTS.md: `@beta` in every copied command.
- **Where the plugin lives**, so the Anthropic directory can validate it. There are two options:
  - **Preferred:** a small dedicated repo (for example `genclass-dev/genclass-plugin`) that `release-mcp.yml`
    generates from `packages/mcp/plugin`, so `manifests.test.ts` stays the single source.
  - **Alternative:** shrink the monorepo below 50 MiB. `docs/evidence` is about 34 MiB of the archive.

  Submit from the claude.ai organization that should own the listing long term. The first organization to submit a
  repo folder holds the listing.
- **A square logo before the first portal save.** The directory icon is set once, on the first save. Cursor,
  Cline and OpenAI also ask for one.
- **Whether to build a remote MCP endpoint** (hosted `genclass_scan`, later production findings over OAuth). It is
  the only way into claude.ai's Suggested Connectors and into v0, Lovable, Bolt and Replit, which accept only
  remote MCP servers. It sends URLs to genclass.dev, so it needs the owner's OK under rule 8 and a threat-model
  update. Do it after step 4.

### 1. Fix the facts and overclaims (repo; land through PR #69, which already does part of this)

- `llms.txt` and `/docs/mcp`:
  - `@genclass/mcp` 0.2.0, with 9 tools including `genclass_scan`.
  - Read the version from `lib/packages/mcp/package.json` in `build.py` instead of hardcoding it.
  - Issues are enabled.
  - Install lines with `@beta`.
- Root README: remove "unreleased", point coding agents at `llms-install.md` and `genclass.dev/llms.txt`, and move
  the version caveats below the first screen.
- GitHub repo description: no bare install line. Org description and website: set both.
- PR #68 (the top search result for the MCP question). The owner adds one undated line: "Published as
  `@genclass/mcp`; current install and tool list: https://genclass.dev/docs/mcp".
- One definition sentence, used word for word on every surface (home page, READMEs, npm, GitHub, `llms.txt`,
  JSON-LD), plus a disambiguation line. Example: "GenClass (genclass.dev) finds race conditions in web apps: stale
  responses, double submits. Not Clojure's gen-class or EMF GenClass."
- Smaller fixes:
  - `RESULTS.md:165` says "guard FIR <= 0.1% (met)", but the balanced row is 0.13%.
  - "23 measured visual checks" is out of date: VISUAL.md section 3 lists 26 kinds.
  - Deprecate or republish the unscoped `genclass-runtime` alias, which installs 0.1.0-beta.3 and ranks #1 for
    "genclass" on npm.
  - Republish `@genclass/runtime-model` metadata ("17M-parameter" against 8.8M; old org URL) at the next model
    release.

**Overclaims to fix now** (checked against RESULTS.md: model 0.2.0, balanced, likely tier, held-out real apps.
Detections: 30% of stale overwrites, 75% of duplicate submits. Guard acts on 7.5% of the cases where acting would
help):

| where | today | replace with |
|---|---|---|
| `guides/race-conditions-react.html:63` | "it versions every field in your store, sees a response about to overwrite newer data, and in guard mode discards it before your app renders it." | It records the stores it can find (React, Redux and Zustand devtools stores, or stores you register) and reports a response that would overwrite newer data. At the default setting it caught 30% of stale overwrites on held-out real apps. In guard mode (opt-in) it can drop that response's write to a store it controls when its gate clears, which at the default profile happens in 7.5% of the cases where acting would help. With plain `useState`, as in this example, it only reports, so keep fixes 1 to 3. |
| `guides/stale-responses-out-of-order.html:48` | "...and, in guard mode, discards it before render." | "...and, in guard mode (opt-in), can drop that write for a store it controls when its gate clears." |
| `guides/prevent-duplicate-submissions.html:54-56` | "...it can coalesce the repeat into the original request in guard mode, so one order is placed." | Keep, and add that at the default profile this is rare. In the compatibility matrix, guard left 249 of 250 latent double-submit and stale-search runs buggy, so treat it as a backstop, not a replacement. |
| home `index.html:17` | "Catch the bugs that never throw. *Then stop them.*" | "Catch the bugs that never throw." (or add "Guard mode can stop some of them, opt-in.") |

Rule 1 also asks for the false-intervention or false-report figure next to every recall number. If a page tells
readers to install 0.3.0-beta, it should name the version and tier it quotes. 0.3.0's observe mode also reports the
"possible" tier, under looser false-detection limits.

### 2. Make installed GenClass easy to reach (repo; measure before and after)

- **The prompt hook costs seconds on every prompt.** `npx -y @genclass/mcp@0.2.0 hook` took 6 to 10 s per prompt
  here (23 s on a loaded machine), and running node on the package directly took 1.8 s. Ship a small node script in
  the plugin (`node "${CLAUDE_PLUGIN_ROOT}/hooks/digest.mjs"`) that calls the bridge with the existing 800 ms
  timeout.
- **Put the trigger words up front.** The server `INSTRUCTIONS` open with how GenClass works. The first symptom
  word ("sometimes") is at character 517. OpenAI tells authors to keep the important part within the first 512
  characters. That is advice, not a documented cut-off.
  - No tool description contains "stale", "old results", "flips back" or "horizontal".
  - In this session, with GenClass connected, keyword tool search found no GenClass tool for:
    - "search results sometimes show old data"
    - "value flips back after save"
    - "horizontal scroll on mobile"

    It did find one for "race condition".
  - Drafted rewrites of the instructions, all nine tool descriptions and the skill description are in
    `proposed/texts.mjs`.
  - Make the empty `genclass_findings` result name the next exact call (`genclass_explore` on the page the user
    named).
  - Check which `packages/mcp/test` assertions pin this text before changing it.
  - Ship only after the eval in step 7 shows a higher trigger rate with no rise in false triggers.
- **Leave context where every agent looks.** `npx @genclass/runtime@beta init` (and the sv, Nuxt and Astro
  integrations) should offer a short factual block with the `genclass:init` markers, removed by `remove`, using
  `@beta` in every command:
  - in `AGENTS.md`, which Codex, Cursor, Copilot, Windsurf/Devin, Cline, Kiro, Warp, OpenCode, Amp and Junie read;
  - or in `.claude/rules/genclass.md` when a `CLAUDE.md` exists, because Claude Code ignores `AGENTS.md` then.

  `genclass_setup` prints the same block. Draft: `proposed/agents-md-block.md`. Remove its imperative "do not call
  the change done" line. This is a public CLI change, so it needs API.md and CHANGELOG updates.

  Supporting evidence: Vercel measured an AGENTS.md docs index at 100%, against 53% to 79% for skills. That was
  first-party and about Next.js API knowledge, not MCP tool calls, so it supports the idea but does not prove it
  transfers.
- **Ship the skill without the plugin.** `genclass-mcp init` should add `.claude/skills/genclass/SKILL.md` or
  `.agents/skills/genclass/SKILL.md`. It also needs a fallback for when the `genclass_*` tools are missing: show the
  one-line MCP install, or run `npx @genclass/runtime@beta scan <url> --json`. In headless runs the skill was never
  invoked, and Claude's tool use came from the server instructions. So treat the skill as secondary.
- **Playwright trap.** Playwright 1.63's `npx playwright init-agents --loop=claude` rewrites `.mcp.json` and drops
  a genclass entry (verified in Playwright's source). Document it, have `genclass_status` warn about it, and prefer
  the plugin install.

### 3. Get into the catalogs agents use (mostly owner accounts and forms)

In order of reach:

1. **Anthropic directory**, as a plugin bundle, after step 0. This is the catalog behind Claude's own install
   suggestions. Expect a reviewer hold ("Runs a pinned npx or uvx package"). Its local MCP runs in Claude Code and
   in Cowork on the user's machine. Chat ignores it, so the skill should say GenClass needs Claude Code on the
   developer's machine.
2. **GitHub MCP Registry** (the VS Code `@mcp` gallery and Copilot): send the drafted email in
   `listings/mcp.md` §2. It added about 309 servers in October 2026, mostly small.
3. **github/awesome-copilot**: a default marketplace in Copilot CLI and VS Code, with 82 external plugins. Submit
   through its issue form; the checks are automated.
4. **Codex**: add a repo marketplace at `.agents/plugins/marketplace.json` and `extensions.com.openai.interface` in
   `plugin.json`. OpenAI's shared ChatGPT/Codex directory takes local MCP servers only from allowlisted partners;
   skills-only plugins are accepted.
5. **Cursor Marketplace**, **skills.sh** (Vercel's find-skills skill searches it; near-empty for race
   conditions), Glama, then awesome-mcp-servers and awesome-claude-code. Later, low cost: Kiro Powers and a Zed
   extension.
6. **Prepare now, inert until official:** the Claude Code CLI hint (`<claude-code-hint v="1" type="plugin" ...>` on
   stderr from `init`, `scan` and `genclass-mcp` when `CLAUDECODE` is set). It shows "Plugin recommendation:
   install it?" only for plugins in an official-tier Anthropic marketplace, which needs a partner contact. It shows
   once per plugin, in interactive sessions only. The `relevance` block in `marketplace.json` reaches only teams
   whose admin allowlists the marketplace.
7. Attach the existing `.mcpb` (and its sha256) to the `mcp-v*` GitHub Releases for Claude Desktop users. The
   directory no longer takes local MCPB.

Drop Gemini-gallery effort to a low priority. On 2026-06-18 Antigravity CLI replaced Gemini CLI for unpaid users
and for individual Google AI subscribers.

### 4. Give agents something to do with no app edit (product; the biggest unlock for actual use)

All 20 installed runs ended at "no page connected".

- When nothing is connected, `genclass_status` and `genclass_findings` should offer `genclass_scan {url}` (which
  already works on any URL) and a **URL-mode explore**. That mode runs the page in headless Chromium with the
  script-tag runtime injected, as `bench/hunt` and `@genclass/playwright` do, limited to the dev origin, with
  telemetry off.
- Publish `@genclass/playwright` (with `sv`, `nuxt` and `astro`, all 404 on npm today). This needs new release
  workflows (owner's OK under rule 9) and an owner first publish for each package.
- Playwright's test agents run a seed test and copy its imports. An `npx @genclass/playwright init` that points
  `tests/seed.spec.ts` at the GenClass fixture means every test an agent generates carries GenClass.
- Option: a Playwright MCP `--init-script` that puts the runtime on pages the agent opens. Playwright MCP is the
  default browser in Copilot's cloud agent. CONTRACT §16 scopes the agent link to an explicit dev-only
  `connectAgent`, so this needs:
  - dev-origin only;
  - never `anyHost`;
  - `hold: false` outside explore and replay;
  - a THREAT-MODEL T10 update;
  - the owner's OK.
- Later: a `genclass-dev/genclass-action` that posts `genclass-report.md` as one PR comment with a neutral check
  run, so Copilot, Claude Code auto-fix and CodeRabbit see findings on PRs. Document the claude-code-action recipe
  (`plugin_marketplaces` + `plugins: genclass@genclass`); it works today.

### 5. Indexes and search (owner, minutes each)

- Bing Webmaster Tools and Google Search Console: verify, submit `sitemap.xml`, request reindexing. Bing still
  shows an old title on the http URL. Copilot and ChatGPT search lean on Bing.
- Ping IndexNow on deploy (the key file is already published). Redirect http to https.
- Context7 (417,801 installs as a Claude plugin): add the repo with a scoped `context7.json` that excludes
  `docs/adoption`, `research`, `training` and `realapps` (draft: `drafts/context7.json`). DeepWiki: commit
  `.devin/wiki.json` (draft) and submit. Software Heritage: "Save code now".
- Markdown twins (medium priority): `/<page>.md` and the same content for `Accept: text/markdown`. Claude Code
  sends `Accept: text/markdown, text/html, */*` (verified). In Evil Martians' two-month log study, 76% of Claude
  Code's 23,300 requests asked for Markdown. Twins save agents tokens; they do not make GenClass easier to find.
- `llms.txt`: fix it once (step 1) and add a "when a coding agent should suggest GenClass" block (draft in
  `drafts/llms-txt-changes.txt`), but do not count it as a channel. Prosopo saw 3 `llms.txt` fetches against 511
  `robots.txt` fetches. In the baseline, agents read the npm page, the raw README and PR #68.

Crawling already works: every AI crawler user agent tried got the same 200 page as a browser, and nothing is
blocked. Whether to add `Content-Signal: ai-train=yes` is a content-licensing decision for the owner, with no
measured upside.

### 6. Content and earned mentions (slow, durable)

Write for the slots that are empty and the questions agents do search.

- A fair **comparison page** of race-testing tools (fast-check, Playwright, Chrome DevTools MCP, Playwright MCP,
  GenClass) that states GenClass's limits. No such page exists, and Chrome DevTools MCP owns the "agent sees
  runtime" answer (named first in 6 of 6).
- **"How to reproduce a frontend race condition"**: a plain Playwright recipe (hold `page.route`, release responses
  in a chosen order), then "try every order automatically" with explore and replay. For 6 of 37 queries, the
  searches found no product or recipe at all.
- **Symptom-first guides** in the agents' own frame: the standard fix first (AbortController or ignore flag,
  idempotency key, version check), then a test, then GenClass as the automated check. Agents already recommend
  Playwright (55% of race answers) and network throttling (51%). Also four framework pages where results are thin
  (Vue `watch`, Svelte 5 `$effect`, Angular `switchMap`, Next.js server actions), and per-check visual pages.
- **Race hunts upstream.** These are the strongest earned mentions; research ties AI-search visibility to earned
  media (Chen et al. 2025). Rules:
  - The owner sends them, one at a time, reproduced by hand, with one disclosure line.
  - Gitea, Vikunja and Mealie require AI disclosure. Vikunja's CONTRIBUTING.md has a line aimed at automated agents
    that reads as a detector; the researchers treated it as data.
  - The unsent drafts about other projects' bugs are already public in `docs/adoption/hunts`. Consider moving them
    out of the public tree before maintainers are told.
- **After the hunts land:** one measured write-up (genclass.dev plus dev.to), one Show HN for the MCP server, link
  submissions to two or three newsletters, and the demo video on YouTube with checked captions.
- **No quotas** for Stack Overflow or Reddit answers, no mass skill-registry submissions, and no quick second Show
  HN.
- Training data pays off only for models with cutoffs after about November 2026, released around 2027. The same
  pages serve live search before then.

### 7. Measure it (repo, about $3 per run)

- Run the share-of-voice eval monthly. The draft is `baseline/eval-sketch.mjs` with `baseline/prompts.json`. Fix
  its working directory first: the brand leaked into every baseline run through the path, which could only inflate
  mentions. The non-brand zeros stand.
- The installed arm should use Claude Code's default tools (ToolSearch on), several other MCP servers, at least 20
  held-out symptom phrasings and at least 10 controls. Report the trigger rate next to the false-trigger rate, as
  GenClass reports FIR next to recall. Use `claude plugin eval` (MCP mocks, `tool_used` graders, no-plugin
  baseline) for the plugin.
- Add Codex, Gemini CLI and cursor-agent once they are signed in:
  - codex's API key was rejected;
  - gemini needs `GOOGLE_CLOUD_PROJECT`;
  - cursor-agent is not logged in.
- Count agent reads on genclass.dev by user-agent family (aggregate only, with a line in `privacy.html`).
- Skip paid AI-visibility trackers. They track consumer answer engines, not coding agents with tools or MCP.

## Measured baseline (Claude Code 2.1.311, 2026-10-27)

| condition | runs | GenClass named or used |
|---|---|---|
| A: no tools, non-brand prompts | 55 (Opus 27, Sonnet 14, Haiku 14) | 0 |
| B: WebSearch and WebFetch only, non-brand | 28 (Opus) | 2 (both the MCP-server question, via PR #68); searched in 4 of 28 |
| B: "What is GenClass?" | 2 | wrong project both times (itsoulos/GenClass) |
| B: "install @genclass/runtime in Vite React" | 2 | correct both times (`@beta`, `init`) |
| C: @genclass/mcp connected, symptom prompts | 9 connected (1 server failed to start) | 9 called a GenClass tool, `genclass_status` first; all stopped at "no page connected" |
| C2: C plus the plugin | 10 | 10 (the skill never loaded headless; the hook added nothing) |
| controls with GenClass installed | 2 | 0 (95% upper bound about 84%: too few) |

Agents' default answers today:
- **Race prompts:** Playwright (55%), TanStack Query or SWR, AbortController, throttling (51%), debounce (41%), the
  ignore-flag pattern, `page.route` delays (34%), idempotency keys, Sentry.
- **Visual prompts:** Lighthouse, Playwright, axe.
- **Hardening a new React app:** Sentry and session replay.

## What verification corrected

- Claude Code's `/plugin` Discover tab lists your added marketplaces (claude-plugins-official by default), not the
  Anthropic directory. You browse the directory with `/plugin directory` or on claude.ai, and installs reach Claude
  Code through account sync.
- `anthropics/claude-plugins-community` claims a nightly sync, but its last third-party additions were on
  2026-08-07. Directory approvals from September and October are missing.
- "Partner plugins need no verification" has no source. Every directory plugin is reviewed. On Team and Enterprise
  plans, only Owners (or Enterprise members with the Directory permission) can submit.
- The CLI hint works for every official-tier marketplace name (14), not only claude-plugins-official. It does not
  work for claude-community.
- "Replit always uses Neon" is not a Neon quote, and it is false for new dev databases since 2025-12-04.
- Gitea's patched build had 0 false reports in 72 *seeded* loads, not "reordered" loads (RESULTS.md §19).
- The "23 to 26 s hook" figure came from a heavily loaded machine. 6 to 10 s here still justifies the fix.
- The repo has 0 open issues; the "10 open issues" figure counted open PRs.
- The sweep never checked open PRs. **PR #69** (answer-first READMEs, trimmed npm page, `llms.txt`, factual fixes)
  already covers part of step 1. **PR #87** has launch drafts, and **PR #90** adds a Directus hunt.

## Sources

Anthropic directory and plugins:
- claude.com/docs/connectors/building/directory-vs-custom
- claude.com/docs/directory/publish
- claude.com/docs/plugins/pre-submission-checklist (50 MiB)
- claude.com/docs/plugins/platform-support
- code.claude.com/docs/en/plugins/cli-hints
- code.claude.com/docs/en/plugins/relevance

Agent behaviour and context files:
- Vercel, "AGENTS.md outperforms skills in our agent evals" (2026-01-27)
- nextjs.org/evals (as of 2026-03-17)
- Amplifying, "What Claude Code Actually Chooses" (Feb 2026) and "What Fable Actually Chooses" (Jul 2026)
- Evil Martians, "Which AI actually reads your site?" (2026-07-21)
- Prosopo (2026-10-05)
- Checkly (2026-02-19)

Search and training data:
- Aggarwal et al., GEO, KDD 2024
- Puerto et al., C-SEO Bench, NeurIPS 2025
- Chen et al., arXiv 2509.08919
- Ahrefs (2025-05-26), 0.664 correlation
- Kandpal et al., ICML 2023

Benchmarks:
- Replay, Web Debug Bench (2026-04-07; first-party)

Other platforms:
- Playwright 1.63 source (`init-agents`, healer prompt)
- developers.openai.com plugins docs
- github/awesome-copilot `plugins/external.json`
- github.com/mcp totals (Wayback, Oct 1: 339, Oct 27: 648)

## Raw data and drafts

All under the session scratchpad
`/private/tmp/claude-501/-Users-karanvirkhanna-GenClass-lib-main/ea338b68-f055-4286-be4d-61b0fc9c42de/scratchpad/agentrec/`.

- `sweep.json`: the eight channels' findings and roughly 110 actions.
- `verify.json`: the verdicts and the critique.
- `geo-searches.md`: 37 search result sets.
- `baseline/`: `prompts.json`, `raw/`, `scored.md`, `table.md`, `eval-sketch.mjs`.
- `proposed/`: `texts.mjs` (instructions, tool and skill rewrites), `agents-md-block.md`, `hook-proposal.md`.
- `drafts/`: `context7.json`, `devin-wiki.json`, `llms-txt-changes.txt`, `worker-markdown-snippet.js`.
