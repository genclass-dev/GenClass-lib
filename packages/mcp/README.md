# @genclass/mcp

### Your coding agent can see the race, replay it, and prove the fix.

An MCP server for Claude Code and other coding agents. It connects to the pages of your app running on your machine
(through [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime)'s agent link) and gives the agent:

- **What happened, in order.** Every click, request and response, the order the responses were delivered, what each
  response wrote into the app's state, and uncaught errors with the click and request that led to them.
- **Bugs that never throw.** A response that overwrote newer data (the classic stale search result or lost edit), the
  same order submitted twice by two clicks, and the on-device model's own detections.
- **Races found before users find them.** `genclass_explore` runs your steps again with the network answering in
  different orders (and slower, if you like) and reports what ends differently from the run where responses came back
  in order.
- **Proof.** `genclass_replay` delivers the exact order that produced a bug again, before your fix (reproduced) and
  after it (not reproduced), and `genclass_explain` writes a Playwright test that fails while the bug is there.

Everything stays on your machine. No dependencies.

## Install

As a Claude Code plugin (the server, a prompt hook that brings new findings to each prompt, and a skill that tells
Claude when to use it):

```
/plugin marketplace add genclass-dev/GenClass-lib
/plugin install genclass@genclass
```

Or the server alone:

```bash
claude mcp add genclass -- npx -y @genclass/mcp
# or, in the project: npx @genclass/mcp init          (adds it to .mcp.json)
#                     npx @genclass/mcp init --hook   (also a prompt hook that brings new findings to the agent)
```

Then connect the app's development build (once). The agent link needs `@genclass/runtime` 0.3.0-beta.1 or later
(`npm install @genclass/runtime@beta` until 0.3.0 is `latest`):

```ts
import { GenClass } from "@genclass/runtime";
import { connectAgent } from "@genclass/runtime/agent";

const rt = GenClass.init();
if (import.meta.env.DEV) connectAgent(rt); // Next.js: process.env.NODE_ENV === "development"
```

Load a page of the dev server and ask the agent for `genclass_status`. The agent can also ask `genclass_setup`, which
reads your `package.json` and shows the lines for your framework.

## What the agent does with it

```
you:    the search results are sometimes for an older query
agent:  genclass_findings → f1 [stale-write] /search: the response to GET /api/search "?q=reac"
        overwrote "search.results" after a newer GET /api/search had already written it
        genclass_explain f1 → steps, delivery order, a replay, a regression test
        genclass_replay arm f1 → (loads the page, types) → result: REPRODUCED
        (fixes the handler to keep only the latest answer, adds the test)
        genclass_replay arm f1 → result: not reproduced
        genclass_explore start {slow_ms: 600} → 8 runs → report: no race
```

On a real page in headless Chromium (the package's end-to-end check), explore found that race in 5 of 6 reordered runs
of a page that never showed it on the developer's fast backend, the generated test failed on the buggy page and passed
on the fixed one, and explore on the fixed page reported nothing. Details: [docs/runtime/AGENT.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/AGENT.md).

## Tools

| tool | |
|---|---|
| `genclass_status` | connected pages, counts of findings, explore and replay state |
| `genclass_findings` | ranked, deduplicated findings: races, stale writes, errors, duplicate requests, model detections, visual checks |
| `genclass_explain` | one finding in causal order, the recorded steps, the replay, a Playwright regression test |
| `genclass_explore` | `start` / `report` / `stop`: find what depends on response order |
| `genclass_replay` | `arm` / `result`: reproduce one finding exactly |
| `genclass_analytics` | per-endpoint latency, error rates and request counts, learned relations and flows; production numbers from your GenClass dashboard |
| `genclass_setup` | the lines to add for your framework |
| `genclass_clear` | forget recorded runs and findings |

## New findings without asking

- **Channels** (Claude Code research preview): start Claude Code with
  `claude --dangerously-load-development-channels server:genclass` and new findings arrive in the session as they
  happen (`notifications/claude/channel`).
- **Prompt hook**: `npx @genclass/mcp init --hook` adds a `UserPromptSubmit` hook; each prompt then carries the findings
  that changed since the last one.

## Environment

| variable | default | |
|---|---|---|
| `GENCLASS_AGENT_PORT` | `47357` | the bridge's port (the page then needs `connectAgent(rt, { url })`) |
| `GENCLASS_STATE_DIR` | `.genclass/agent` | where findings persist between sessions; `none` keeps them in memory |
| `GENCLASS_DASHBOARD` | | your dashboard's private link, for `genclass_analytics` `production` (`sample` reads the public sample) |
| `GENCLASS_AGENT_ORIGINS` | | exact page origins allowed besides this machine's, e.g. `http://192.168.1.20:5173` (the page then needs `connectAgent(rt, { anyHost: true })`) |
| `GENCLASS_TOKEN_DIR` | `~/.genclass` | where the bridge keeps its API token (mode 0600) for the hook and other sessions |

## Security

The bridge listens on 127.0.0.1 only and checks the `Host` header. Pages may talk to it only from your machine
(`localhost`, `127.0.0.1`, `*.localhost`) or an origin you list in `GENCLASS_AGENT_ORIGINS` (a `*.test` or LAN dev host): a public
website, a router page or a captive portal you visit cannot plant findings, and a page can only add to its own run.
The agent API refuses browsers and needs a token only your user can read. Everything a page sends is validated,
capped, stripped of invisible characters and shown to the agent as quoted data, never as instructions. Nothing leaves
your machine. See section 6 of
[AGENT.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/AGENT.md).

## License

Apache-2.0
