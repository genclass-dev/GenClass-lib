# Installing the GenClass MCP server (for coding agents)

These are the steps for an agent (Cline or another) that is asked to install GenClass. GenClass is a local MCP server,
`@genclass/mcp` on npm: it records what happens inside the pages of the user's web app running on this machine,
re-runs a page with network responses delivered in different orders to find race conditions, replays one exact order,
and writes a Playwright regression test; it also audits any page for visual bugs (`genclass_scan`). It is free, it
needs no API key and no account, and it sends nothing off the machine (unless the agent asks `genclass_scan` for
`hosted: true`, which sends that URL to the genclass.dev page check). (Closed-loop development as a service, with the MCP server, collector and dashboard run for a customer's
developers by GenClass or inside their network, is an Enterprise offer: https://genclass.dev/enterprise.)

## 1. Requirements

- Node.js 20 or later (`node --version`).
- A web app the user runs with a local dev server (Vite, Next.js, webpack and others).

## 2. Add the server to the MCP settings

Add this entry to the client's MCP settings (in Cline: MCP Servers, Configure MCP Servers, `cline_mcp_settings.json`),
merging it with the servers already there:

```json
{
  "mcpServers": {
    "genclass": {
      "command": "npx",
      "args": ["-y", "@genclass/mcp@0.2.1"]
    }
  }
}
```

Keep the version pinned as shown. No environment variables are required. Optional ones: `GENCLASS_AGENT_PORT` (the
bridge's port, default 47357), `GENCLASS_STATE_DIR` (default `.genclass/agent` in the server's working directory, which is
the project when the client starts servers there; `none` keeps findings in memory).

## 3. Connect the app's development build

The page side is `@genclass/runtime` 0.3.0-beta.1 or later, which has the agent link (`@genclass/runtime/agent`). Call
the `genclass_setup` tool (it reads `package.json` in the server's working directory; if that is not the project,
use the lines below) and it prints the exact lines for the framework. In general:

```bash
npm install @genclass/runtime@beta
```

In the app's browser entry (for Vite `src/main.ts` or `src/main.tsx`; for Next.js a client component loaded once from
the root layout), development builds only:

```ts
import { GenClass } from "@genclass/runtime";
import { connectAgent } from "@genclass/runtime/agent";

const rt = GenClass.init();
if (import.meta.env.DEV) connectAgent(rt); // Next.js: process.env.NODE_ENV === "development"
```

Do not connect production builds. `connectAgent` does nothing on pages not served from this machine.

## 4. Check it works

1. Start the dev server and load one of its pages in a browser.
2. Call `genclass_status`. It should list the page as active. If no page is listed, check the browser console for a
   blocked request to `http://127.0.0.1:47357` (a Content-Security-Policy needs `connect-src http://127.0.0.1:47357`
   in development; a mock service worker must let that address through) and that the page is served from
   `localhost`, `127.0.0.1` or `*.localhost` (other dev hosts need `connectAgent(rt, { anyHost: true })` and
   `GENCLASS_AGENT_ORIGINS=http://host:port` in the server's environment).
3. If the server cannot start because port 47357 is taken by another program, set `GENCLASS_AGENT_PORT` in its
   environment and pass the same URL to the page: `connectAgent(rt, { url: "http://127.0.0.1:<port>" })`.

## 5. Use

Ask for `genclass_findings` after reproducing a bug, `genclass_explore` after changing code that fetches or submits,
`genclass_replay` to confirm a bug before fixing it and its fix after, and `genclass_scan {url}` to audit a page for
visual bugs before calling a UI change done (it needs Playwright's Chromium: `npx playwright install chromium`; the
same audit from a terminal is `npx @genclass/runtime@beta scan <url>`). The server's instructions and each tool's
description say when to use what; the procedure (explore arguments, how to read a report, what to say when done) is
the `genclass` skill: `npx -y @genclass/mcp@0.2.1 init` writes it to `.claude/skills/genclass/SKILL.md` for Claude
Code (`--no-skill` leaves it out), and `npx skills add genclass-dev/GenClass-lib` installs the repository-root copy
(`skills/genclass/SKILL.md`) through a skill directory, with no server. More:
https://github.com/genclass-dev/GenClass-lib/tree/main/packages/mcp
