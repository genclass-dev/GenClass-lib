// The package version, for telemetry batches and diagnostics. Kept equal to package.json "version" by
// test/telemetry.test.ts ("RUNTIME_VERSION matches package.json"); bump both together: .github/workflows/release.yml
// checks that the v<version> tag equals package.json and that this file holds the same string.

export const RUNTIME_VERSION = "0.3.0-beta.2";
