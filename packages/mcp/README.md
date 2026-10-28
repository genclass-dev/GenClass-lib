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

Everything stays on your machine. No dependencies. The server is free. For developers who want the loop run for
them, GenClass runs it as a service under Enterprise: the MCP server, collector and dashboard hosted by GenClass or
inside your network ([genclass.dev/enterprise](https://genclass.dev/enterprise)).

## Install

Pick your client. Every block pins this release, so the client starts exactly this version;
`npx -y @genclass/mcp@0.2.1 config <client>` prints the same lines, and `genclass_setup` prints the block for the
client it runs in.

<!-- install:start (generated from src/clients.ts by `npm run sync -w @genclass/mcp`; edit it there) -->

### Claude Code

As a plugin (the server, a prompt hook that brings new findings to each prompt, and the `genclass` skill with the procedure):

```
/plugin marketplace add genclass-dev/genclass-plugin
/plugin install genclass@genclass
```

Or the server alone (`--scope project` writes `.mcp.json` for everyone on the project; `--scope user` for all your projects). `init` also writes the skill to `.claude/skills/genclass/SKILL.md` (`--no-skill` leaves it out):

```bash
claude mcp add --scope project genclass -- npx -y @genclass/mcp@0.2.1
# or: npx -y @genclass/mcp@0.2.1 init --hook   (.mcp.json and the skill, plus the prompt hook in .claude/settings.json)
```

Or just the skill (no server): `npx skills add genclass-dev/genclass-plugin`. (`genclass-dev/genclass-plugin` is this plugin at a repository root, assembled from this package; the marketplace in `genclass-dev/GenClass-lib` lists the same plugin.)

### Claude Desktop

Settings, Developer, Edit Config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "genclass": {
      "command": "npx",
      "args": [
        "-y",
        "@genclass/mcp@0.2.1"
      ]
    }
  }
}
```

### Cursor

[![Add genclass MCP server to Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](https://cursor.com/link/mcp/install?name=genclass&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBnZW5jbGFzcy9tY3BAMC4yLjEiXX0%3D) or `cursor://anysphere.cursor-deeplink/mcp/install?name=genclass&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBnZW5jbGFzcy9tY3BAMC4yLjEiXX0%3D`

Or `.cursor/mcp.json` in the project (`~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "genclass": {
      "command": "npx",
      "args": [
        "-y",
        "@genclass/mcp@0.2.1"
      ]
    }
  }
}
```

### VS Code

[![Install in VS Code](https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20Server&color=0098FF)](https://vscode.dev/redirect/mcp/install?name=genclass&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40genclass%2Fmcp%400.2.1%22%5D%7D) or from a terminal:

```bash
code --add-mcp '{"name":"genclass","command":"npx","args":["-y","@genclass/mcp@0.2.1"]}'
```

Or `.mcp.json` at the workspace root (the portable format; `.vscode/mcp.json` takes the same entry under `servers`):

```json
{
  "mcpServers": {
    "genclass": {
      "command": "npx",
      "args": [
        "-y",
        "@genclass/mcp@0.2.1"
      ]
    }
  }
}
```

### Codex CLI

As a plugin (the server and the `genclass` skill):

```bash
codex plugin marketplace add genclass-dev/genclass-plugin
codex plugin add genclass@genclass
```

Or the server alone:

```bash
codex mcp add genclass -- npx -y @genclass/mcp@0.2.1
```

Or `~/.codex/config.toml` (`.codex/config.toml` in a trusted project). The first start downloads the package, so allow more than the default 10 seconds:

```toml
[mcp_servers.genclass]
command = "npx"
args = ["-y", "@genclass/mcp@0.2.1"]
startup_timeout_sec = 30
```

### Gemini CLI

As an extension (the server and the `genclass` skill):

```bash
gemini extensions install https://github.com/genclass-dev/genclass-plugin
```

Or the server alone:

```bash
gemini mcp add genclass npx -- -y @genclass/mcp@0.2.1   # -s user: for all projects
```

Or `.gemini/settings.json` in the project (`~/.gemini/settings.json` for all projects):

```json
{
  "mcpServers": {
    "genclass": {
      "command": "npx",
      "args": [
        "-y",
        "@genclass/mcp@0.2.1"
      ]
    }
  }
}
```

### Windsurf (Devin Desktop)

`~/.codeium/windsurf/mcp_config.json` (Windsurf), `~/.config/devin/mcp_config.json` (Devin Desktop's Cascade agent; `%APPDATA%\devin\mcp_config.json` on Windows):

```json
{
  "mcpServers": {
    "genclass": {
      "command": "npx",
      "args": [
        "-y",
        "@genclass/mcp@0.2.1"
      ]
    }
  }
}
```

Devin CLI and Devin Desktop's Devin Local agent:

```bash
devin mcp add -s user genclass -- npx -y @genclass/mcp@0.2.1
```

### Cline

```bash
cline mcp add genclass --yes -- npx -y @genclass/mcp@0.2.1
```

Or MCP Servers, Configure, Configure MCP Servers (`~/.cline/data/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "genclass": {
      "command": "npx",
      "args": [
        "-y",
        "@genclass/mcp@0.2.1"
      ]
    }
  }
}
```

### Goose

`goose://extension?cmd=npx&arg=-y&arg=%40genclass%2Fmcp%400.2.1&id=genclass&name=genclass&description=Find%20race%20conditions%20by%20reordering%20responses%2C%20replay%20one%2C%20prove%20the%20fix` (open it to install), or `goose configure` (Add Extension, Command-line Extension, command `npx -y @genclass/mcp@0.2.1`), or `~/.config/goose/config.yaml`:

```yaml
extensions:
  genclass:
    type: stdio
    name: genclass
    enabled: true
    cmd: npx
    args: ["-y", "@genclass/mcp@0.2.1"]
    env_keys: []
    envs: {}
    timeout: 300
```

### Zed

`~/.config/zed/settings.json` (`.zed/settings.json` in the project), or Settings, AI, MCP Servers, Add Server:

```json
{
  "context_servers": {
    "genclass": {
      "command": "npx",
      "args": [
        "-y",
        "@genclass/mcp@0.2.1"
      ]
    }
  }
}
```

### JetBrains IDEs

AI Assistant: Settings, Tools, AI Assistant, Model Context Protocol (MCP), Add, then this JSON. Junie: `.junie/mcp/mcp.json` in the project (`~/.junie/mcp/mcp.json` for all projects), same JSON:

```json
{
  "mcpServers": {
    "genclass": {
      "command": "npx",
      "args": [
        "-y",
        "@genclass/mcp@0.2.1"
      ]
    }
  }
}
```

### OpenCode

`opencode.json` in the project (`~/.config/opencode/opencode.json` for all projects), or `opencode mcp add`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "genclass": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@genclass/mcp@0.2.1"
      ],
      "enabled": true
    }
  }
}
```

<!-- install:end -->

Any other MCP client: a stdio server, command `npx`, arguments `-y @genclass/mcp@0.2.1`, no environment variables
required.

### The `genclass` skill

The server's instructions (sent when it connects) tell the agent when to reach for GenClass: the symptom words
("sometimes", "randomly", "only in production", "on slow connections", a value that "flips back", stale or old
results, lost edits, double submits, sideways scrolling), the code changes that call for an explore, the scan before a
UI change is done, and the first call for each. The procedure (the explore arguments, the Playwright pairing, how to
read a report, what to say when done, what to do when the tools are missing) is the `genclass` skill,
[`plugin/skills/genclass/SKILL.md`](plugin/skills/genclass/SKILL.md). Three ways to get it:

- the plugin installs it with the server and the hook;
- `npx -y @genclass/mcp@0.2.1 init` writes it to `.claude/skills/genclass/SKILL.md` in the project (`--no-skill`
  leaves it out). The written file carries a `genclass:init` marker line: a rerun replaces a file with the marker and
  leaves one without it (yours, or edited), and says which;
- `npx skills add genclass-dev/genclass-plugin` (the skills CLI: Codex, Cursor, Copilot, Gemini CLI, Claude Code and
  others) or `gh skill install genclass-dev/genclass-plugin genclass` (GitHub CLI 2.90 or later, for Copilot) installs
  the skill alone, with no server (the skill then says how to add one). `npx skills add genclass-dev/GenClass-lib`
  installs the same file from this repository's root copy, `skills/genclass/SKILL.md`.

To remove it: delete `.claude/skills/genclass/` (or the directory the skill tool wrote to); with the plugin,
`/plugin uninstall genclass@genclass`.

Then connect the app's development build (once). The agent link needs the newest runtime line, `@genclass/runtime`
0.3.0-beta.1 or later: `npm install @genclass/runtime@beta` (a bare `npm install @genclass/runtime` gets npm's
`latest`, the older 0.2.x, which has no agent entry):

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
| `genclass_setup` | the lines to add for your framework, and the config lines for the client it runs in |
| `genclass_scan` | `{url, phone?, hosted?}`: audit any page (the dev server or a site you do not own) with the 23 measured visual checks in headless Chromium: a score and each problem with its element, selector and a suggested CSS fix, plus the JSON report. Runs `npx @genclass/runtime@beta scan --json --local` (or the project's own runtime); needs Playwright's Chromium (`npx playwright install chromium`), or `hosted: true` for the genclass.dev page check (public pages only) |
| `genclass_clear` | forget recorded runs and findings |

## New findings without asking

- **Channels** (Claude Code research preview): start Claude Code with
  `claude --dangerously-load-development-channels server:genclass` and new findings arrive in the session as they
  happen (`notifications/claude/channel`).
- **Prompt hook** (part of the Claude Code plugin): `npx -y @genclass/mcp@0.2.1 init --hook` adds a `UserPromptSubmit`
  hook to `.claude/settings.json`; each prompt then carries the findings that changed since the last one.

## Environment

| variable | default | |
|---|---|---|
| `GENCLASS_AGENT_PORT` | `47357` | the bridge's port (the page then needs `connectAgent(rt, { url })`) |
| `GENCLASS_STATE_DIR` | `.genclass/agent` | where findings persist between sessions; `none` keeps them in memory |
| `GENCLASS_DASHBOARD` | | your dashboard's private link, for `genclass_analytics` `production` (`sample` reads the public sample) |
| `GENCLASS_REPORT` | | `on` (with `GENCLASS_DASHBOARD`), or a dashboard link or secret: mirror this server's log of the loop to that dashboard's Closed-loop development view (each finding, each time its evidence is read, each replay armed and its verdict, each regression test written, each explore report, each clear), which draws every issue's path (found, reproduced, fix proven, closed, or round again) with counts and lists the log. Ids, kinds, page paths, verdicts, counts and times only, never page text; off unless set ([AGENT.md section 4.5](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/AGENT.md)) |
| `GENCLASS_AGENT_ORIGINS` | | exact page origins allowed besides this machine's, e.g. `http://192.168.1.20:5173` (the page then needs `connectAgent(rt, { anyHost: true })`) |
| `GENCLASS_TOKEN_DIR` | `~/.genclass` | where the bridge keeps its API token (mode 0600) for the hook and other sessions |

## Security

The bridge listens on 127.0.0.1 only and checks the `Host` header. Pages may talk to it only from your machine
(`localhost`, `127.0.0.1`, `*.localhost`) or an origin you list in `GENCLASS_AGENT_ORIGINS` (a `*.test` or LAN dev host): a public
website, a router page or a captive portal you visit cannot plant findings, and a page can only add to its own run.
The agent API refuses browsers and needs a token only your user can read. Everything a page sends is validated,
capped, stripped of invisible characters and shown to the agent as quoted data, never as instructions. Nothing leaves
your machine (the exceptions are under Privacy). See section 6 of
[AGENT.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/AGENT.md).

## Privacy

The server collects nothing and sends nothing to GenClass or anyone else. Findings stay on your machine, in
`.genclass/agent/` in the server's working directory (the project, for clients that start servers there; set
`GENCLASS_STATE_DIR` for clients that do not, such as Claude Desktop), which the server gitignores, and in the bridge's memory; the bridge's token is in
`~/.genclass`. The one request that leaves the machine is `genclass_analytics` `{source: "production"}`, which reads
your own GenClass dashboard when you set `GENCLASS_DASHBOARD` to its private link. `genclass_scan` loads the page the
agent names (that is the page's own traffic) in a local browser; only with `hosted: true` is the URL sent to the
genclass.dev page check, and when the project has no `@genclass/runtime` with `scan`, npx downloads it from npm. With `GENCLASS_REPORT` set (off by
default) the server also mirrors its log of the loop to that dashboard, in small batches: the id, kind and page path of
each finding, when its evidence was read, each replay armed and its verdict, when a regression test was written, each
explore report (page loads compared, races found) and each clear, so the dashboard's Closed-loop development view
draws every issue's path (found, reproduced, fix proven, closed, or round again) and lists what the agent did; never a
title, an evidence line, a snapshot or any page text, and nothing it sends feeds a decision. The runtime in your app has its
own disclosed diagnostics ([PRIVACY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md)), which
`GenClass.init({ telemetry: false })` turns off; the agent link is not part of them.

## License

Apache-2.0
