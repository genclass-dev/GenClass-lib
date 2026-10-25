// Stand-in for @genclass/runtime/agent while packages/runtime/dist is missing (GENCLASS_SHIM): connectAgent does
// nothing, so the demos still build and run without the real runtime. Never used in measured runs.
export function connectAgent(_runtime: unknown, _opts?: unknown): { connected: boolean; disconnect(): void } {
  return { connected: false, disconnect() {} };
}
