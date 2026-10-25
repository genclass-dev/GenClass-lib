// The install blocks (README Install): the links carry exactly the pinned server entry each client documents, and
// the clientInfo names the clients send map to their blocks.
import { describe, expect, it } from "vitest";
import { clientById, clientFor, cursorLink, cursorWebLink, gooseLink, serverConfig, vscodeLink, vscodeWebLink } from "../src/clients.js";
import { VERSION } from "../src/http.js";

const entry = serverConfig(VERSION);

describe("install links (README Install)", () => {
  it("Cursor: config is the standard base64 of the server entry without its name (cursor.com/docs/mcp/install-links)", () => {
    for (const link of [cursorLink(VERSION), cursorWebLink(VERSION)]) {
      const u = new URL(link);
      expect(u.searchParams.get("name")).toBe("genclass");
      expect(JSON.parse(atob(u.searchParams.get("config")!))).toEqual(entry);
    }
    expect(cursorLink(VERSION).startsWith("cursor://anysphere.cursor-deeplink/mcp/install?")).toBe(true);
    expect(cursorWebLink(VERSION).startsWith("https://cursor.com/link/mcp/install?")).toBe(true);
    // the docs' own example decodes the same way: {"command":"npx","args":["-y","@modelcontextprotocol/server-postgres",...]}
    expect(JSON.parse(atob("eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBnZW5jbGFzcy9tY3BAMC4xLjAiXX0="))).toEqual(serverConfig("0.1.0"));
  });

  it("VS Code: vscode:mcp/install? carries the URL-encoded entry with its name; the https redirect the entry without it", () => {
    const l = vscodeLink(VERSION);
    expect(l.startsWith("vscode:mcp/install?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(l.slice("vscode:mcp/install?".length)))).toEqual({ name: "genclass", ...entry });
    expect(vscodeLink(VERSION, true).startsWith("vscode-insiders:mcp/install?")).toBe(true);
    const w = new URL(vscodeWebLink(VERSION));
    expect(w.origin + w.pathname).toBe("https://vscode.dev/redirect/mcp/install");
    expect(w.searchParams.get("name")).toBe("genclass");
    expect(JSON.parse(w.searchParams.get("config")!)).toEqual(entry);
  });

  it("Goose: cmd, one arg per argument, URL-encoded", () => {
    const u = new URL(gooseLink(VERSION));
    expect(u.protocol).toBe("goose:");
    expect(u.searchParams.get("cmd")).toBe("npx");
    expect(u.searchParams.getAll("arg")).toEqual(entry.args);
    expect(gooseLink(VERSION)).toContain("%40genclass%2Fmcp%40");
  });
});

describe("clientInfo names (initialize) and config ids", () => {
  it("maps the names clients send to their blocks", () => {
    const cases: Record<string, string> = {
      "claude-code": "claude-code",
      "claude-ai": "claude-desktop",
      "cursor-vscode": "cursor",
      Cursor: "cursor",
      "Visual Studio Code": "vscode",
      "Visual Studio Code - Insiders": "vscode",
      "codex-mcp-client": "codex",
      "gemini-cli-mcp-client": "gemini",
      "windsurf-client": "windsurf",
      Devin: "windsurf",
      Cline: "cline",
      "@cline/core": "cline",
      "goose-cli": "goose",
      "goose-desktop": "goose",
      Zed: "zed",
      "junie-client": "jetbrains",
      opencode: "opencode",
    };
    for (const [name, id] of Object.entries(cases)) expect(clientFor(name)?.id, name).toBe(id);
    expect(clientFor("test")).toBeNull();
    expect(clientFor(null)).toBeNull();
  });

  it("config takes an id or a label in any case", () => {
    expect(clientById("VS Code")?.id).toBe("vscode");
    expect(clientById("claude-desktop")?.id).toBe("claude-desktop");
    expect(clientById("gemini")?.id).toBe("gemini");
    expect(clientById("emacs")).toBeNull();
  });
});
