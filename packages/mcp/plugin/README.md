# GenClass plugin

For Claude Code, Codex, Cursor, Gemini CLI and other agents that read plugins or skills. GenClass lets the agent see what happens inside the pages of your web app running on your machine (each click, request
and response, the order the responses were delivered, what each response wrote into the app's state, uncaught
errors), find race conditions by re-running a page with the network answering in different orders, replay one exact
order to prove a fix, and write a Playwright test that fails while the bug is there.

## Install

Claude Code (the server, a prompt hook that brings new findings to each prompt, and the `genclass` skill):

```
/plugin marketplace add genclass-dev/genclass-plugin
/plugin install genclass@genclass
```

Codex (the server and the skill): `codex plugin marketplace add genclass-dev/genclass-plugin`, then
`codex plugin add genclass@genclass`. Gemini CLI (the same): `gemini extensions install https://github.com/genclass-dev/genclass-plugin`.
The skill alone, in any agent the skills CLI knows: `npx skills add genclass-dev/genclass-plugin`; for GitHub Copilot,
`gh skill install genclass-dev/genclass-plugin genclass`.

Then connect your app's development build (two lines; `genclass_setup` prints them for your framework) and load a
page of the dev server. The page side needs `@genclass/runtime` 0.3.0-beta.1 or later. See the
[package README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/mcp/README.md).

## What it installs

| part | file | what it does |
|---|---|---|
| MCP server `genclass` | `.mcp.json` | runs `npx -y @genclass/mcp@0.2.1`: nine tools (`genclass_status`, `genclass_findings`, `genclass_explain`, `genclass_explore`, `genclass_replay`, `genclass_analytics`, `genclass_setup`, `genclass_scan`, `genclass_clear`) and a bridge on 127.0.0.1:47357 that your app's pages connect to |
| `UserPromptSubmit` hook | `hooks/hooks.json` | runs `npx -y @genclass/mcp@0.2.1 hook` before each prompt: up to five findings recorded since the last prompt are added to the prompt as context |
| skill `genclass` | `skills/genclass/SKILL.md` | the procedure once Claude reaches for the tools (the explore arguments and Playwright pairing, how to read a report, what to say when done, what to do when the tools are missing); its description carries the triggers (an intermittent frontend bug; after changing code that fetches, submits, autosaves, polls or debounces; before calling a UI change done), as do the server's instructions. Without the plugin, `npx -y @genclass/mcp@0.2.1 init` writes the same file to `.claude/skills/genclass/SKILL.md` |

The launcher is pinned to the plugin's version, so the plugin runs the exact release it was reviewed with.
`package.json` and `package-lock.json` next to `.mcp.json` record what that launcher resolves to (the version, its
registry tarball and its sha512 integrity), for the directory's checks and for a Claude Code that installs a plugin's
lockfile (`npm ci --ignore-scripts`) when it installs the plugin.
`plugin.json` and `mcp.json` at this folder's root are the same server in the
[Agent Plugins](https://agent-plugins.org) format, for Cursor, Codex and other clients that read it (server and skill,
no hook).

## What the hook sends, and where

Only to this machine. It reads the bridge's token from `~/.genclass/bridge-47357.token` (mode 0600), asks the bridge
at `http://127.0.0.1:47357` for findings newer than its cursor, keeps that cursor in `.genclass/agent/hook-cursor` in
the project, and prints the new findings' ids, kinds, pages and titles for Claude Code to add to the prompt. Page
strings are quoted and labelled as recorded data, not instructions. It sends nothing else anywhere, prints nothing when
no bridge is running or nothing is new, and gives up after 0.8 seconds if the bridge does not answer. The first prompt
of a session only sets the cursor (`genclass_findings` has the backlog).

The server listens on 127.0.0.1 only and accepts pages from this machine (`localhost`, `127.0.0.1`, `*.localhost`)
or origins you list in `GENCLASS_AGENT_ORIGINS`. Nothing leaves your machine, except `genclass_analytics`
`{source: "production"}`, which reads your own GenClass dashboard when you set `GENCLASS_DASHBOARD` to its link, and
`genclass_scan` with `hosted: true`, which sends the URL to the genclass.dev page check (without it, the page loads
in a local headless browser).
Details: [AGENT.md section 6](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/AGENT.md#6-untrusted-input-and-security).

## Privacy

The plugin collects nothing and sends nothing to GenClass or anyone else. Findings stay in `.genclass/agent/` in your
project (gitignored by the server) and in the bridge's memory. The runtime in your app has its own disclosed
diagnostics, which `GenClass.init({ telemetry: false })` turns off ([PRIVACY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md)).

## Turn it off

- Everything: `/plugin disable genclass@genclass` (or `/plugin uninstall genclass@genclass`).
- Only the hook: Claude Code has no switch for one plugin hook; uninstall the plugin and add the server alone
  (`claude mcp add genclass -- npx -y @genclass/mcp@0.2.1`), or set `"disableAllHooks": true` in your settings, which
  turns off every hook.
- In the app: remove the `connectAgent(rt)` line; the page then never talks to the bridge.

## Where this comes from

This folder is `packages/mcp/plugin` in [genclass-dev/GenClass-lib](https://github.com/genclass-dev/GenClass-lib).
The repository [genclass-dev/genclass-plugin](https://github.com/genclass-dev/genclass-plugin) is this folder at a
repository root with the marketplace files, assembled by `node packages/mcp/scripts/plugin-repo.mjs` and re-synced
daily, so issues and pull requests go to GenClass-lib.

## License

Apache-2.0. Source: [packages/mcp](https://github.com/genclass-dev/GenClass-lib/tree/main/packages/mcp).
