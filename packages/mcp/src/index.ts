// @genclass/mcp: GenClass for coding agents (docs/runtime/AGENT.md). The command (bin/genclass-mcp.mjs) is what agents
// run; these exports are for embedding the bridge in another tool and for tests.

export { Store, mergeOrder, replaySpecOf } from "./store.js";
export type { StoreOptions, FindingEvent } from "./store.js";
export { startBridge, probeBridge, callBridge, devOrigin, VERSION } from "./http.js";
export type { Bridge, BridgeOptions } from "./http.js";
export { makeApi, analytics } from "./api.js";
export type { Api } from "./api.js";
export { McpServer, PROTOCOL_VERSIONS } from "./mcp.js";
export { TOOLS, INSTRUCTIONS, callTool, setupText } from "./tools.js";
export { CLIENTS, clientFor, clientById, installMarkdown, serverConfig, hookCommand, pinned, cursorLink, cursorWebLink, vscodeLink, vscodeWebLink, gooseLink } from "./clients.js";
export type { ClientInstall } from "./clients.js";
export { serve, channelEvent } from "./server.js";
export { compareRuns, groupRuns, sameScenario, sameValue, scenarioOf } from "./compare.js";
export type { GroupReport, RunDiff, FieldDiff, Grouping, Tier } from "./compare.js";
export { regressionTest, locator, actionLines, parseTarget } from "./testgen.js";
export { clean, q } from "./text.js";
export * from "./types.js";
