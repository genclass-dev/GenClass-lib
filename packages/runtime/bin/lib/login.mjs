// `genclass-runtime login | connect | whoami | logout` (also `npx @genclass/runtime ...`; owner: INSTALL).
//
// login signs this computer in to a GenClass account with the device flow (RFC 8628): it prints a code and a link to
// https://genclass.dev/login/device, opens the browser when it can (and goes on when it cannot), polls at the interval
// the server gives (5 s more after each slow_down) until the code is approved, denied or expires, and saves the CLI
// session (account.mjs). Ctrl-C stops it and saves nothing. Inside an app's folder it then asks whether to connect
// that app. connect picks one of the account's apps, or creates one named after package.json once the changes are
// approved, and writes its token exactly the way init does (init.mjs: the same snippet edits, the same diff and
// question; --yes skips it). An app init made without an account (its private link in .genclass.local) can be added
// to the account instead of replaced. whoami prints the account and its apps; logout revokes the session at
// genclass.dev and deletes the file. dashboard prints the link to the free dashboard of the app in this folder: its
// private link from .genclass.local (no network), else its page in the signed-in account (GET /api/me), else the
// account's apps; --open opens it. Running one of these commands is the agreement to contact genclass.dev for it;
// creating an app or writing a file is asked first. A private dashboard link is only ever sent to the host it belongs
// to: with GENCLASS_HOST set to another host, a genclass.dev link in .genclass.local stays on this computer.

import { spawn } from "node:child_process";
import { relative } from "node:path";
import {
  claimProject,
  createAccountProject,
  deleteCredentials,
  fetchMe,
  pollDeviceLogin,
  readCredentialsFor,
  revokeSession,
  saveCredentials,
  startDeviceLogin,
} from "./account.mjs";
import { apiHost, hostConfig, hostUrl } from "./host.mjs";
import { FREE_LINES, UsageError, accountLabel, hostNotice, init, inspectProject, parse } from "./init.mjs";
import { AUTO } from "./plan.mjs";
import { LOCAL_FILE, tokenInFiles } from "./token.mjs";
import { banner, c, choose, confirm, err, interactive, out, row, sym } from "./ui.mjs";

const CMD = "npx @genclass/runtime";

export const USAGE = `Usage:
  genclass-runtime login   [--yes] [--no-browser] [--no-connect] [--app <id|name>] [--name <name>]
                           [--no-install] [--cwd <dir>]
  genclass-runtime connect [--app <id|name>] [--name <name>] [--yes] [--dry-run] [--no-install] [--cwd <dir>]
  genclass-runtime whoami
  genclass-runtime logout
  genclass-runtime dashboard [--open] [--cwd <dir>]

login    signs this computer in to your GenClass account. It prints a code and a link to
         https://genclass.dev/login/device and opens it in your browser; you sign in there (Google, email
         and password, GitHub or a passkey) and approve the code. The CLI session is saved, readable only by you, in
         ~/.config/genclass/credentials.json ($XDG_CONFIG_HOME/genclass; Windows: %APPDATA%\\genclass).
         Inside an app's folder it then asks whether to connect that app.
connect  connects the app in this folder to your account: pick one of your apps, or create one named after
         package.json. It writes the app's project key (token) the way init does: it shows the diff and asks
         first, and sets GenClass up if init has not. An app init created without an account (its private
         link is in ${LOCAL_FILE}) can be added to your account instead.
whoami   shows the signed-in account and its apps.
logout   ends the CLI session at genclass.dev and deletes the saved file.
dashboard
         prints the link to this app's dashboard, free for every app: what GenClass found, on which pages,
         what it did, and (with analytics: true) how visitors use each page. It reads the private link in
         ${LOCAL_FILE} without contacting anything; signed in, it finds the app in your account (or lists
         your apps).

  --yes, -y        no questions: login connects this folder's app; connect uses your app named like
                   package.json (or creates it) and applies the changes
  --no-browser     login: print the link only, do not open a browser
  --open           dashboard: also open the link in your browser
  --no-connect     login: do not offer to connect the app in this folder
  --app <id|name>  use this app of your account
  --name <name>    create a new app with this name (default: package.json's name)
  --dry-run        connect: show what would change; it reads your app list, and creates and writes nothing
  --no-install     do not run the package manager (when connect sets GenClass up)
  --cwd <dir>      the project directory (default: the current directory)

These commands contact genclass.dev when you run them; creating an app or writing a file is asked first. The
project key is public (it ships in your page and can only add telemetry to its app); the CLI session is not:
logout ends it.`;

const SPECS = {
  login: {
    bool: { yes: "yes", y: "yes", "no-browser": "noBrowser", "no-connect": "noConnect", "no-install": "noInstall", help: "help", h: "help" },
    value: { cwd: "cwd", app: "app", name: "name" },
  },
  connect: {
    bool: { yes: "yes", y: "yes", "dry-run": "dryRun", "no-install": "noInstall", help: "help", h: "help" },
    value: { cwd: "cwd", app: "app", name: "name" },
  },
  whoami: { bool: { help: "help", h: "help" }, value: { cwd: "cwd" } },
  logout: { bool: { help: "help", h: "help" }, value: { cwd: "cwd" } },
  dashboard: { bool: { open: "open", help: "help", h: "help" }, value: { cwd: "cwd" } },
};

// ----------------------------------------------------------------------------------------------- helpers

const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

/** Whether `url` (a dashboard link) is on `host` (an origin). */
const onHost = (url, host) => {
  try {
    return new URL(url).origin === host;
  } catch {
    return false;
  }
};

const sessionGone = () => err(`  ${c.red(sym.cross)} The saved CLI session no longer works (signed out, revoked or expired). Sign in again: ${c.cyan(`${CMD} login`)}`);

/** Opens url in the default browser when that makes sense here. Returns whether it tried; never throws. */
function openBrowser(url, o) {
  if (o.noBrowser || !process.stdout.isTTY) return false;
  const env = process.env;
  if (env.SSH_CONNECTION || env.SSH_TTY) return false; // the browser would open on the other machine
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => out(`  ${c.gray("Could not open a browser: open the link above yourself.")}`));
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The project checks init makes before it changes anything. Returns an exit code, or null when it is a browser app. */
function refuse(st) {
  if (st.project.refused) {
    out(`  ${c.yellow(sym.warn)} Not a browser app GenClass can be added to (${st.project.refused}).`);
    out(`  Run ${c.cyan(`${CMD} connect`)} inside your web app's folder (or pass --cwd).`);
    out();
    return 1;
  }
  if (!st.project.framework) {
    out(`  ${c.yellow(sym.warn)} Could not recognise a web app in ${c.bold(st.cwd)}.`);
    out(`  Run ${c.cyan(`${CMD} connect`)} inside your web app's folder (or pass --cwd).`);
    out();
    return 1;
  }
  return null;
}

/** The code to add by hand when GenClass is set up without init (connect does not edit hand-written code). */
function printManual(token) {
  out(`  GenClass is set up by hand in this project, so connect does not edit your code. Add the key yourself:`);
  out(`    ${c.cyan(`GenClass.init({ token: "${token}" })`)}`);
  out(`  or on the script tag ${c.cyan(`data-token="${token}"`)}, or in <head> ${c.cyan(`<meta name="genclass" content="token=${token}">`)},`);
  out(`  or set ${c.cyan(`window.GENCLASS_CONFIG = { token: "${token}" }`)} before the ${c.cyan(AUTO())} import runs.`);
  out(`  ${c.gray("The key needs @genclass/runtime 0.3.0-beta.0 or later (0.2.x has no token option).")}`);
  out();
}

/**
 * Why POST /api/account/projects/claim refused, and what to do instead. genclass.dev answers 409 when the dashboard
 * belongs to another account and 404 (400 for a malformed link) when it does not know the link; the account page's
 * "Add an existing dashboard" gives the same answers, so it is suggested only for errors that may pass.
 */
function claimFailed(r, pkgName) {
  if (r.status === 401) return sessionGone();
  const fresh = `${CMD} connect --name ${/^[A-Za-z0-9._@/-]+$/.test(pkgName) ? pkgName : JSON.stringify(pkgName)}`;
  if (r.status === 409) {
    err(`  ${c.red(sym.cross)} That dashboard belongs to another GenClass account, so it was not added to this one.`);
    err(`  Sign in with that account (${c.cyan(`${CMD} logout`)}, then ${c.cyan("login")}), or give this folder a new app in your`);
    err(`  account with ${c.cyan(fresh)} (its key replaces the one in your setup).`);
    return;
  }
  if (r.status === 404 || r.status === 400) {
    err(`  ${c.red(sym.cross)} ${apiHost()} does not know the dashboard link in ${LOCAL_FILE} (it may have been deleted).`);
    err(`  Give this folder a new app in your account with ${c.cyan(fresh)}`);
    err(`  (its key replaces the one in your setup).`);
    return;
  }
  err(`  ${c.red(sym.cross)} Could not add it (${r.reason}).`);
  err(`  Try again, or open ${c.cyan(hostUrl("/account"))} and paste the link from ${LOCAL_FILE} under "Add an existing dashboard".`);
}

// ----------------------------------------------------------------------------------------------- connect

/**
 * Connects the app in st (inspectProject) to the account: already connected, add its existing dashboard (claim), or
 * pick or create an app of the account and hand over to init. `me`: a GET /api/me answer already fetched.
 */
async function connectApp(o, creds, st, me) {
  me ??= await fetchMe(creds);
  if (!me.ok) {
    if (me.status === 401) sessionGone();
    else err(`  ${c.red(sym.cross)} Could not read your apps at ${apiHost()} (${me.reason}).`);
    out();
    return 1;
  }
  const apps = me.projects;
  const pkgName = String(st.project.pkg?.name || st.project.name || "app").slice(0, 80);
  const inFiles = tokenInFiles(st.marked);
  const current = st.token ? apps.find((a) => a.token === st.token) : null;

  // this folder's token is already one of the account's apps
  if (current && !o.app && !o.name) {
    row("App", `${c.bold(current.name)} ${c.gray(`(already in your account; project key ${current.token})`)}`);
    if (st.handWritten) {
      out();
      printManual(current.token);
      return 0;
    }
    if (inFiles === current.token) {
      if (current.dashboard_url) row("Dashboard", c.cyan(current.dashboard_url));
      out();
      out(`  ${c.green("Nothing to do.")}`);
      out();
      return 0;
    }
    out();
    return init({ ...o, token: current.token }, { banner: false, cmd: "connect", creds, app: current });
  }

  // a dashboard init made without an account: add it to the account, keeping its token and history. Only on the host
  // the link belongs to: the link is the dashboard's secret, and a session for another host must not receive it.
  let claimable = st.token && !current && st.local?.token === st.token && st.local.dashboardUrl && !o.app && !o.name;
  if (claimable && !onHost(st.local.dashboardUrl, creds.host)) {
    out(`  ${c.yellow(sym.warn)} The private dashboard link in ${LOCAL_FILE} belongs to ${new URL(st.local.dashboardUrl).origin}, not ${creds.host},`);
    out(`    so it is not sent there and this app is not added to that account from it.`);
    out();
    claimable = false;
  }
  if (claimable) {
    out(`  This app already has a dashboard made without an account (key ${st.token}; its private link is in ${LOCAL_FILE}).`);
    const ok = o.dryRun ? null : o.yes ? true : await confirm("Add that dashboard to your account? It keeps its key and its data.");
    if (o.dryRun) {
      out(`  ${c.gray("Dry run: it would be added to your account. Only your app list was read; nothing was added or written.")}`);
      out();
      return 0;
    }
    if (ok === null) {
      out(`  Not a terminal, so nothing was sent. Re-run with ${c.bold("--yes")} to add it.`);
      out();
      return 1;
    }
    if (ok) {
      const r = await claimProject(creds, st.local.dashboardUrl);
      if (!r.ok) {
        claimFailed(r, pkgName);
        out();
        return 1;
      }
      const app = r.project ?? { name: pkgName, token: st.token, dashboard_url: null };
      row("App", `${c.bold(app.name)} ${c.gray(`(added to your account; project key ${st.token})`)}`);
      if (st.handWritten) {
        out();
        printManual(st.token);
        return 0;
      }
      if (inFiles === st.token) {
        if (app.dashboard_url) row("Dashboard", c.cyan(app.dashboard_url));
        out(`  ${c.gray("The key in your setup stays the same, so no file changes.")}`);
        out();
        return 0;
      }
      out();
      return init({ ...o, token: st.token }, { banner: false, cmd: "connect", creds, app: { ...app, token: st.token } });
    }
    out();
  }

  // pick one of the account's apps or a new one; a new app is created only once the changes are approved
  const createName = String(o.name || pkgName).slice(0, 80);
  let pick;
  if (o.app) {
    pick = apps.findIndex((a) => a.id === o.app || a.name === o.app);
    if (pick < 0) {
      err(`  ${c.red(sym.cross)} No app "${o.app}" in your account.${apps.length ? ` Your apps: ${apps.map((a) => `${a.name} (${a.id})`).join(", ")}.` : " It has no apps yet."}`);
      out();
      return 1;
    }
  } else if (o.name) pick = apps.length;
  else {
    const same = apps.findIndex((a) => a.name === pkgName);
    const def = same >= 0 ? same : apps.length;
    pick = def;
    if (apps.length && !o.yes && interactive()) {
      const labels = [...apps.map((a) => `${a.name}  ${c.gray(`${a.token}  ${a.last_event ? `last event ${when(a.last_event)}` : "no events yet"}`)}`), `Create a new app named ${c.bold(createName)}`];
      const got = await choose(`Which app of your account is this (${pkgName})?`, labels, def);
      if (got !== null) pick = got;
      out();
    }
  }
  const app = pick < apps.length ? apps[pick] : null;
  if (st.token && st.token !== app?.token) {
    out(`  ${c.yellow(sym.warn)} This replaces the project key ${st.token} in your setup.`);
    if (st.local?.dashboardUrl && st.local.token === st.token)
      out(`    Its private link stays in ${LOCAL_FILE}; to keep that history, paste it under "Add an existing dashboard" at ${hostUrl("/account")}.`);
    out();
  }
  row("App", app ? `${c.bold(app.name)} ${c.gray(`(in your account; project key ${app.token})`)}` : `${c.bold(createName)} ${c.gray("(a new app in your account, created once you apply the changes)")}`);

  if (st.handWritten) {
    out();
    let token = app?.token;
    if (!token) {
      if (o.dryRun) {
        out(`  ${c.gray("Dry run: the app would be created. Only your app list was read; nothing was created.")}`);
        out();
        return 0;
      }
      const ok = o.yes ? true : await confirm(`Create the app "${createName}" in your account?`);
      if (ok === null) {
        out(`  Not a terminal, so nothing was sent. Re-run with ${c.bold("--yes")}.`);
        out();
        return 1;
      }
      if (!ok) {
        out(`  Nothing changed.`);
        out();
        return 0;
      }
      const r = await createAccountProject(creds, createName);
      if (!r.ok) {
        err(`  ${c.red(sym.cross)} Could not create the app (${r.reason}).`);
        out();
        return 1;
      }
      token = r.token;
      row("App", `${c.bold(r.name)} ${c.gray(`created; project key ${token}`)}`);
      if (r.dashboardUrl) row("Dashboard", c.cyan(r.dashboardUrl));
      out();
    }
    printManual(token);
    return 0;
  }
  out();
  return app ? init({ ...o, token: app.token }, { banner: false, cmd: "connect", creds, app }) : init(o, { banner: false, cmd: "connect", creds, create: createName });
}

async function connect(o) {
  banner("connect");
  hostNotice();
  const { creds, otherHost } = readCredentialsFor();
  if (!creds) {
    out(`  Not signed in${otherHost ? ` at ${apiHost()} (the saved session is for ${otherHost})` : ""}. Sign in first: ${c.cyan(`${CMD} login`)} (it offers to connect this app too).`);
    out();
    return 1;
  }
  row("Account", accountLabel(creds.account));
  const st = inspectProject(o);
  const no = refuse(st);
  if (no !== null) return no;
  return connectApp(o, creds, st, null);
}

// ------------------------------------------------------------------------------------------------- login

/** After signing in: offer to connect the app in this folder (asked first; --yes connects). */
async function afterLogin(o, creds, me) {
  if (o.noConnect) return 0;
  const st = inspectProject(o);
  if (st.project.refused || !st.project.framework) {
    out(`  Next: run ${c.cyan(`${CMD} connect`)} in your web app's folder to connect it to your account.`);
    out(`  ${c.gray(`Your apps' dashboards, free: ${hostUrl("/account")}`)}`);
    out();
    return 0;
  }
  const where = relative(process.cwd(), st.cwd) || ".";
  const name = st.project.pkg?.name || st.project.name;
  const ok = o.yes ? true : await confirm(`Connect ${name} (${where}, ${st.project.label}) to your account?`);
  if (ok === null) {
    out(`  Not a terminal: run ${c.cyan(`${CMD} connect --yes`)} here to connect this app.`);
    out();
    return 0;
  }
  if (!ok) {
    out(`  Not connected. Later: ${c.cyan(`${CMD} connect`)}`);
    out();
    return 0;
  }
  out();
  return connectApp(o, creds, st, me);
}

async function login(o) {
  banner("login");
  hostNotice();
  const host = apiHost();
  const saved = readCredentialsFor(host);
  if (saved.creds) {
    const me = await fetchMe(saved.creds);
    if (me.ok) {
      row("Account", `${accountLabel(me.account)} ${c.gray(`(already signed in; ${CMD} logout to switch accounts)`)}`);
      out();
      return afterLogin(o, { ...saved.creds, account: me.account }, me);
    }
    if (me.status !== 401) {
      err(`  ${c.red(sym.cross)} Could not reach ${host} (${me.reason}).`);
      out();
      return 1;
    }
    out(`  ${c.yellow(sym.warn)} The saved session no longer works (signed out, revoked or expired): signing in again.`);
    out();
  }

  const dev = await startDeviceLogin({ host });
  if (!dev.ok) {
    err(`  ${c.red(sym.cross)} Could not start signing in at ${host} (${dev.reason}).`);
    out();
    return 1;
  }
  out(`  Open this link, sign in (Google, email and password, GitHub or a passkey) and approve the code:`);
  out(`    ${c.bold(c.cyan(dev.verification_uri_complete))}`);
  out();
  row("Code", `${c.bold(dev.user_code)} ${c.gray("(check that the page shows the same code)")}`);
  out();
  if (openBrowser(dev.verification_uri_complete, o)) out(`  ${c.gray("Opening it in your browser.")}`);
  else out(`  ${c.gray("Open the link in a browser on any device.")}`);
  const minutes = Math.max(1, Math.round(dev.expires_in / 60));
  out(`  Waiting for approval ${c.gray(`(the code expires in ${minutes} minute${minutes === 1 ? "" : "s"}; Ctrl-C to cancel)`)}`);

  const ctl = new AbortController();
  const onSigint = () => ctl.abort();
  process.on("SIGINT", onSigint);
  let r;
  try {
    r = await pollDeviceLogin(dev, { host, signal: ctl.signal, onSlowDown: (s) => out(`  ${c.gray(`The server asked for slower polling: every ${s} s now.`)}`) });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  if (!r.ok) {
    out();
    if (r.error === "cancelled") {
      err(`  Cancelled: not signed in, nothing was saved.`);
      out();
      return 130;
    }
    if (r.error === "access_denied") err(`  ${c.red(sym.cross)} The sign-in was denied in the browser. Nothing was saved.`);
    else if (r.error === "expired_token") err(`  ${c.red(sym.cross)} The code expired before it was approved. Run ${c.cyan(`${CMD} login`)} again.`);
    else err(`  ${c.red(sym.cross)} Could not sign in (${r.reason}). Nothing was saved.`);
    out();
    return 1;
  }
  const creds = { host, access_token: r.access_token, account: r.account ?? { id: "", email: null, github_login: null }, created: new Date().toISOString() };
  let path;
  try {
    path = saveCredentials(creds);
  } catch (e) {
    err(`  ${c.red(sym.cross)} Could not save the session (${e?.message ?? e}), so it was ended again.`);
    await revokeSession(creds);
    out();
    return 1;
  }
  out();
  row("Signed in", `${c.bold(accountLabel(creds.account))}${creds.account.github_login && creds.account.email ? c.gray(` (GitHub ${creds.account.github_login})`) : ""}`);
  out(`  ${c.gray(`Session saved in ${path} (only you can read it). Sign out: ${CMD} logout`)}`);
  out();
  return afterLogin(o, creds, null);
}

// ------------------------------------------------------------------------------------------ whoami, logout

async function whoami() {
  banner("whoami");
  hostNotice();
  const { creds, otherHost, path } = readCredentialsFor();
  if (!creds) {
    out(`  Not signed in${otherHost ? ` at ${apiHost()} (the saved session is for ${otherHost})` : ""}. Sign in: ${c.cyan(`${CMD} login`)}`);
    out();
    return 1;
  }
  const me = await fetchMe(creds);
  if (!me.ok) {
    if (me.status === 401) sessionGone();
    else err(`  ${c.red(sym.cross)} Could not reach ${apiHost()} (${me.reason}).`);
    out();
    return 1;
  }
  const a = me.account;
  row("Account", `${c.bold(accountLabel(a))}${a.github_login && a.email ? c.gray(` (GitHub ${a.github_login})`) : ""}${a.id ? c.gray(`  id ${a.id}`) : ""}`);
  row("Session", c.gray(`${path}${when(creds.created) ? `, signed in ${when(creds.created)}` : ""}`));
  out();
  out(`  ${c.bold("Apps")} ${c.gray(`(${me.projects.length})`)}`);
  if (!me.projects.length) out(`    None yet. In your app's folder: ${c.cyan(`${CMD} connect`)}`);
  const w = Math.min(28, Math.max(4, ...me.projects.map((p) => p.name.length)));
  for (const p of me.projects) {
    out(`    ${c.bold(p.name.padEnd(w))}  ${p.token}  ${c.gray((p.last_event ? `last event ${when(p.last_event)}` : "no events yet").padEnd(31))}  ${p.dashboard_url ? c.cyan(p.dashboard_url) : ""}`.trimEnd());
  }
  if (me.projects.length) out(`  ${c.gray(`Each app's dashboard is free: open its link above, or run ${CMD} dashboard in the app's folder.`)}`);
  out();
  return 0;
}

// ------------------------------------------------------------------------------------------------- dashboard

/** Prints a dashboard link with what it shows (FREE_LINES); --open also opens it. */
function showDashboard(o, link, notes = []) {
  out(`  ${c.bold("Your dashboard")}  ${c.bold(c.cyan(link))}`);
  for (const n of notes) out(`  ${n}`);
  for (const l of FREE_LINES) out(`  ${c.gray(l)}`);
  if (o.open && openBrowser(link, o)) out(`  ${c.gray("Opening it in your browser.")}`);
  out();
}

/**
 * The link to the free dashboard of the app in this folder: the private link in .genclass.local when it is this
 * app's (nothing is contacted), else the app's page in the signed-in account (one GET /api/me), else the account's
 * apps. Without either, how to get one. Exit 0 when a link was printed.
 */
async function dashboard(o) {
  banner("dashboard");
  hostNotice();
  const st = inspectProject(o);
  if (st.local?.dashboardUrl && (!st.token || st.local.token === st.token)) {
    showDashboard(o, st.local.dashboardUrl, [`${c.yellow("Keep this link private; it is the only way to open your dashboard.")} ${c.gray(`(from ${LOCAL_FILE})`)}`]);
    return 0;
  }
  const { creds } = readCredentialsFor();
  if (creds) {
    const me = await fetchMe(creds);
    if (!me.ok) {
      if (me.status === 401) sessionGone();
      else err(`  ${c.red(sym.cross)} Could not reach ${apiHost()} (${me.reason}).`);
      out();
      return 1;
    }
    const app = st.token ? me.projects.find((p) => p.token === st.token) : null;
    if (app?.dashboard_url) {
      showDashboard(o, app.dashboard_url, [c.gray(`${app.name}, in your GenClass account (${accountLabel(me.account)}): sign in at ${apiHost()} to open it.`)]);
      return 0;
    }
    if (st.token) out(`  This folder's project key (${st.token}) is not one of your account's apps; add it with ${c.cyan(`${CMD} connect`)}.`);
    out(`  ${c.bold("Your apps")}  ${c.bold(c.cyan(hostUrl("/account")))}`);
    if (!me.projects.length) out(`    None yet. In your app's folder: ${c.cyan(`${CMD} connect`)}`);
    const w = Math.min(28, Math.max(4, ...me.projects.map((p) => p.name.length)));
    for (const p of me.projects) out(`    ${c.bold(p.name.padEnd(w))}  ${p.dashboard_url ? c.cyan(p.dashboard_url) : ""}`.trimEnd());
    for (const l of FREE_LINES) out(`  ${c.gray(l)}`);
    if (o.open && openBrowser(hostUrl("/account"), o)) out(`  ${c.gray("Opening it in your browser.")}`);
    out();
    return st.token ? 1 : 0;
  }
  if (st.token) {
    out(`  This app's project key is ${st.token}. Its dashboard is in the GenClass account it belongs to`);
    out(`  (${c.cyan(hostUrl("/account"))}), or behind the private link you got with the key.`);
    out(`  Sign in to print its link here: ${c.cyan(`${CMD} login`)}`);
    out();
    return 1;
  }
  out(`  No GenClass project key in ${relative(process.cwd(), st.cwd) || "this folder"}. Get a free dashboard for this app: ${c.cyan(`${CMD} init`)}`);
  out(`  ${c.gray(`(or ${CMD} login, then ${CMD} connect, to keep it in a GenClass account)`)}`);
  out();
  return 1;
}

async function logout() {
  banner("logout");
  hostNotice();
  const { creds, otherHost, path } = readCredentialsFor();
  if (!creds) {
    if (otherHost) {
      out(`  The saved session is for ${otherHost}, not ${apiHost()}: unset GENCLASS_HOST to sign out there.`);
      out();
      return 1;
    }
    out(`  Not signed in: nothing to do.`);
    out();
    return 0;
  }
  const r = await revokeSession(creds);
  deleteCredentials();
  if (!r.ok) {
    err(`  ${c.yellow(sym.warn)} Could not end the session at ${apiHost()} (${r.reason}). ${path} is deleted.`);
    err(`  End it yourself at ${c.cyan(hostUrl("/account"))} (CLI sessions, Revoke).`);
    out();
    return 1;
  }
  row("Signed out", `${accountLabel(creds.account)} ${c.gray(`(the CLI session is ended at genclass.dev and ${path} is deleted)`)}`);
  out();
  return 0;
}

/** Entry from bin/genclass-runtime.mjs. Returns the exit code. */
export async function run(cmd, argv) {
  const h = hostConfig();
  if (h.error) {
    err(`genclass-runtime ${cmd}: ${h.error}`);
    return 2;
  }
  let o;
  try {
    o = parse(argv, SPECS[cmd]);
    if (o.app !== undefined && o.name !== undefined) throw new UsageError("--app and --name contradict each other (use an app, or create one)");
  } catch (e) {
    if (e instanceof UsageError) {
      err(`genclass-runtime ${cmd}: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (o.help) {
    out(USAGE);
    return 0;
  }
  if (cmd === "login") return login(o);
  if (cmd === "connect") return connect(o);
  if (cmd === "whoami") return whoami(o);
  if (cmd === "dashboard") return dashboard(o);
  return logout(o);
}
