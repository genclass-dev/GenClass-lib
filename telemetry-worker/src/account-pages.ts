// HTML for the account pages on genclass.dev: /signup, /login, /login/device, /account, the email-collision page a
// first Google sign-in can land on, and short message pages. Same shell, fonts, rules and tokens as the dashboard
// (src/pages.ts); no boxed cards, no gradients. Server-rendered text goes through esc(); scripts insert text with
// textContent. Every page is served under a per-response CSP nonce with form-action 'self' (for the sign-out form).
// Copy buttons use gcCopy (pages.ts): the Clipboard API, else the text is selected for the person to copy.

import { DASH_CSS, embed, esc, LOGO, shell, SIGNED_IN_NAV } from "./pages.js";

// --------------------------------------------------------------------------------------------- styles, icons

const ACCOUNT_CSS = `
code{font-family:var(--mono);font-size:.9em}
.eb{font:500 12.5px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--accent)}
.auth{max-width:440px;margin:0 auto;padding:44px 0 64px}
.auth>.logo{display:inline-flex;margin-bottom:52px}
.auth h1{font:700 clamp(28px,6vw,36px)/1.08 var(--display);letter-spacing:-.03em;margin-top:10px;text-wrap:balance}
.auth h2{font:600 16px var(--sans);letter-spacing:-.01em;margin:0}
.auth .lead{font-size:16px;line-height:1.55;color:var(--ink2);margin-top:12px}
.auth .ways{margin-top:30px;padding-top:24px;border-top:1px solid var(--ink);display:grid;gap:10px}
.btn{min-height:44px;font:500 15px var(--sans);padding:0 18px}
.btn.sm{min-height:32px;font-size:13.5px;padding:0 12px}
.btn.prov{width:100%;min-height:46px;gap:10px}
.btn.prov svg{width:18px;height:18px;flex:none}
.btn.paper{background:var(--paper);color:var(--ink);border-color:var(--ink)}
.btn.paper:hover{background:var(--panel)}
.btn.danger{background:transparent;color:var(--warn);border-color:var(--warn)}
.or{display:flex;align-items:center;gap:12px;font:500 12px var(--mono);color:var(--ink3);margin:8px 0}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--rule)}
.auth label,.acct-form label{display:block;font:500 12.5px var(--mono);color:var(--ink3);margin-bottom:7px}
.auth input,.acct-form input{min-height:44px;width:100%;padding:0 12px;border-radius:8px;border:1px solid var(--rule2);background:var(--paper);color:var(--ink);font:15px var(--sans)}
.auth input:focus-visible,.acct-form input:focus-visible{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.auth form{display:grid;gap:10px}
.hint{font-size:13px;line-height:1.5;color:var(--ink3)}
.err{font-size:14px;color:var(--warn);min-height:21px;margin-top:6px}
.err:empty{min-height:0;margin:0}
.swap{margin-top:30px;padding-top:18px;border-top:1px solid var(--rule);font-size:14.5px;color:var(--ink2)}
.swap a,.opt a,.auth p a{color:var(--ink)}
.opt{margin-top:10px;font-size:13px;line-height:1.5;color:var(--ink3)}
.detail{margin-top:14px;font:12.5px var(--mono);color:var(--ink3);overflow-wrap:anywhere}
.notice{margin-top:22px;padding:12px 0;border-top:1px solid var(--ink);border-bottom:1px solid var(--rule);font-size:14.5px;color:var(--ink2)}
.notice b{font-weight:600;color:var(--ink)}
.auth .notice{border:0;padding:0;margin-top:16px;color:var(--ink)}
.notice.n-ok b{color:var(--accent)}
.notice.n-bad b{color:var(--warn)}
.caution{margin-top:22px;padding:12px 0 12px 14px;border-left:3px solid var(--warn);font-size:14.5px;line-height:1.5;color:var(--ink2)}
.caution b{color:var(--warn);font-weight:600}
.ucode{font:500 clamp(36px,10vw,50px)/1 var(--mono);letter-spacing:.06em;margin-top:26px;font-variant-numeric:tabular-nums;white-space:nowrap}
dl.req{display:grid;grid-template-columns:minmax(110px,auto) minmax(0,1fr);border-top:1px solid var(--ink);margin-top:24px}
dl.req dt,dl.req dd{padding:11px 0;border-bottom:1px solid var(--rule);font-size:14.5px;min-width:0;overflow-wrap:anywhere}
dl.req dt{font:500 12.5px var(--mono);color:var(--ink3);padding-top:13px;padding-right:16px}
.acts{display:flex;gap:10px;margin-top:22px}
.acts .btn{flex:1}
.step{margin-top:26px;padding-top:18px;border-top:1px solid var(--rule);display:grid;gap:10px;justify-items:start}
.step p{font-size:14.5px;color:var(--ink2)}
.done{margin-top:22px;font-size:15px}
.done b{color:var(--accent);font-weight:600}
.acct-form{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-top:20px;max-width:680px}
.acct-form .f{flex:1 1 260px;min-width:0}
.blk p.intro{font-size:14.5px;color:var(--ink2);margin-top:14px;max-width:70ch}
table.dt td.name{white-space:normal;max-width:28ch;overflow-wrap:anywhere}
table.dt td.pkey{font:13px var(--mono)}
table.dt td.pkey .btn{margin-left:8px}
table.dt td .btn.sm{min-height:30px}
table.dt td.act{text-align:right}
table.dt td a{color:var(--ink)}
table.dt td .tag{font:500 12px var(--mono);color:var(--accent);margin-left:8px}
.mainc .dh .eb{margin-bottom:10px}
.who{font:12.5px var(--mono);color:var(--ink3);margin-top:12px;overflow-wrap:anywhere}
@media (max-width:920px){.side.acct{display:none}}
@media (max-width:600px){
  table.dt.rows thead{display:none}
  table.dt.rows tr{display:block;padding:12px 0;border-bottom:1px solid var(--rule)}
  table.dt.rows td{display:block;border:0;padding:3px 0;white-space:normal;overflow-wrap:anywhere;max-width:none}
  table.dt.rows td:first-child{font-weight:600}
  table.dt.rows td:empty{display:none}
  table.dt.rows td[data-l]::before{content:attr(data-l) " ";font:500 12px var(--mono);color:var(--ink3)}
  table.dt.rows td.act{text-align:left;padding-top:8px}
}
`;

const GOOGLE_G =
  '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
const GITHUB_MARK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
const KEY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4"/><path d="M10.5 12.5L20 3M16 7l3 3M13.5 9.5l2 2"/></svg>';

// --------------------------------------------------------------------------------------------- client scripts

/** Shared by the pages: JSON POST with the page's Origin, base64url helpers, the passkey ceremonies, error wording. */
const CLIENT_JS = `
function gcPost(url, body, method){
  return fetch(url, { method: method || "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(function(r){
      if (r.status === 204) return {};
      return r.json().catch(function(){ return {}; }).then(function(j){
        if (!r.ok) { var e = new Error((j && j.error) || ("HTTP " + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
}
function b2u(buf){ var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); }
function u2b(s){ s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer; }
function gcPasskeys(){ return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); }
function gcRegister(email){
  return gcPost("/api/auth/passkey/register/options", email ? { email: email } : {}).then(function(o){
    var pk = o.publicKey; pk.challenge = u2b(pk.challenge); pk.user.id = u2b(pk.user.id);
    (pk.excludeCredentials || []).forEach(function(c){ c.id = u2b(c.id); });
    return navigator.credentials.create({ publicKey: pk }).then(function(cred){
      var r = cred.response;
      return gcPost("/api/auth/passkey/register/verify", { id: o.id, credential: { id: cred.id, rawId: b2u(cred.rawId), type: cred.type,
        response: { clientDataJSON: b2u(r.clientDataJSON), attestationObject: b2u(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } } });
    });
  });
}
function gcLogin(){
  return gcPost("/api/auth/passkey/login/options", {}).then(function(o){
    var pk = o.publicKey; pk.challenge = u2b(pk.challenge);
    return navigator.credentials.get({ publicKey: pk }).then(function(cred){
      var r = cred.response;
      return gcPost("/api/auth/passkey/login/verify", { id: o.id, credential: { id: cred.id, rawId: b2u(cred.rawId), type: cred.type,
        response: { clientDataJSON: b2u(r.clientDataJSON), authenticatorData: b2u(r.authenticatorData), signature: b2u(r.signature), userHandle: r.userHandle ? b2u(r.userHandle) : null } } });
    });
  });
}
function gcWhy(e){
  if (e && e.name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again when you are ready.";
  if (e && e.name === "InvalidStateError") return "This device already holds a passkey for this account.";
  if (e && e.name === "SecurityError") return "Passkeys only work on " + location.hostname + " over HTTPS.";
  if (e && e.status === 429) return "Too many attempts from your network. Try again in a minute.";
  var m = (e && e.message) || "Something went wrong. Try again.";
  return m.charAt(0).toUpperCase() + m.slice(1) + (/[.]$/.test(m) ? "" : ".");
}
function gcBusy(b, on, label){ if (!b) return; if (on) { b.dataset.l = b.textContent; b.disabled = true; b.lastChild.textContent = label; } else { b.disabled = false; b.lastChild.textContent = b.dataset.l ? b.dataset.l.trim() : b.lastChild.textContent; } }
function gcTimes(){
  document.querySelectorAll("time[data-f]").forEach(function(t){
    var d = new Date(t.getAttribute("datetime")); if (isNaN(d)) return;
    var f = t.getAttribute("data-f");
    if (f === "ago") {
      var s = (Date.now() - d.getTime()) / 1000;
      t.textContent = s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + " min ago" : s < 129600 ? Math.round(s / 3600) + " h ago" : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    } else if (f === "time") t.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    else t.textContent = d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    t.title = d.toLocaleString();
  });
}
/** A notice from the query string (?signed_out=1, ?linked=...) is shown once: reloading does not bring it back. */
function gcDropQuery(keep){
  try {
    var q = new URLSearchParams(location.search), out = new URLSearchParams();
    (keep || []).forEach(function(k){ if (q.has(k)) out.set(k, q.get(k)); });
    var s = out.toString();
    if (s !== q.toString()) history.replaceState(null, "", location.pathname + (s ? "?" + s : "") + location.hash);
  } catch (e) {}
}
/** Two clicks for a destructive button: the first asks, the second (within 6 s) does it. */
function gcArm(b, label){
  if (b.getAttribute("data-armed") === "1") return true;
  var was = b.textContent; b.setAttribute("data-armed", "1"); b.textContent = label;
  setTimeout(function(){ if (!b.disabled) { b.setAttribute("data-armed", "0"); b.textContent = was; } }, 6000);
  return false;
}
gcTimes();
`;

// --------------------------------------------------------------------------------------------- helpers

/** <time> with a UTC fallback; the page script rewrites it in local time ("ago", "date" or "time"). */
function time(iso: string | null, f: "ago" | "date" | "time" = "date", empty = "never"): string {
  if (!iso) return `<span class="muted">${empty}</span>`;
  const fallback = f === "time" ? `${iso.slice(11, 16)} UTC` : iso.slice(0, 10);
  return `<time datetime="${esc(iso)}" data-f="${f}">${esc(fallback)}</time>`;
}

const q = (next: string | null): string => (next ? `?next=${encodeURIComponent(next)}` : "");

function providerButtons(p: { google: boolean; github: boolean }, next: string | null): string {
  const out: string[] = [];
  if (p.google) out.push(`<a class="btn prov paper" href="/auth/google${q(next)}">${GOOGLE_G}<span>Continue with Google</span></a>`);
  if (p.github) out.push(`<a class="btn prov ghost" href="/auth/github${q(next)}">${GITHUB_MARK}<span>Continue with GitHub</span></a>`);
  return out.join("\n");
}

function authPage(nonce: string, title: string, inner: string, script: string): string {
  return shell(nonce, title, `<style nonce="${nonce}">${DASH_CSS}${ACCOUNT_CSS}</style><div class="auth">${LOGO}${inner}</div>`, CLIENT_JS + script, { bare: true, account: true });
}

export interface AuthPageOptions {
  google: boolean;
  github: boolean;
  /** Where to go after signing in (already checked by safeNext). */
  next: string | null;
  /** A fixed message to show above the options (never text from the request). */
  notice?: string | null;
}

const OPTIONAL =
  '<p class="opt">An account is optional. GenClass runs without one, and <a href="/start">genclass.dev/start</a> still gives an app a key and a private dashboard link.</p>';

/** The passkey sign-in button's script: sign in, then go to `next` (or reload, on the device page). */
const PASSKEY_LOGIN_JS = `
function gcPasskeyButton(b, err, then){
  if (!b) return;
  if (!gcPasskeys()) { b.disabled = true; err.textContent = "This browser does not support passkeys." + (document.querySelector(".prov[href]") ? " Use Google or GitHub instead." : ""); return; }
  b.addEventListener("click", function(){
    err.textContent = ""; gcBusy(b, true, "Waiting for your passkey...");
    gcLogin().then(then, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
  });
}`;

// --------------------------------------------------------------------------------------------- /login, /signup

export function loginPage(nonce: string, o: AuthPageOptions): string {
  const providers = providerButtons(o, o.next);
  const inner = `
<h1>Sign in to GenClass</h1>
<p class="lead">Your account keeps your apps' dashboards in one place: what GenClass detected, on which pages, and what it did.</p>
${o.notice ? `<p class="notice" role="status">${esc(o.notice)}</p>` : ""}
<div class="ways">
${providers}
${providers ? '<div class="or">or</div>' : ""}
<button class="btn prov ${providers ? "ghost" : ""}" id="pk" type="button">${KEY_ICON}<span>Sign in with a passkey</span></button>
<p class="hint">Touch ID, Windows Hello, your phone or a security key. No email or password.</p>
<p class="err" id="err" role="alert"></p>
</div>
<p class="swap"><a href="/signup${q(o.next)}">Create an account instead</a></p>
${OPTIONAL}
<script type="application/json" id="cfg">${embed({ next: o.next })}</script>`;
  const script = `${PASSKEY_LOGIN_JS}
(function(){
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  gcDropQuery(["next"]);
  gcPasskeyButton(document.getElementById("pk"), document.getElementById("err"), function(){ location.href = cfg.next || "/account"; });
})();`;
  return authPage(nonce, "Sign in | GenClass", inner, script);
}

export function signupPage(nonce: string, o: AuthPageOptions): string {
  const providers = providerButtons(o, o.next);
  const inner = `
<h1>Create your GenClass account</h1>
<p class="lead">Your account keeps your apps' dashboards in one place, and lets <code>npx @genclass/runtime login</code> connect an app for you.</p>
<div class="ways">
${providers}
${providers ? '<div class="or">or with a passkey</div>' : ""}
<form id="f" novalidate>
  <div><label for="email">Email</label>
  <input id="email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com" required></div>
  <p class="hint">Your passkey is named after it, and we use it only for notices about your account. We do not check it, so nothing is sent to it now.</p>
  <button class="btn prov ${providers ? "ghost" : ""}" id="go" type="submit">${KEY_ICON}<span>Create account with a passkey</span></button>
</form>
<p class="err" id="err" role="alert"></p>
</div>
<p class="swap"><a href="/login${q(o.next)}">Sign in instead</a></p>
${OPTIONAL}
<script type="application/json" id="cfg">${embed({ next: o.next })}</script>`;
  const script = `
(function(){
  var cfg = JSON.parse(document.getElementById("cfg").textContent), f = document.getElementById("f"), b = document.getElementById("go"), err = document.getElementById("err");
  if (!gcPasskeys()) { b.disabled = true; err.textContent = "This browser does not support passkeys." + (document.querySelector(".prov[href]") ? " Use Google or GitHub instead." : ""); return; }
  f.addEventListener("submit", function(ev){
    ev.preventDefault(); err.textContent = "";
    var email = document.getElementById("email").value.trim();
    if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s.]+$/.test(email)) { err.textContent = "Enter a valid email address."; return; }
    gcBusy(b, true, "Waiting for your passkey...");
    gcRegister(email).then(function(){ location.href = cfg.next || "/account?welcome=1"; }, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
  });
})();`;
  return authPage(nonce, "Create an account | GenClass", inner, script);
}

// --------------------------------------------------------------------------------------------- email collision

export function pendingPage(nonce: string, o: { email: string; provider: "google" | "github" }): string {
  const name = o.provider === "google" ? "Google" : "GitHub";
  const inner = `
<h1>This email already has a GenClass account</h1>
<p class="lead">${name} signed you in as <b>${esc(o.email)}</b>. A GenClass account with that address already exists. We never join accounts because their emails match: an email typed at passkey sign-up is not verified, so anyone could have typed it.</p>
<div class="step">
  <h2>If that account is yours</h2>
  <p>Sign in to it with its passkey, then choose Link ${name} on your account page. After that, Continue with ${name} opens that account.</p>
  <a class="btn" href="/login?next=%2Faccount">Sign in with a passkey</a>
</div>
<div class="step">
  <h2>If it is not yours</h2>
  <p>Create a separate account for this ${name} sign-in. The other account is not touched.</p>
  <button class="btn ghost" id="create" type="button"><span>Create a separate account</span></button>
  <p class="err" id="err" role="alert"></p>
</div>`;
  const script = `
(function(){
  var b = document.getElementById("create"), err = document.getElementById("err");
  b.addEventListener("click", function(){
    err.textContent = ""; gcBusy(b, true, "Creating...");
    gcPost("/api/auth/pending", {}).then(function(j){ location.href = j.next || "/account?welcome=1"; }, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
  });
})();`;
  return authPage(nonce, "New account | GenClass", inner, script);
}

// --------------------------------------------------------------------------------------------- messages

/** A short page: a title, one plain sentence, links. `detail` is a small mono line for whoever needs the exact reason. */
export function messagePage(nonce: string, o: { title: string; text: string; links: [string, string][]; detail?: string }): string {
  const links = o.links.map(([label, href], i) => `<a class="btn ${i ? "ghost" : ""}" href="${esc(href)}">${esc(label)}</a>`).join(" ");
  const detail = o.detail ? `<p class="detail">${esc(o.detail)}</p>` : "";
  return authPage(nonce, `${o.title} | GenClass`, `<h1>${esc(o.title)}</h1><p class="lead">${esc(o.text)}</p>${links ? `<div class="acts">${links}</div>` : ""}${detail}`, "");
}

export function appNotFoundPage(nonce: string): string {
  return messagePage(nonce, { title: "App not found", text: "This app does not exist, or it belongs to another account.", links: [["Your apps", "/account"]] });
}

// --------------------------------------------------------------------------------------------- /login/device

export interface DeviceView {
  signedIn: { email: string | null; githubLogin: string | null } | null;
  /** The normalised code from ?code=, or null when absent or malformed. */
  code: string | null;
  /** Whether ?code= was present at all (to tell "no code yet" from "bad code"). */
  typed: boolean;
  /**
   * The pending request for that code (looked up only for a signed-in visitor), or null when unknown, expired, used,
   * or when nobody is signed in. `client` is the CLI's own name, or null when the request did not give one we show.
   */
  request: { userCode: string; client: string | null; created: string; expires: string } | null;
  /** This page with its code, for sign-in links. */
  next: string;
  providers: { google: boolean; github: boolean };
}

const RUN = "<code>npx @genclass/runtime login</code>";

export function devicePage(nonce: string, v: DeviceView): string {
  const entry = `
<form id="cf" novalidate>
  <div><label for="code">Code from your terminal</label>
  <input id="code" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="BCDF-GHJK"></div>
  <button class="btn" type="submit"><span>Continue</span></button>
</form>
<p class="err" id="err" role="alert"></p>`;
  let inner: string;
  if (!v.signedIn && v.code) {
    // Signed out: the same page for every well-formed code, live or not. Whether it is live shows after sign-in.
    const providers = providerButtons(v.providers, v.next);
    inner = `
<div class="eb">Command line sign-in</div>
<h1>Sign in to continue</h1>
<div class="ucode" aria-label="Code">${esc(v.code)}</div>
<p class="lead">Check that your terminal shows this code, then sign in. This page then shows the request and asks you to approve or deny it.</p>
<div class="ways">
${providers}
<button class="btn prov ${providers ? "ghost" : ""}" id="pk" type="button">${KEY_ICON}<span>Sign in with a passkey</span></button>
<p class="err" id="err" role="alert"></p>
</div>
<p class="swap"><a href="/signup${q(v.next)}">Create an account instead</a>, then come back here.</p>`;
  } else if (!v.request) {
    const bad = v.typed && (!v.code || !!v.signedIn);
    inner = `
<div class="eb">Command line sign-in</div>
<h1>${bad ? (v.code ? "This code is not valid" : "This is not a sign-in code") : "Connect your terminal"}</h1>
<p class="lead">${
      bad
        ? `${v.code ? "It has expired, was already used, or was mistyped." : "Codes have 8 letters, like BCDF-GHJK."} Codes last 10 minutes. Run ${RUN} again for a new one, or type the code below.`
        : `Run ${RUN} in your project folder. It opens this page with its code; you can also type the code here.`
    }</p>
<div class="ways">${entry}</div>`;
  } else {
    const r = v.request;
    const s = v.signedIn!;
    const who = esc(s.email ?? (s.githubLogin ? `@${s.githubLogin} on GitHub` : "your account"));
    inner = `
<div class="eb">Command line sign-in</div>
<h1 id="dh">Approve this sign-in</h1>
<div class="ucode" aria-label="Code">${esc(r.userCode)}</div>
<dl class="req">
  <dt>Requested by</dt><dd>${r.client ? `${esc(r.client)} <span class="muted">(as the command line reported itself)</span>` : 'Unknown client <span class="muted">(it did not name itself as the GenClass command line)</span>'}</dd>
  <dt>Requested</dt><dd>${time(r.created, "time")} · ${time(r.created, "ago")}</dd>
  <dt>Code expires</dt><dd id="exp">${time(r.expires, "time")}</dd>
  <dt>Account</dt><dd>${who}</dd>
</dl>
<p class="lead" id="scope">If you approve, the terminal that shows this code can list the apps in this account, create apps, add an app from its private dashboard link, and write a project key into your project, for 90 days or until you revoke it on your account page. It cannot read your apps' stats or change how you sign in.</p>
<p class="caution" id="caution"><b>Approve only a sign-in you started.</b> If you did not run ${RUN} yourself just now, or someone sent you this link or code, choose Deny.</p>
<div class="acts" id="acts"><button class="btn" id="yes" type="button"><span>Approve</span></button><button class="btn ghost" id="no" type="button"><span>Deny</span></button></div>
<p class="err" id="err" role="alert"></p>
<p class="done hidden" id="done" role="status"></p>
<script type="application/json" id="cfg">${embed({ code: r.userCode, expires: r.expires })}</script>`;
  }
  const script = `${PASSKEY_LOGIN_JS}
(function(){
  var cf = document.getElementById("cf");
  if (cf) cf.addEventListener("submit", function(ev){
    ev.preventDefault();
    var s = document.getElementById("code").value.toUpperCase().replace(/[^A-Z]/g, "");
    if (s.length !== 8) { document.getElementById("err").textContent = "The code has 8 letters, like BCDF-GHJK."; return; }
    location.href = "/login/device?code=" + s.slice(0, 4) + "-" + s.slice(4);
  });
  // signed out: sign in here and come back to this page, which then shows the request
  gcPasskeyButton(document.getElementById("pk"), document.getElementById("err"), function(){ location.reload(); });
  var yes = document.getElementById("yes"), no = document.getElementById("no");
  if (!yes) return;
  var cfg = JSON.parse(document.getElementById("cfg").textContent), err = document.getElementById("err"), done = document.getElementById("done");
  var h = document.getElementById("dh"), acts = document.getElementById("acts"), timer = null;
  function finish(title, text){
    if (timer) clearTimeout(timer);
    h.textContent = title; acts.classList.add("hidden"); err.textContent = "";
    ["caution", "scope"].forEach(function(id){ document.getElementById(id).classList.add("hidden"); });
    done.classList.remove("hidden"); done.textContent = text;
  }
  function gone(){ finish("This code is no longer valid", "It expired or was already used. Run npx @genclass/runtime login again for a new code."); }
  var left = Date.parse(cfg.expires) - Date.now();
  if (left > 0 && left < 3600000) timer = setTimeout(gone, left);
  function answer(ok){
    err.textContent = ""; yes.disabled = true; no.disabled = true;
    gcPost("/api/device/approve", { user_code: cfg.code, approve: ok }).then(function(){
      if (ok) finish("Approved", "Go back to your terminal; it finishes on its own. You can close this tab.");
      else finish("Denied", "The terminal stops waiting and signs nothing in.");
    }, function(e){
      if (e.status === 404) { gone(); return; }
      err.textContent = gcWhy(e); yes.disabled = false; no.disabled = false;
    });
  }
  yes.addEventListener("click", function(){ answer(true); });
  no.addEventListener("click", function(){ answer(false); });
})();`;
  if (v.signedIn) {
    return shell(nonce, "Command line sign-in | GenClass", `<style nonce="${nonce}">${DASH_CSS}${ACCOUNT_CSS}</style><div class="auth">${inner}</div>`, CLIENT_JS + script, { nav: SIGNED_IN_NAV, account: true });
  }
  return authPage(nonce, "Command line sign-in | GenClass", inner, script);
}

// --------------------------------------------------------------------------------------------- /account

export interface SessionRow {
  id: string;
  label: string;
  created: string;
  expires: string;
  lastUsed: string | null;
  /** the session this page was requested with */
  current: boolean;
}

export interface AccountView {
  account: { id: string; email: string | null; emailVerified: boolean; google: boolean; githubLogin: string | null; created: string };
  projects: { id: string; name: string; token: string; dashboard_url: string; created: string; last_event: string | null; first_event: string | null; privateLink: boolean }[];
  passkeys: { id: string; created: string; lastUsed: string | null; transports: string[] }[];
  /** Browser sessions, then terminal (CLI) sessions, newest first. */
  web: SessionRow[];
  cli: SessionRow[];
  providers: { google: boolean; github: boolean };
  notice?: { kind: "ok" | "bad"; text: string };
}

const TRANSPORT_WORDS: Record<string, string> = {
  internal: "this device",
  hybrid: "a phone",
  usb: "a USB key",
  nfc: "an NFC key",
  ble: "a Bluetooth key",
  "smart-card": "a smart card",
};

export function accountPage(nonce: string, v: AccountView): string {
  const a = v.account;
  const who = a.email ? `${esc(a.email)}${a.emailVerified ? " (verified by Google)" : ""}` : a.githubLogin ? `@${esc(a.githubLogin)} on GitHub` : "No email";
  const appsNav = v.projects.map((p) => `<a href="/account/apps/${esc(p.id)}">${esc(p.name)}</a>`).join("");
  const apps = v.projects.length
    ? `<div class="tablewrap"><table class="dt rows"><thead><tr><th>Name</th><th>Project API key</th><th>Last event</th><th>Private link</th><th></th></tr></thead><tbody>
${v.projects
  .map(
    (p) =>
      `<tr><td class="name"><a href="/account/apps/${esc(p.id)}">${esc(p.name)}</a></td>` +
      `<td class="pkey"><code>${esc(p.token)}</code><button class="btn sm ghost" type="button" data-copy="${esc(p.token)}" aria-label="Copy the project API key of ${esc(p.name)}">Copy</button></td>` +
      `<td data-l="Last event">${time(p.last_event, "ago", "waiting for the first event")}</td>` +
      `<td data-l="Private link">${p.privateLink ? `opens it <button class="btn sm ghost" type="button" data-linkoff="${esc(p.id)}" aria-label="Turn off the private dashboard link of ${esc(p.name)}">Turn off</button>` : '<span class="muted">none</span>'}</td>` +
      `<td class="act"><a href="/account/apps/${esc(p.id)}">Open dashboard →</a></td></tr>`,
  )
  .join("\n")}
</tbody></table></div>`
    : '<p class="quiet">No apps yet. Create one below, or add a dashboard you already have.</p>';

  const keyRows = v.passkeys
    .map((k, i) => {
      const where = k.transports.map((t) => TRANSPORT_WORDS[t]).filter(Boolean);
      return `<tr><td>Passkey ${i + 1}</td><td>${where.length ? `on ${esc(where.join(", "))}` : '<span class="muted">-</span>'}</td><td data-l="Added">${time(k.created)}</td><td data-l="Last used">${time(k.lastUsed, "ago")}</td><td class="act"><button class="btn sm ghost" type="button" data-rmkey="${esc(k.id)}" aria-label="Remove passkey ${i + 1}">Remove</button></td></tr>`;
    })
    .join("\n");
  const google = v.providers.google || a.google
    ? `<tr><td>Google</td><td>${a.google ? "Linked" : '<span class="muted">Not linked</span>'}</td><td></td><td></td><td class="act">${a.google ? "" : '<a class="btn sm ghost" href="/auth/google?link=1">Link Google</a>'}</td></tr>`
    : "";
  const github = v.providers.github || a.githubLogin
    ? `<tr><td>GitHub</td><td>${a.githubLogin ? `Linked as @${esc(a.githubLogin)}` : '<span class="muted">Not linked</span>'}</td><td></td><td></td><td class="act">${a.githubLogin ? "" : '<a class="btn sm ghost" href="/auth/github?link=1">Link GitHub</a>'}</td></tr>`
    : "";

  const sessionRow = (s: SessionRow, kind: "web" | "cli", i: number): string => {
    const name = kind === "web" ? (s.current ? "This browser" : `Browser ${i + 1}`) : s.label;
    const act = s.current
      ? '<form method="post" action="/logout"><button class="btn sm ghost" type="submit">Sign out</button></form>'
      : `<button class="btn sm ghost" type="button" data-revoke="${esc(s.id)}" aria-label="Revoke ${esc(name)}, signed in ${esc(s.created.slice(0, 10))}">Revoke</button>`;
    return `<tr><td>${esc(name)}${s.current ? '<span class="tag">current</span>' : ""}</td><td data-l="Signed in">${time(s.created)}</td><td data-l="Last used">${time(s.lastUsed, "ago")}</td><td data-l="Expires">${time(s.expires)}</td><td class="act">${act}</td></tr>`;
  };
  const sessions = (rows: SessionRow[], kind: "web" | "cli") =>
    `<div class="tablewrap"><table class="dt rows"><thead><tr><th>${kind === "web" ? "Browser" : "Terminal"}</th><th>Signed in</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>
${rows.map((s, i) => sessionRow(s, kind, i)).join("\n")}
</tbody></table></div>`;
  const cli = v.cli.length
    ? sessions(v.cli, "cli")
    : '<p class="quiet">No terminal is signed in. Run <code>npx @genclass/runtime login</code> in a project folder to sign one in.</p>';
  const others = v.web.filter((s) => !s.current).length + v.cli.length;

  const body = `
<style nonce="${nonce}">${DASH_CSS}${ACCOUNT_CSS}</style>
<div class="app">
<aside class="side acct" aria-label="Account">
  <div class="proj">Account<small>${who}</small></div>
  <div class="grp">Your apps</div>
  <nav class="apps" aria-label="Your apps">${appsNav}<a class="new" href="#new-app">New app</a></nav>
  <div class="grp">Account</div>
  <div class="out"><a href="#signin">Sign-in methods</a><a href="#sessions">Sessions</a><a href="#delete">Delete account</a><form method="post" action="/logout"><button class="lnk" type="submit">Sign out</button></form></div>
</aside>
<div class="mainc" id="mc" tabindex="-1">
<section class="dh" id="top">
  <div class="eb">Account</div>
  <h1>Your apps</h1>
  <p class="who">Signed in as ${who} · account since ${time(a.created)} · id ${esc(a.id)}</p>
</section>
${v.notice ? `<p class="notice n-${v.notice.kind}" role="status"><b>${v.notice.kind === "ok" ? "Done." : "Not changed."}</b> ${esc(v.notice.text)}</p>` : ""}
<section class="blk" id="apps">
  <div class="blk-h"><h2>Apps</h2><span class="aside">Table 1. Apps in this account</span></div>
  ${apps}
  <form class="acct-form" id="new-app" novalidate>
    <div class="f"><label for="appname">New app</label><input id="appname" type="text" maxlength="80" autocomplete="off" placeholder="App name, e.g. Acme checkout"></div>
    <button class="btn" type="submit" id="newgo"><span>Create app</span></button>
  </form>
  <p class="err" id="newerr" role="alert"></p>
  <p class="err" id="linkerr" role="alert"></p>
</section>
<section class="blk" id="claim">
  <div class="blk-h"><h2>Add an existing dashboard</h2><span class="aside">From genclass.dev/start or <code>npx @genclass/runtime init</code></span></div>
  <p class="intro">Paste the app's private dashboard link. The app joins this account and keeps its key, so nothing changes in its code. The link keeps working for anyone who already has it until you turn it off in the table above.</p>
  <form class="acct-form" id="claimf" novalidate>
    <div class="f"><label for="link">Dashboard link</label><input id="link" type="text" autocomplete="off" spellcheck="false" placeholder="https://genclass.dev/dashboard/..."></div>
    <button class="btn ghost" type="submit" id="claimgo"><span>Add to account</span></button>
  </form>
  <p class="err" id="claimerr" role="alert"></p>
</section>
<section class="blk" id="signin">
  <div class="blk-h"><h2>Sign-in methods</h2><span class="aside">Table 2. Ways into this account</span></div>
  <div class="tablewrap"><table class="dt rows"><thead><tr><th>Method</th><th>Details</th><th>Added</th><th>Last used</th><th></th></tr></thead><tbody>
  ${keyRows}
  ${google}
  ${github}
  </tbody></table></div>
  <p class="intro">Removing a passkey also signs out every other browser and terminal, in case one of them is where it was used.</p>
  <div class="acct-form"><button class="btn ghost" type="button" id="addpk"><span>Add a passkey</span></button></div>
  <p class="err" id="pkerr" role="alert"></p>
</section>
<section class="blk" id="sessions">
  <div class="blk-h"><h2>Sessions</h2><span class="aside">Table 3. Browsers signed in to this account</span></div>
  ${sessions(v.web, "web")}
  <div class="blk-h mt-l" id="cli"><h2>Terminals</h2><span class="aside">Table 4. Signed in with <code>npx @genclass/runtime login</code></span></div>
  ${cli}
  ${others ? '<div class="acct-form"><button class="btn ghost" type="button" id="others"><span>Sign out everywhere else</span></button></div>' : ""}
  <p class="err" id="clierr" role="alert"></p>
</section>
<section class="blk" id="delete">
  <div class="blk-h"><h2>Delete account</h2><span class="aside">Cannot be undone</span></div>
  <p class="intro">Deletes this account, its passkeys and its sessions. Apps created in the account are deleted with their stats. Apps that still have a private dashboard link leave the account and keep working through that link.</p>
  <div class="acct-form"><button class="btn danger" type="button" id="del"><span>Delete account</span></button></div>
  <p class="err" id="delerr" role="alert"></p>
</section>
<footer class="dfoot">Your account stores your email (as you typed it, or as Google returned it) and whether it is verified, your passkeys'
public keys, your Google account id and your GitHub id and login if you link them, your sign-in sessions, and the apps you own. Nothing
else. <a href="https://genclass.dev/privacy">Privacy</a> · <a href="https://genclass.dev/terms">Terms</a></footer>
</div>
</div>`;

  const script = `
(function(){
  gcDropQuery([]);
  function form(id, btnId, errId, url, field, key){
    var f = document.getElementById(id), b = document.getElementById(btnId), err = document.getElementById(errId);
    f.addEventListener("submit", function(ev){
      ev.preventDefault(); err.textContent = "";
      var body = {}; body[key] = document.getElementById(field).value;
      gcBusy(b, true, "Working...");
      gcPost(url, body).then(function(j){ location.href = "/account/apps/" + encodeURIComponent(j.project.id); }, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
    });
  }
  form("new-app", "newgo", "newerr", "/api/account/projects", "appname", "name");
  form("claimf", "claimgo", "claimerr", "/api/account/projects/claim", "link", "dashboard_url");
  document.querySelectorAll("[data-copy]").forEach(function(b){
    b.addEventListener("click", function(){ gcCopy(b, b.getAttribute("data-copy"), b.previousElementSibling); });
  });
  function del(sel, attr, url, errId, confirmLabel, after){
    document.querySelectorAll(sel).forEach(function(b){
      b.addEventListener("click", function(){
        if (confirmLabel && !gcArm(b, confirmLabel)) return;
        b.disabled = true;
        gcPost(url(b.getAttribute(attr)), undefined, "DELETE").then(after || function(){ location.reload(); }, function(e){ document.getElementById(errId).textContent = gcWhy(e); b.disabled = false; });
      });
    });
  }
  del("[data-revoke]", "data-revoke", function(id){ return "/api/account/sessions/" + encodeURIComponent(id); }, "clierr", null);
  del("[data-rmkey]", "data-rmkey", function(id){ return "/api/account/credentials/" + encodeURIComponent(id); }, "pkerr", "Confirm: remove and sign out elsewhere");
  del("[data-linkoff]", "data-linkoff", function(id){ return "/api/account/projects/" + encodeURIComponent(id) + "/link"; }, "linkerr", "Confirm: the link stops working");
  var others = document.getElementById("others");
  if (others) others.addEventListener("click", function(){
    if (!gcArm(others, "Confirm: sign out the others")) return;
    others.disabled = true;
    gcPost("/api/account/sessions/others", undefined, "DELETE").then(function(){ location.reload(); }, function(e){ document.getElementById("clierr").textContent = gcWhy(e); others.disabled = false; });
  });
  var delb = document.getElementById("del");
  delb.addEventListener("click", function(){
    if (!gcArm(delb, "Confirm: delete this account for good")) return;
    delb.disabled = true;
    gcPost("/api/account", { confirm: "delete" }, "DELETE").then(function(){ location.href = "/login?deleted=1"; }, function(e){ document.getElementById("delerr").textContent = gcWhy(e); delb.disabled = false; });
  });
  var add = document.getElementById("addpk"), pkerr = document.getElementById("pkerr");
  add.addEventListener("click", function(){
    pkerr.textContent = "";
    if (!gcPasskeys()) { pkerr.textContent = "This browser does not support passkeys."; return; }
    gcBusy(add, true, "Waiting for your passkey...");
    gcRegister().then(function(){ location.reload(); }, function(e){ pkerr.textContent = gcWhy(e); gcBusy(add, false); });
  });
})();`;
  return shell(nonce, "Account | GenClass", body, CLIENT_JS + script, { nav: SIGNED_IN_NAV, account: true, skip: "mc" });
}
