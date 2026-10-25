// The development-host test, for what a page's own URL may turn on: `?genclass=` / localStorage.genclass raising the
// mode (src/index.ts, THREAT-MODEL T8).
//
// A development host is http(s) on localhost, 127.0.0.1, [::1] or a *.localhost name with an explicit port (a dev
// server), or a *.test name. Nothing else. Narrower than telemetry's isLocalHost (src/telemetry/config.ts) on
// purpose: there a false "local" only sends less; here it would let a crafted link change what a production app's
// visitors get. Hosts that look local but are production for some apps are never development hosts here: Capacitor
// (https://localhost, capacitor://localhost), Tauri (tauri.localhost), Electron (file:), intranet apps on bare names
// and private addresses, *.internal and *.local names. One residual stays: a production app that serves its UI from a
// loopback name with an explicit port (an Electron app with an embedded server, a self-hosted local tool) counts as a
// development host (THREAT-MODEL T8).
//
// Pure: it reads only the location fields it is given (no clock, no randomness; AGENTS.md rule 5). Not in util.ts,
// whose formatting is model-visible (AGENTS.md rule 3).

/** The location fields devHost reads. */
export type DevHostLocation = { protocol?: string; hostname?: string; port?: string };

/**
 * A development host: http(s) on localhost, 127.0.0.1, [::1] or a *.localhost name with an explicit port (a dev
 * server), or a *.test name. Never Capacitor, Tauri, Electron, intranet names, private addresses, *.internal or *.local.
 */
export const devHost = (l?: DevHostLocation): boolean =>
  /^https?:$/.test(l?.protocol ?? "") && (/\.test$/.test(l?.hostname ?? "") || (!!l?.port && /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(l?.hostname ?? "")));
