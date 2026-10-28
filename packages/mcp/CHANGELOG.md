# Changelog

## 0.2.1 (2026-10-27)

- **The plugin has an icon** (`plugin/.claude-plugin/icon.png`, the genclass.dev mark, 512 by 512), which the Anthropic directory reads on the first save.
- **The instructions carry the "when", the skill the "how"** ([docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)
  section 4.2). The server's `instructions` now open with the symptom words ("sometimes", "randomly", "only in
  production", "on slow connections", a value that "flips back", stale or old results, lost edits, double submits,
  sideways scrolling), all within the first 500 characters, keep one line per trigger saying what to call first, and
  name the `genclass` skill so a client that has it loads it (2,712 characters, under the 4,096 ceiling). The skill
  (`plugin/skills/genclass/SKILL.md`) no longer restates the triggers in its body: its frontmatter description is the
  trigger, with the same words early, and the body is the procedure (the explore arguments, the Playwright pairing,
  how to read "Compared: 6 of 6" against "No verdict" and "0 compared", that "Internal state only" and "Along the way
  only" are not races, witness against explore race against model detection, the reporting rule) plus a new section
  for when the `genclass_*` tools are missing (the pinned one-line install, or `npx @genclass/runtime@beta scan <url>
  --json` for the visual checks alone; GenClass needs Claude Code or another MCP client on the developer's machine,
  the chat app cannot run it).
- **`init` writes the skill without the plugin.** `genclass-mcp init` now also writes `.claude/skills/genclass/SKILL.md`
  into the project (the package's copy, resolved next to the built command, with a `genclass:init` marker line after
  the frontmatter), so Claude Code loads the procedure on a project set up with `init` or `claude mcp add` alone. A
  rerun replaces a file that carries the marker and leaves one that does not (yours, or edited), and says which;
  `--no-skill` leaves the skill out; a `CLAUDE.md` without a `.claude/` folder still gets it under `.claude/skills/`.
- **A repository-root copy for skill directories.** `skills/genclass/SKILL.md` is a byte-identical copy of the
  plugin's skill, so `npx skills add genclass-dev/GenClass-lib` (skills.sh and directories that read a repository's
  root `skills/` folder) finds it; `npm run sync -w @genclass/mcp` refreshes the copy and pins the install line in
  both.
- Tests: `test/manifests.test.ts` checks the skill's frontmatter (name, a one-line description of at most 1,024
  characters with the symptom words early), that every `genclass_*` name in its body is a tool the server registers,
  that the body has the procedure and the fallback and no em-dash, that the root copy is identical, and that the
  instructions stay under 4,096 characters, put the symptom words in the first 500 and name the skill;
  `test/cli.test.ts` covers the skill written by `init`, the rerun on a marked and an unmarked file, and `--no-skill`.

## 0.2.0 (2026-10-25)

The `0.1.0` on npm (published 2026-10-25) is an earlier build: eight tools, no `genclass_scan`, no `GENCLASS_REPORT`.
Everything below ships first in `0.2.0`.

- **`genclass_setup` installs the newest runtime line.** It prints `npm install @genclass/runtime@beta` (the agent
  entry and interaction analytics need 0.3.0-beta.1 or later) for a project on 0.2.x, on a range without a version
  (`*`, `latest`: npm's `latest` is still 0.2.x) or with an older copy in `node_modules`, and says what the project
  has. The README's connect step names `@beta` first.
- **`genclass_scan {url, phone?, hosted?}`: audit any page in one step** ([docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)
  section 4.2). It runs `@genclass/runtime`'s `scan --json` (the project's own runtime when it has the command, else
  `npx -y @genclass/runtime@beta`) in the project's folder: headless Chromium at desktop and phone sizes with the 23
  measured visual checks, and returns a score and each problem with its element, selector and suggested CSS fix (page
  text cleaned and labelled as data), plus the report as JSON (a second text block and `structuredContent`). It passes
  `--local` unless the agent sets `hosted: true`, so without Playwright's Chromium it says how to install it instead
  of sending the URL anywhere; `hosted: true` uses the genclass.dev page check (public pages only). The server's
  instructions and the plugin skill say to scan a page before calling a UI change done. Nine tools.

- **Fixed: a race replay counts page lines.** Explore compares page text as counts, so a product name the page
  always shows once and a stale result showed a second time was "only in the failing run"; the replay verdict then
  checked presence only, and the card alone made every replay "reproduced", including after the fix. The finding's
  evidence now keeps the counts (`textCounts`) and the verdict needs the line as many times as the failing run showed
  it. Found by the end-to-end walkthrough, covered by a test.
- **Fixed: with `GENCLASS_REPORT` set, the tools' own calls are mirrored too.** The server's in-process API (what
  `genclass_explain`, `genclass_replay`, `genclass_explore` and `genclass_clear` call when this session owns the
  bridge) bypassed the reporting wrapper, so a dashboard only ever received the findings; the evidence read, the test,
  replays armed and their verdicts, explore reports and clears reached it only through the bridge's HTTP path. Found
  by the end-to-end walkthrough (`docs/evidence/e2e-walkthrough`), covered by a test.
- **Opt-in reporting to the app's dashboard** (`GENCLASS_REPORT`; [docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)
  section 4.5). Set to `on` (with `GENCLASS_DASHBOARD`) or to a dashboard link, the server mirrors its log of the loop
  to that dashboard: each finding the bridge makes, each time the agent reads its evidence (`genclass_explain`), each
  replay armed and each replay verdict, each regression test written, each explore report (page loads compared, races
  found) and each clear: `POST /api/projects/<secret>/agent`, batched, best effort, ids, kinds, page paths, verdicts,
  counts and times only, never page text. The dashboard's Closed-loop development view then draws every issue's path
  (found, reproduced, fix proven, closed, or round again when a replay after a fix still reproduces it) with the
  period's counts, lists the log newest first, and shows per production problem what the agent reproduced, tested and
  proved fixed. Off unless set; nothing sent feeds a decision, a finding or a tool result.

- **Explore stops reporting order-dependent bookkeeping as races** ([docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)
  section 5.1, [RESULTS.md](../../docs/runtime/RESULTS.md) section 22). A reordered run is a race only when what the
  page shows, its form values, the requests it sent or its errors differ from the request-order baseline; store values
  that differ while the page is the same are listed as "Internal state only", and an overwrite a later response
  repaired as "Along the way only", neither with a finding. A `[redacted]` value equals any value. Scenarios are
  grouped with digits blanked, parenthesised counts dropped and a typing burst split by a label change joined again,
  falling back to action kinds and element roles, then kinds, when names changed with the order; the report says how
  many reordered runs it compared and says "0 compared" (no verdict) rather than "No race found" when none was. Race
  finding titles, keys, replays and generated tests lead with what the page showed (store values only for a finding
  with nothing else). Snapshots may carry up to 1,200 store fields and say how many the page left out. The explore
  tool's description and the plugin skill say the same. On the Strapi admin's 21 interaction sessions the race-like
  verdicts went from 16 to 0 (reordered runs reported as races: 62, all false, to 0; sessions without a usable verdict:
  5 to 0), and the real 403 race is still found at 300, 600 and 900 ms (6 of 6 runs, 0 false); on a correct Redux
  Toolkit Query page the false reports went from 18 of 18 reordered runs to 0; the e2e page still finds its race in 5
  of 6 reordered runs and none on the fixed page.

- First version: the GenClass MCP server for coding agents ([docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)).
  A bridge on 127.0.0.1:47357 that pages connect to through `@genclass/runtime/agent`; eight tools
  (`genclass_status`, `genclass_findings`, `genclass_explain`, `genclass_explore`, `genclass_replay`,
  `genclass_analytics`, `genclass_setup`, `genclass_clear`); findings deduplicated and kept in
  `.genclass/agent/state.json`; explore verdicts from final states against request-order baselines; replays with
  reproduced / not reproduced verdicts; Playwright regression tests generated from a finding; new findings pushed as
  Claude Code channel events or through a `UserPromptSubmit` hook; one bridge shared by every agent session on the
  machine; production numbers read from the developer's GenClass dashboard. No dependencies. The bridge accepts pages
  only from the developer's machine (or origins listed in `GENCLASS_AGENT_ORIGINS`), binds each run to the page that
  registered it (origin and token), guards its agent API with a per-user token, quotes every page string it shows the
  agent and strips invisible characters. A Claude Code plugin (`plugin/`: the server, the prompt hook and a skill) and
  an MCP Registry entry (`server.json`) ship with it. Needs `@genclass/runtime` 0.3.0-beta.1 or later in the app
  (`@genclass/runtime/agent`). Released by `.github/workflows/release-mcp.yml` from a `mcp-v<version>` tag.
- Ready for registries and directories: a `server.json` description of at most 100 characters (the official MCP
  Registry's limit; checked against its 2025-12-11 schema and accepted by `mcp-publisher validate`), a `title` and
  `websiteUrl`; the release workflow publishes it to the registry with GitHub OIDC (pinned, checksummed
  `mcp-publisher`) after npm, and uploads an MCP Bundle (`npm run bundle`: `genclass-<version>.mcpb`, for Claude
  Desktop and Smithery) as an artifact. Every launcher is pinned to the release (`npx -y @genclass/mcp@<version>`):
  the plugin's server and hook, `init`, and the install blocks; `npm run sync` rewrites the pins from
  `package.json` and the tests fail when one differs. Install blocks for Claude Code, Claude Desktop, Cursor (with an
  install link), VS Code (`code --add-mcp` and an install link), Codex CLI, Gemini CLI, Windsurf, Cline, Goose, Zed,
  JetBrains IDEs and OpenCode, printed by `genclass-mcp config [client]` and in the README; `genclass_setup` adds the
  block for the client it runs in (from `clientInfo` at initialize). Every tool's annotations carry `title`,
  `readOnlyHint`, `destructiveHint` and `openWorldHint`. The plugin has a README (what it installs, what the hook
  sends where, how to turn it off), directory links in `plugin.json`, and an [Agent Plugins](https://agent-plugins.org)
  `plugin.json` and `mcp.json` for Cursor and Codex; the repository root has `glama.json`, `gemini-extension.json`,
  `llms-install.md` and `.cursor-plugin/marketplace.json`. Listing drafts: `docs/adoption/listings/mcp.md`.
