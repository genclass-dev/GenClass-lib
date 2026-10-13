// @genclass/runtime/sinks: the adapters that forward GenClass's findings to tools developers already open
// (README "See it where you already look"). Each is also its own entry (@genclass/runtime/sinks/<name>) and the
// zero-code entries load them by name (src/cdn/sinks.ts). Tree-shakeable: nothing here runs at import.

export { sentry, type SentryLike, type SentryLevel, type SentrySinkOptions } from "./sentry.js";
export { posthog, type PostHogLike, type PostHogSinkOptions } from "./posthog.js";
export { datadog, type DatadogRumLike, type DatadogSinkOptions } from "./datadog.js";
export { consoleJson, type ConsoleJsonSinkOptions, type ConsoleLike } from "./console-json.js";
export { webhook, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_SCHEMA, type WebhookBatch, type WebhookSinkOptions } from "./webhook.js";
export { DEFAULT_KINDS, DEFAULT_MAX_PER_SIGNATURE, signature, type AdapterOptions } from "./common.js";
