// Which genclass.dev the CLI talks to (owner: INSTALL). Always https://genclass.dev, unless the GENCLASS_HOST
// environment variable names another origin: that is for tests and for a local `wrangler dev` of telemetry-worker/
// only, every command prints it when it is set, and plain http is accepted only for loopback hosts so a session
// token never crosses a network unencrypted.

export const DEFAULT_HOST = "https://genclass.dev";

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * { host, overridden, error? } from GENCLASS_HOST: `host` is an origin without a trailing slash. With an invalid
 * value, `error` says why and `host` stays the default (callers refuse to run).
 */
export function hostConfig(env = process.env) {
  const raw = env.GENCLASS_HOST;
  if (raw === undefined || raw === "") return { host: DEFAULT_HOST, overridden: false };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { host: DEFAULT_HOST, overridden: true, error: `GENCLASS_HOST is not a URL: ${JSON.stringify(raw)}` };
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.test(u.hostname))) {
    return { host: DEFAULT_HOST, overridden: true, error: `GENCLASS_HOST must be https://, or http:// on localhost (got ${u.origin})` };
  }
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) {
    return { host: DEFAULT_HOST, overridden: true, error: `GENCLASS_HOST must be an origin such as http://localhost:8787 (got ${raw})` };
  }
  return { host: u.origin, overridden: u.origin !== DEFAULT_HOST };
}

/** The host every request goes to (the default when GENCLASS_HOST is invalid; commands check hostConfig first). */
export const apiHost = (env = process.env) => hostConfig(env).host;

/** `${host}${path}`. */
export const hostUrl = (path, env = process.env) => `${apiHost(env)}${path}`;
