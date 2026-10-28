// How to add this server to each MCP client: the README's install section, `genclass-mcp config`, `init` and
// genclass_setup all print from here, so they say the same thing. Every block pins this package's exact version: a
// client then starts the release the block came from, and directories that refuse unpinned launchers accept it.
// Pure: no I/O, no imports; the version is passed in.

/** The npm package. */
export const PACKAGE = "@genclass/mcp";
/** The server's name in every client's configuration. */
export const NAME = "genclass";

/** `@genclass/mcp@<version>`: what npx runs. */
export function pinned(version: string): string {
  return `${PACKAGE}@${version}`;
}

/** The stdio server entry most clients take (`mcpServers.genclass`). */
export function serverConfig(version: string): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", pinned(version)] };
}

/** The Claude Code `UserPromptSubmit` hook command (plugin and `init --hook`). */
export function hookCommand(version: string): string {
  return `npx -y ${pinned(version)} hook`;
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/** Standard base64 of an ASCII string (the configs here are ASCII). */
function b64(s: string): string {
  return btoa(s);
}

/** Cursor's install deeplink (cursor.com/docs/mcp/install-links): `config` is the base64 of the server entry, without its name. */
export function cursorLink(version: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${NAME}&config=${encodeURIComponent(b64(JSON.stringify(serverConfig(version))))}`;
}

/** The https form of Cursor's link (cursor.com/docs/reference/deeplinks: base URL https://cursor.com/link/), for web pages. */
export function cursorWebLink(version: string): string {
  return `https://cursor.com/link/mcp/install?name=${NAME}&config=${encodeURIComponent(b64(JSON.stringify(serverConfig(version))))}`;
}

/** VS Code's install URL (code.visualstudio.com, MCP configuration): `vscode:mcp/install?` and the URL-encoded entry with its name. */
export function vscodeLink(version: string, insiders = false): string {
  return `${insiders ? "vscode-insiders" : "vscode"}:mcp/install?${encodeURIComponent(JSON.stringify({ name: NAME, ...serverConfig(version) }))}`;
}

/** The https redirect to VS Code's install URL, for web pages (vscode.dev adds `name` to `config` and opens vscode:). */
export function vscodeWebLink(version: string, insiders = false): string {
  return `https://vscode.dev/redirect/mcp/install?name=${NAME}&config=${encodeURIComponent(JSON.stringify(serverConfig(version)))}${insiders ? "&quality=insiders" : ""}`;
}

/** Goose's extension deeplink (goose docs, "goose deeplinks"): `cmd`, one `arg` per argument, all URL-encoded. */
export function gooseLink(version: string): string {
  const c = serverConfig(version);
  const q = [`cmd=${encodeURIComponent(c.command)}`, ...c.args.map((a) => `arg=${encodeURIComponent(a)}`), `id=${NAME}`, `name=${NAME}`, `description=${encodeURIComponent("Find race conditions by reordering responses, replay one, prove the fix")}`];
  return `goose://extension?${q.join("&")}`;
}

export interface ClientInstall {
  /** Short id for `genclass-mcp config <id>`. */
  id: string;
  /** Display name (the README heading). */
  label: string;
  /** Matches the `clientInfo.name` the client sends at initialize. */
  match: RegExp;
  /** The Markdown block (no heading). */
  block(version: string): string;
}

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const mcpServers = (version: string) => json({ mcpServers: { [NAME]: serverConfig(version) } });

export const CLIENTS: ClientInstall[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    match: /^claude-code$/i,
    block: (v) =>
      [
        "As a plugin (the server, a prompt hook that brings new findings to each prompt, and the `genclass` skill with the procedure):",
        fence("", "/plugin marketplace add genclass-dev/GenClass-lib\n/plugin install genclass@genclass"),
        "Or the server alone (`--scope project` writes `.mcp.json` for everyone on the project; `--scope user` for all your projects). `init` also writes the skill to `.claude/skills/genclass/SKILL.md` (`--no-skill` leaves it out):",
        fence("bash", `claude mcp add --scope project ${NAME} -- npx -y ${pinned(v)}\n# or: npx -y ${pinned(v)} init --hook   (.mcp.json and the skill, plus the prompt hook in .claude/settings.json)`),
        "Or just the skill (no server; `skills/genclass/SKILL.md` at the repository root, for skill directories): `npx skills add genclass-dev/GenClass-lib`",
      ].join("\n\n"),
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    match: /^claude-ai$/i,
    block: (v) =>
      [
        "Settings, Developer, Edit Config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\\Claude\\claude_desktop_config.json` on Windows):",
        fence("json", mcpServers(v)),
      ].join("\n\n"),
  },
  {
    id: "cursor",
    label: "Cursor",
    match: /cursor/i,
    block: (v) =>
      [
        `[![Add genclass MCP server to Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](${cursorWebLink(v)}) or \`${cursorLink(v)}\``,
        "Or `.cursor/mcp.json` in the project (`~/.cursor/mcp.json` for all projects):",
        fence("json", mcpServers(v)),
      ].join("\n\n"),
  },
  {
    id: "vscode",
    label: "VS Code",
    match: /visual studio code|^vscode/i,
    block: (v) =>
      [
        `[![Install in VS Code](https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20Server&color=0098FF)](${vscodeWebLink(v)}) or from a terminal:`,
        fence("bash", `code --add-mcp '${JSON.stringify({ name: NAME, ...serverConfig(v) })}'`),
        "Or `.mcp.json` at the workspace root (the portable format; `.vscode/mcp.json` takes the same entry under `servers`):",
        fence("json", mcpServers(v)),
      ].join("\n\n"),
  },
  {
    id: "codex",
    label: "Codex CLI",
    match: /codex/i,
    block: (v) =>
      [
        fence("bash", `codex mcp add ${NAME} -- npx -y ${pinned(v)}`),
        "Or `~/.codex/config.toml` (`.codex/config.toml` in a trusted project). The first start downloads the package, so allow more than the default 10 seconds:",
        fence("toml", `[mcp_servers.${NAME}]\ncommand = "npx"\nargs = ["-y", "${pinned(v)}"]\nstartup_timeout_sec = 30`),
      ].join("\n\n"),
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    match: /gemini/i,
    block: (v) =>
      [
        fence("bash", `gemini mcp add ${NAME} npx -- -y ${pinned(v)}   # -s user: for all projects`),
        "Or `.gemini/settings.json` in the project (`~/.gemini/settings.json` for all projects):",
        fence("json", mcpServers(v)),
      ].join("\n\n"),
  },
  {
    id: "windsurf",
    label: "Windsurf (Devin Desktop)",
    match: /windsurf|devin/i,
    block: (v) =>
      [
        "`~/.codeium/windsurf/mcp_config.json` (Windsurf), `~/.config/devin/mcp_config.json` (Devin Desktop's Cascade agent; `%APPDATA%\\devin\\mcp_config.json` on Windows):",
        fence("json", mcpServers(v)),
        "Devin CLI and Devin Desktop's Devin Local agent:",
        fence("bash", `devin mcp add -s user ${NAME} -- npx -y ${pinned(v)}`),
      ].join("\n\n"),
  },
  {
    id: "cline",
    label: "Cline",
    match: /^(cline|@cline\/)/i,
    block: (v) =>
      [
        fence("bash", `cline mcp add ${NAME} --yes -- npx -y ${pinned(v)}`),
        "Or MCP Servers, Configure, Configure MCP Servers (`~/.cline/data/settings/cline_mcp_settings.json`):",
        fence("json", mcpServers(v)),
      ].join("\n\n"),
  },
  {
    id: "goose",
    label: "Goose",
    match: /goose/i,
    block: (v) =>
      [
        `\`${gooseLink(v)}\` (open it to install), or \`goose configure\` (Add Extension, Command-line Extension, command \`npx -y ${pinned(v)}\`), or \`~/.config/goose/config.yaml\`:`,
        fence("yaml", `extensions:\n  ${NAME}:\n    type: stdio\n    name: ${NAME}\n    enabled: true\n    cmd: npx\n    args: ["-y", "${pinned(v)}"]\n    env_keys: []\n    envs: {}\n    timeout: 300`),
      ].join("\n\n"),
  },
  {
    id: "zed",
    label: "Zed",
    match: /^zed/i,
    block: (v) => ["`~/.config/zed/settings.json` (`.zed/settings.json` in the project), or Settings, AI, MCP Servers, Add Server:", fence("json", json({ context_servers: { [NAME]: serverConfig(v) } }))].join("\n\n"),
  },
  {
    id: "jetbrains",
    label: "JetBrains IDEs",
    match: /jetbrains|intellij|junie/i,
    block: (v) =>
      [
        "AI Assistant: Settings, Tools, AI Assistant, Model Context Protocol (MCP), Add, then this JSON. Junie: `.junie/mcp/mcp.json` in the project (`~/.junie/mcp/mcp.json` for all projects), same JSON:",
        fence("json", mcpServers(v)),
      ].join("\n\n"),
  },
  {
    id: "opencode",
    label: "OpenCode",
    match: /^opencode/i,
    block: (v) =>
      [
        "`opencode.json` in the project (`~/.config/opencode/opencode.json` for all projects), or `opencode mcp add`:",
        fence("json", json({ $schema: "https://opencode.ai/config.json", mcp: { [NAME]: { type: "local", command: ["npx", "-y", pinned(v)], enabled: true } } })),
      ].join("\n\n"),
  },
];

/** The client for an `initialize` clientInfo name, or null when it is not one listed here. */
export function clientFor(name: string | null | undefined): ClientInstall | null {
  if (!name) return null;
  return CLIENTS.find((c) => c.match.test(name)) ?? null;
}

/** The client for a `genclass-mcp config <id>` argument (its id or label, any case). */
export function clientById(id: string): ClientInstall | null {
  const k = id.toLowerCase().replace(/[^a-z0-9]/g, "");
  return CLIENTS.find((c) => c.id.replace(/-/g, "") === k || c.label.toLowerCase().replace(/[^a-z0-9]/g, "") === k) ?? null;
}

/** Every client's block under a `###` heading: the README's install section. */
export function installMarkdown(version: string): string {
  return CLIENTS.map((c) => `### ${c.label}\n\n${c.block(version)}`).join("\n\n");
}
