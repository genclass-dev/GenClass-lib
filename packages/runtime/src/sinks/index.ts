// @genclass/runtime/sinks: the vendor-neutral adapters that hand GenClass's findings to the developer's own side
// (README "See it where you already look"): one JSON line per record on the console, and batched POSTs to an endpoint
// the app owns. Each is also its own entry (@genclass/runtime/sinks/<name>) and the zero-code entries load them by
// name (src/cdn/sinks.ts). Tree-shakeable: nothing here runs at import. Forwarding to Sentry, PostHog or Datadog is
// not part of the free runtime (a GenClass Pro feature, configured on the dashboard).

export { consoleJson, type ConsoleJsonSinkOptions, type ConsoleLike } from "./console-json.js";
export { webhook, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_QUEUED, WEBHOOK_SCHEMA, type WebhookBatch, type WebhookSinkOptions } from "./webhook.js";
export { DEFAULT_MAX_PER_SIGNATURE, signature } from "./common.js";
