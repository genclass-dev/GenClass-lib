// Development only. Starts GenClass (observe mode, telemetry off, no model) and its coding-agent link before the
// repro's modules evaluate, so Redux Toolkit's configureStore finds GenClass's Redux DevTools shim and the store is
// discovered automatically. run.mjs serves this file in place of the repro's /src/main.tsx entry; the repro itself
// imports nothing from GenClass. React state discovery is off: it would also record the repro's own on-page action
// log, which is instrumentation, not app state.
if (import.meta.env.DEV) {
  ;(window as any).GENCLASS_CONFIG = {
    mode: 'observe',
    telemetry: false,
    model: false,
    autoState: { redux: true, react: false, zustand: false },
  }
  const { default: runtime } = await import('@genclass/runtime/auto')
  const { connectAgent } = await import('@genclass/runtime/agent')
  // hold: false, so the recording runs never wait for the bridge: the page's timing stays natural
  connectAgent(runtime, { hold: false })
}
await import('/src/main.tsx')
