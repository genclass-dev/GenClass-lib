# Changelog

## 0.1.0 (unreleased)

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
