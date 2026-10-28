# Listing `@genclass/mcp`: every directory, ready to send

Submission steps, required fields and a draft entry in each list's own format, for the day `@genclass/mcp` is on npm.
Checked against each directory's own pages on 2026-10-24; each section names its source. Nothing here has been
submitted.

## What is true today (keep every entry to this)

- **Not released yet.** `@genclass/mcp` 0.1.0 is not on npm: its first version is published by the owner from the
  `mcp-tarball` artifact of `.github/workflows/release-mcp.yml` (AGENTS.md rule 9). The page side,
  `@genclass/runtime` 0.3.0-beta.1 (the agent link, `@genclass/runtime/agent`), is waiting on its release approval.
  Until both are out, no install line below works. Send nothing before then, except where a section says the
  listing reads only the repository.
- **Measured on one page.** In headless Chromium (`packages/mcp/test/e2e/race.e2e.mjs`, docs/runtime/AGENT.md
  section 7): a search page whose results are written by each response, on an in-order backend that answers in
  40 ms. `genclass_explore` (2 baselines, 6 reordered runs, `slow_ms: 600`) found the race in **5 of 6** reordered
  runs; on the fixed page **0 of 6** reordered runs differed (no false report). The replay reproduced the bug on the
  buggy page and not on the fixed one; the generated Playwright test failed on the buggy page and passed on the fixed
  one. One page and one bug class: a proof of the mechanism, not a recall figure. Do not write "detects all races",
  "zero false positives" or any rate beyond this.
- **What it needs.** Node 20 or later, a web app on a local dev server, and two lines in the app's development build
  (`connectAgent` from `@genclass/runtime/agent`). Any MCP client over stdio. No API key, no account.
- **What it sends.** Nothing leaves the machine: the bridge listens on 127.0.0.1 only. The one exception is opt-in:
  `genclass_analytics {source: "production"}` reads the developer's own GenClass dashboard when they set
  `GENCLASS_DASHBOARD`.
- **Repository.** Public URL: https://github.com/genclass-dev/GenClass-lib (`daybot-solutions-inc/GenClass-lib` is a
  mirror; submit the `genclass-dev` one everywhere). Server: `packages/mcp`. Claude Code plugin: `packages/mcp/plugin`.
  Registry name: `io.github.genclass-dev/genclass`.

### Texts to reuse

- Up to 100 characters (MCP Registry, `server.json`):
  `Find race conditions in your web app by reordering its responses, replay one, prove the fix.`
- One sentence: `A local MCP server that shows a coding agent what happened inside a web app's pages in causal order, re-runs a page with network responses delivered in different orders to find race conditions, replays one exact order to prove a fix, and writes a Playwright regression test.`
- Three example prompts (the Anthropic directory asks for at least three that work):
  1. "The search results sometimes show an older query. Find out why and prove the fix." (`genclass_findings`,
     `genclass_explain`, `genclass_replay` before and after the fix)
  2. "I changed the autosave code. Check it for races before we call it done." (`genclass_explore` start, run the
     scenario once per armed page load, `genclass_explore` report)
  3. "Is GenClass connected to my dev server? If not, set it up." (`genclass_status`, `genclass_setup`)

### Assets the owner supplies

- **Logo.** There is none in this repository. Cline wants a 400x400 PNG; the Anthropic directory a square PNG of 512 to
  2048 px under 2 MB at `packages/mcp/plugin/.claude-plugin/icon.png` (it becomes the listing icon only the first time
  the plugin is saved in the portal; `claude plugin validate --profile directory` warns `ICON_MISSING` until then);
  Cursor a logo committed to the repository.
- **Contact email** for the forms that ask (Anthropic, mcpservers.org). PRIVACY.md names mehar@daybot.ca.
- **GitHub topic** `gemini-cli-extension` on the repository (Gemini gallery).

## Order

1. Official MCP Registry (automatic, by the release workflow), then the GitHub MCP Registry email.
2. Anthropic directory (plugin), Glama (claim), Cline, mcpservers.org, mcp.so, cursor.directory, Cursor Marketplace,
   Gemini gallery topic, Smithery (bundle).
3. Lists that review by hand once a listing exists: awesome-mcp-servers (needs the Glama score), awesome-claude-code
   (a person, through the web form), ccplugins, awesome-playwright.

---

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

Source: modelcontextprotocol/registry `docs/modelcontextprotocol-io/` (quickstart, authentication, github-actions);
issue modelcontextprotocol/registry#1468.

- **How.** No form or pull request: `mcp-publisher publish` with `packages/mcp/server.json`. The `registry` job of
  `release-mcp.yml` does it after the npm publish: pinned `mcp-publisher` v1.8.1 (sha256 checked), `mcp-publisher
  validate`, `mcp-publisher login github-oidc`, `mcp-publisher publish`, then it reads the entry back. For the first
  version, which the owner publishes to npm by hand, the tag's run stops at npm; run the workflow by hand on the same
  tag (Actions, Release MCP, Run workflow, "Use workflow from: Tags: mcp-v0.1.0") and it runs the registry job alone.
- **Requirements.** The npm version exists first; `package.json` `mcpName` equals `server.json` `name`
  (`io.github.genclass-dev/genclass`); `description` at most 100 characters (`packages/mcp/test/schemas.test.ts`
  checks it against the 2025-12-11 schema, and `mcp-publisher validate` against the live registry accepted this file
  on 2026-10-24 and refused the old 210-character one with 422).
- **Organization namespace.** OIDC grants `io.github.<repository owner>/*`, so the tag must be pushed to
  `genclass-dev/GenClass-lib` (the job checks this first). `mcp-publisher login github` (device flow) cannot publish
  to an organization namespace (#1468, open); the fallback is `mcp-publisher login github --token <PAT>` with a
  classic PAT with `read:org` or a fine-grained one with Organization Members read-only, by an organization Owner.
- **Draft.** `packages/mcp/server.json` as committed.

## 2. GitHub MCP Registry (github.com/mcp) and the VS Code MCP gallery

Source: github.blog "How to find, install, and manage MCP servers with the GitHub MCP Registry" (2025-10-24);
github/github-mcp-server discussion 1257 (2026-05-19: onboarding is manual curation; later versions sync from the
official registry); docs.github.com "Extend Copilot Chat with MCP" (VS Code adds servers from the GitHub MCP Registry).

- **How.** After the official registry lists the server, email partnerships@github.com asking for it to be included.
- **Draft email.**

  > Subject: MCP server for the GitHub MCP Registry: io.github.genclass-dev/genclass
  >
  > Hello, we publish io.github.genclass-dev/genclass to the official MCP Registry (npm `@genclass/mcp`, stdio,
  > Apache-2.0, source https://github.com/genclass-dev/GenClass-lib/tree/main/packages/mcp) and would like it included
  > in the GitHub MCP Registry. It is a local server for coding agents: it shows the agent what happened inside a web
  > app's pages on the developer's machine in causal order, re-runs a page with network responses delivered in
  > different orders to find race conditions, replays one exact order to prove a fix, and writes a Playwright
  > regression test. It needs no account or API key and sends nothing off the machine. Measured so far on one page
  > (a stale-response race): it found the race in 5 of 6 reordered runs and reported nothing on the fixed page.
  > Install in VS Code: `code --add-mcp '{"name":"genclass","command":"npx","args":["-y","@genclass/mcp@0.2.1"]}'`.
  > Thank you.

## 3. Anthropic directory (claude.ai/directory/manage)

Source: claude.com/docs/directory/publish, claude.com/docs/plugins/submit, claude.com/docs/plugins/pre-submission-checklist,
support.claude.com "Anthropic Software Directory Policy".

- **Route.** A Claude Code plugin bundle. The directory no longer accepts local MCP servers as desktop extensions
  (MCPB) and takes remote servers only as connectors, so the plugin is the route for this local server.
- **Who.** A Pro, Max, Team or Enterprise plan (Team or Enterprise: an Owner, or a member with the Directory
  permission), with GitHub connected on claude.ai and push access to the repository. The first organization to
  submit a repository folder holds that listing.
- **Steps.** claude.ai/directory/manage, Submit new, Plugin bundle. Source: repository `genclass-dev/GenClass-lib`,
  plugin path `packages/mcp/plugin`, branch `main`; Validate. Listing details are read from
  `packages/mcp/plugin/.claude-plugin/plugin.json` and `packages/mcp/plugin/README.md`. Data handling: the plugin
  collects and sends nothing; it reads and writes `.genclass/agent/` in the project and `~/.genclass/` (the bridge
  token); the optional dashboard read is the only network request off the machine. Compliance: contact email and
  the four acknowledgements. Updates: GitHub push webhook.
- **What the checks will say.** Local run of `claude plugin validate packages/mcp/plugin --profile directory`
  (Claude Code 2.1.310): passes; one warning, `ICON_MISSING`. The portal also holds pinned launchers for a reviewer:
  expect "Runs a pinned npx or uvx package" (both `.mcp.json` and the hook run `npx -y @genclass/mcp@0.2.1`), and
  possibly "MCP server command wasn't read" because the server is not a file inside the plugin folder. An unpinned
  launcher would block; `packages/mcp/test/manifests.test.ts` keeps both pins equal to `package.json`'s version. The
  way to avoid the hold is to ship the built server (`dist/cli.js`, 125 KB, no dependencies) inside the plugin
  folder and run `node ${CLAUDE_PLUGIN_ROOT}/...`; that means committing a build output, so it is left to the owner.
- **Policy items.** Privacy policy URL: `privacyPolicyUrl` in `plugin.json` (the plugin README's Privacy section).
  Support: `supportUrl` (GitHub issues). Tool annotations: every tool has `title`, `readOnlyHint`, `destructiveHint`
  and `openWorldHint`. Test account: none needed (no account exists); for a reviewer's page to test against, the
  end-to-end app is `packages/mcp/test/e2e/app`. Example prompts: the three above.

## 4. punkpeye/awesome-mcp-servers

Source: punkpeye/awesome-mcp-servers `CONTRIBUTING.md`, `README.md` (legend, Developer Tools),
`.github/workflows/check-glama.yml`.

- **How.** Fork, add one line under Developer Tools in `README.md`, open a pull request. Rules: public GitHub
  repository; link text `owner/repo`; only emojis from the legend; alphabetical within the category. The bot then
  asks for a Glama listing that passes its checks and a Glama score badge after the name; the maintainer merges once
  the server is claimed on Glama and has a score. An automated agent opening the PR must add `🤖🤖🤖` to its title;
  a person does not.
- **When.** After npm and the Glama claim (section 5).
- **Draft** (heading `### 💻 <a name="developer-tools"></a>Developer Tools`; confirm the Glama path once listed):

```
- [genclass-dev/GenClass-lib](https://github.com/genclass-dev/GenClass-lib) [![genclass-dev/GenClass-lib MCP server](https://glama.ai/mcp/servers/genclass-dev/GenClass-lib/badges/score.svg)](https://glama.ai/mcp/servers/genclass-dev/GenClass-lib) 📇 🏠 🍎 🪟 🐧 - Race conditions in web apps for coding agents: records clicks, requests, response order and state writes in the app's pages on your machine, re-runs a page with responses delivered in different orders, replays one exact order to prove a fix and writes a Playwright regression test.
```

## 5. Glama (glama.ai/mcp/servers)

Source: glama.ai/mcp/faq; glama.ai/blog/2025-07-08-what-is-glamajson; schema glama.ai/mcp/schemas/server.json.

- **How.** glama.ai/mcp/servers, Add Server: the GitHub repository URL, a display name and a short description.
  Glama then checks the license, scans and starts the server. For an organization's repository, ownership is claimed
  through `glama.json` at the repository root (committed: `{"maintainers": ["MeharPro"]}`, valid against Glama's
  schema in `schemas.test.ts`); add the other maintainers' GitHub usernames before claiming, then run Claim
  ownership again after any change to the file.
- **Build.** The score needs the server to start and answer introspection. Glama takes a Dockerfile in its own admin
  page, not from the repository. This one works for a stdio server from npm (paste it there once 0.1.0 is on npm):

```dockerfile
FROM node:22-alpine
ENV GENCLASS_STATE_DIR=none
ENTRYPOINT ["npx", "-y", "@genclass/mcp@0.2.1"]
```

- **Fields.** Display name `GenClass`; description: the 100-character text above. How Glama treats a server in a
  subfolder of a monorepo is not documented; give `packages/mcp` if it asks.

## 6. Cline MCP Marketplace (cline/mcp-marketplace)

Source: cline/mcp-marketplace `README.md` and `.github/ISSUE_TEMPLATE/mcp-server-submission.yml`.

- **How.** New issue with the "MCP Server Submission" template:
  https://github.com/cline/mcp-marketplace/issues/new?template=mcp-server-submission.yml (title `[Server Submission]: `).
- **Fields.** GitHub Repository URL (required); Logo Image, a 400x400 PNG (required); two required checkboxes: Cline
  set the server up from the README and/or `llms-install.md` alone, and the server is stable and ready for public
  use (check both only after trying it with the published package); Additional Information (the README's "Reason for
  Addition" goes here). `llms-install.md` is at the repository root.
- **Draft.**

  > GitHub Repository URL: https://github.com/genclass-dev/GenClass-lib
  >
  > Additional Information: The server is in `packages/mcp` (npm `@genclass/mcp`); install steps for agents are in
  > `llms-install.md` at the repository root. Reason for addition: it gives Cline a way to find and prove timing bugs
  > in a web app (stale responses that overwrite newer data, double submits, errors that happen "sometimes"): it
  > records what happened inside the app's pages on the developer's machine in causal order, re-runs a page with
  > network responses delivered in different orders, replays one exact order to confirm a bug and its fix, and
  > writes a Playwright regression test. Local only: no API key, nothing sent off the machine. Measured so far on one
  > page: the race was found in 5 of 6 reordered runs, with no false report on the fixed page.

## 7. mcpservers.org

Source: the form at https://mcpservers.org/submit.

- **Fields.** Server Name `GenClass`; Category `Development`; Short Description: the one-sentence text above;
  Repository, Website or Documentation: `https://github.com/genclass-dev/GenClass-lib/tree/main/packages/mcp`;
  Official MCP Registry Name: `io.github.genclass-dev/genclass`; "supports remote connections": leave unchecked
  (stdio only); Contact Email; plan Free (review within two weeks) unless the owner prefers the paid one.

## 8. mcp.so

Source: https://mcp.so/submit; chatmcp/mcpso issue 1 "Submit Your MCP Servers here".

- **How.** The form, type MCP Server: Repository URL `https://github.com/genclass-dev/GenClass-lib`, Name `GenClass`.
  The form shows a paid option ($39, published without review); the free review option was not visible without
  signing in. Or a comment on issue chatmcp/mcpso#1.
- **Draft comment.**

  > GenClass: https://github.com/genclass-dev/GenClass-lib (server in `packages/mcp`). A local MCP server that shows a
  > coding agent what happened inside a web app's pages in causal order, finds race conditions by re-running a page
  > with responses delivered in different orders, replays one exact order to prove a fix, and writes a Playwright
  > regression test. Install: `npx -y @genclass/mcp@0.2.1`. Category: developer tools.

## 9. cursor.directory

Source: the site's source README (cursor/community-plugins); the site itself answered 429 to automated reads, so the
form was not read.

- **How.** cursor.directory/plugins/new, sign in with GitHub or Google, paste the repository URL, Submit. It detects
  components in the Open Plugins (Agent Plugins) layout: `packages/mcp/plugin/plugin.json` and `mcp.json` (Agent
  Plugins 1.0.0, valid against its schemas in `schemas.test.ts`), `skills/genclass/SKILL.md`, and the Claude Code
  `.mcp.json` and `hooks/hooks.json`. If it does not find a plugin in a subfolder from the repository URL, paste
  `https://github.com/genclass-dev/GenClass-lib/tree/main/packages/mcp/plugin`. Each submission gets an automated
  security scan.

## 10. Cursor Marketplace (cursor.com/marketplace/publish)

Source: cursor.com/docs/reference/plugins ("Submitting a plugin").

- **How.** Submit the repository link at cursor.com/marketplace/publish; Cursor reviews each plugin and each update.
  `.cursor-plugin/marketplace.json` at the repository root points to `packages/mcp/plugin`, where the Agent Plugins
  `plugin.json` and `mcp.json` are (server and skill; Cursor's own hook events differ, so the Claude Code hook is not
  part of it). Its checklist also wants a committed logo and a README that documents usage
  (`packages/mcp/plugin/README.md`).

## 11. Gemini CLI extensions gallery (geminicli.com/extensions)

Source: google-gemini/gemini-cli `docs/extensions/releasing.md` and `docs/extensions/reference.md`.

- **How.** No submission: a daily crawler lists public repositories with the GitHub topic `gemini-cli-extension`
  whose root holds `gemini-extension.json`. Add the topic to `genclass-dev/GenClass-lib` once 0.1.0 is on npm. The
  committed `gemini-extension.json` starts `npx -y @genclass/mcp@0.2.1` (kept equal to the package version by
  `manifests.test.ts`).
- **Install line for the entry.** `gemini extensions install https://github.com/genclass-dev/GenClass-lib`. This
  clones the whole repository, which is large; `gemini mcp add genclass npx -- -y @genclass/mcp@0.2.1` adds the server
  alone.

## 12. Smithery (smithery.ai)

Source: smithery.ai/docs/build/publish ("Local (MCPB Bundle)"), smithery.ai/docs/concepts/cli.

- **How.** Local stdio servers are listed from an MCP Bundle. The release workflow builds it
  (`npm run bundle -w @genclass/mcp`, `mcp-bundle` artifact: `genclass-<version>.mcpb` and its sha256; the bundle
  was built, validated with `mcpb validate` and its unpacked server answered an MCP initialize). The owner publishes
  it: `npm install -g smithery@latest`, `smithery auth login`,
  `smithery mcp publish genclass-0.1.0.mcpb -n genclass/genclass` (the qualified name is the owner's choice), then
  completes the publishing flow on the site.

## 13. hesreallyhim/awesome-claude-code

Source: hesreallyhim/awesome-claude-code `CONTRIBUTING.md` and `.github/ISSUE_TEMPLATE/recommend-resource.yml`.

- **Rules.** Only through the web issue form "Recommend a Resource", by a person (not an agent, not the `gh` CLI, not a
  pull request); one resource at a time; the resource must have 14 days of active development since the first
  commit on its default branch, or 100 stars. Description: 1 to 3 sentences, 10 to 500 characters, descriptive, not
  promotional, does not address the reader, no emojis.
- **Draft.**
  - Display Name: `GenClass`
  - Category: `Testing`
  - Link: `https://github.com/genclass-dev/GenClass-lib/tree/main/packages/mcp`
  - Author Name: `GenClass`; Author Link: `https://github.com/genclass-dev`
  - Description: `A plugin with an MCP server, a prompt hook and a skill that show Claude Code what happened inside a web app's pages in causal order, re-run a page with network responses delivered in different orders to find race conditions, and replay one exact order to confirm a fix. It also writes a Playwright regression test from a finding; so far measured on one page, where the race showed in 5 of 6 reordered runs and the fixed page showed none.`
  - Checklist: the five required boxes are for the person who submits to check after doing what they say; leave the
    last box unchecked.

## 14. ccplugins/awesome-claude-code-plugins

Source: ccplugins/awesome-claude-code-plugins `README.md` (no CONTRIBUTING file).

- **How.** A pull request adding one line under `### MCP Servers` in `README.md` (roughly alphabetical). Optionally
  an entry in its `.claude-plugin/marketplace.json`; for a plugin in a subfolder Claude Code's marketplace format
  takes `{"source": "git-subdir", "url": "genclass-dev/GenClass-lib", "path": "packages/mcp/plugin"}`.
- **Draft.**

```
- [GenClass](https://github.com/genclass-dev/GenClass-lib/tree/main/packages/mcp/plugin) - See the race, replay it, prove the fix: an MCP server, a prompt hook and a skill that show Claude what happened inside a web app's pages in causal order, re-run a page with responses in different orders to find races, and write a Playwright regression test. Install: `/plugin marketplace add genclass-dev/GenClass-lib` then `/plugin install genclass@genclass`
```

  (The list's own entries separate name and text with a long dash; this draft uses a hyphen, per this repository's
  writing rules. Swap it if the maintainer asks.)

## 15. mxschmitt/awesome-playwright

Source: mxschmitt/awesome-playwright `README.md` (section "AI & Agents", alphabetical) and `CONTRIBUTING.md`.

- **How.** A pull request adding one line under `## AI & Agents`, between "Cutaway" and "Playwright Agent CLI".
- **Draft.**

```
- [GenClass MCP](https://github.com/genclass-dev/GenClass-lib/tree/main/packages/mcp) - MCP server that lets coding agents find race conditions in a web app by re-running a page with responses delivered in different orders, replay one exact order, and generate a Playwright test that fails while the bug is there.
```

  `@genclass/playwright` (the race-file reporter) would go under `## Reporters` in the same format once it is
  released.
