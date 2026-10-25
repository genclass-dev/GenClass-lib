# Changelog

## 0.1.0 (unreleased)

- **Explore stops reporting order-dependent bookkeeping as races** ([docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)
  section 5.1, [RESULTS.md](../../docs/runtime/RESULTS.md) section 17). A reordered run is a race only when what the
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
