// HTML for the account pages on genclass.dev: /signup, /login, /login/forgot, /login/passkey (the passkey step after a
// password, Google or GitHub for an account with a passkey), /login/device, /account, the email-collision page a first
// Google sign-in can land on, and short message pages. Sign-in leads with Continue with Google, then an email and a
// password (always there), then a small Continue with GitHub and Use a passkey; a passkey is extra security, added on
// /account. Same shell, fonts, rules and tokens as the dashboard (src/pages.ts, the black palette and buttons of
// genclass.dev, whatever the visitor's system theme); no boxed cards, no gradients. The sign-in column sits on the
// left of genclass.dev's self-healing sphere (site/public/signin-mesh.js, the /admin sign-in's backdrop). Server-rendered text
// goes through esc(); scripts insert text with textContent. Every page is served under a per-response CSP nonce with
// form-action 'self' (for the sign-out form).
// Copy buttons use gcCopy (pages.ts): the Clipboard API, else the text is selected for the person to copy.

import { DASH_CSS, embed, esc, LOGO, RUNTIME_PKG, shell, SIGNED_IN_NAV } from "./pages.js";

// --------------------------------------------------------------------------------------------- styles, icons

export const ACCOUNT_CSS = `
code{font-family:var(--mono);font-size:.9em}
.eb{font:500 12.5px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--accent)}
.auth{max-width:440px;margin:0 auto;padding:44px 0 64px}
.auth>.logo{display:inline-flex;margin-bottom:44px}
.auth h1{font:500 clamp(28px,5vw,34px)/1.15 var(--display);letter-spacing:-.04em;margin-top:10px;text-wrap:balance}
.auth h2{font:500 16px var(--sans);letter-spacing:-.015em;margin:0}
/* the sign-in pages (shell option mesh): the column on the left, genclass.dev's self-healing sphere on the right */
body.mesh{isolation:isolate}
body.mesh canvas[data-mesh]{position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none}
body.mesh main.wrap{max-width:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,40%) 1fr;min-height:100vh;min-height:100dvh}
body.mesh header.top~main.wrap{min-height:calc(100dvh - 64px)}
body.mesh .auth{grid-column:1;align-self:center;justify-self:center;width:min(440px,100%);max-width:none;margin:0;padding:48px 24px 56px}
body.mesh .auth>*{animation:gcin .7s cubic-bezier(.2,.7,.2,1) both}
body.mesh .auth>:nth-child(2){animation-delay:.05s}body.mesh .auth>:nth-child(3){animation-delay:.1s}body.mesh .auth>:nth-child(4){animation-delay:.15s}body.mesh .auth>:nth-child(n+5){animation-delay:.2s}
@keyframes gcin{from{opacity:0;transform:translateY(8px)}}
.mesh-cap{position:fixed;right:16px;bottom:12px;margin:0;font:11px/1.4 var(--mono);color:var(--ink3);pointer-events:none}
.mesh-cap span+span::before{content:" · "}
.mesh-cap span:empty{display:none}
@media (max-width:900px){body.mesh main.wrap{grid-template-columns:1fr}body.mesh .auth{padding:40px 16px 56px}body.mesh canvas[data-mesh]{opacity:.25}.mesh-cap{display:none}}
@media (prefers-reduced-motion:reduce){body.mesh .auth>*{animation:none}}
.auth .lead{font-size:16px;line-height:1.55;color:var(--ink2);margin-top:12px}
.auth .ways{margin-top:30px;padding-top:24px;border-top:1px solid var(--rule2);display:grid;gap:10px}
.btn.prov{width:100%;min-height:46px;gap:10px}
.btn.prov svg{width:18px;height:18px;flex:none}
.btn.paper{background:transparent;color:var(--ink);border-color:var(--rule2)}
.btn.paper:hover{opacity:1;background:var(--panel);border-color:var(--ink3)}
.btn.danger{background:transparent;color:var(--warn);border-color:var(--warn)}
.btn.danger:hover{background:var(--warn-t);border-color:var(--warn)}
.or{display:flex;align-items:center;gap:12px;font:500 12px var(--mono);color:var(--ink3);margin:8px 0}
.alt{font-size:14.5px;color:var(--ink2);margin-top:4px;display:flex;flex-wrap:wrap;gap:4px 22px;align-items:center}
.alt a,.alt button.lnk,.lnk.ul{color:var(--ink);text-decoration:underline;text-underline-offset:3px;min-height:32px;display:inline-flex;align-items:center;gap:7px}
.alt svg{width:16px;height:16px;flex:none}
.pwf .row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.pwf .row a{font-size:13px;color:var(--ink2)}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--rule)}
.auth label,.acct-form label{display:block;font:500 12.5px var(--mono);color:var(--ink3);margin-bottom:7px}
.auth input,.acct-form input{min-height:46px;width:100%;padding:0 12px;border-radius:0;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:16px var(--sans)}
.auth input:focus-visible,.acct-form input:focus-visible{outline:1px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.auth form{display:grid;gap:10px}
.hint{font-size:13px;line-height:1.5;color:var(--ink3)}
.err{font-size:14px;color:var(--warn);min-height:21px;margin-top:6px}
.err:empty{min-height:0;margin:0}
.swap{margin-top:30px;padding-top:18px;border-top:1px solid var(--rule);font-size:14.5px;color:var(--ink2)}
.swap a,.opt a,.auth p a{color:var(--ink)}
.opt{margin-top:10px;font-size:13px;line-height:1.5;color:var(--ink3)}
.detail{margin-top:14px;font:12.5px var(--mono);color:var(--ink3);overflow-wrap:anywhere}
.notice{margin-top:22px;padding:12px 0;border-top:1px solid var(--rule2);border-bottom:1px solid var(--rule);font-size:14.5px;color:var(--ink2)}
.notice b{font-weight:500;color:var(--ink)}
.auth .notice{border:0;padding:0;margin-top:16px;color:var(--ink)}
.notice.n-ok b{color:var(--accent)}
.notice.n-bad b{color:var(--warn)}
.caution{margin-top:22px;padding:12px 0 12px 14px;border-left:3px solid var(--warn);font-size:14.5px;line-height:1.5;color:var(--ink2)}
.caution b{color:var(--warn);font-weight:500}
.ucode{font:500 clamp(36px,10vw,50px)/1 var(--mono);letter-spacing:.06em;margin-top:26px;font-variant-numeric:tabular-nums;white-space:nowrap}
dl.req{display:grid;grid-template-columns:minmax(110px,auto) minmax(0,1fr);border-top:1px solid var(--rule2);margin-top:24px}
dl.req dt,dl.req dd{padding:11px 0;border-bottom:1px solid var(--rule);font-size:14.5px;min-width:0;overflow-wrap:anywhere}
dl.req dt{font:500 12.5px var(--mono);color:var(--ink3);padding-top:13px;padding-right:16px}
.acts{display:flex;gap:10px;margin-top:22px}
.acts .btn{flex:1}
.step{margin-top:26px;padding-top:18px;border-top:1px solid var(--rule);display:grid;gap:10px;justify-items:start}
.step p{font-size:14.5px;color:var(--ink2)}
.done{margin-top:22px;font-size:15px}
.done b{color:var(--accent);font-weight:500}
.acct-form{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-top:20px;max-width:680px}
.acct-form .f{flex:1 1 260px;min-width:0}
.blk p.intro{font-size:14.5px;color:var(--ink2);margin-top:14px;max-width:70ch}
table.dt td.name{white-space:normal;max-width:28ch;overflow-wrap:anywhere}
table.dt td.pkey{font:13px var(--mono)}
table.dt td.pkey .btn{margin-left:8px}
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
  table.dt.rows td:first-child{font-weight:500}
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
export const CLIENT_JS = `
function gcPost(url, body, method){
  return fetch(url, { method: method || "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(function(r){
      if (r.status === 204) return {};
      return r.json().catch(function(){ return {}; }).then(function(j){
        if (!r.ok) { var e = new Error((j && j.error) || ("HTTP " + r.status)); e.status = r.status; e.confirm = !!(j && j.confirm); throw e; }
        return j;
      });
    });
}
function b2u(buf){ var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); }
function u2b(s){ s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer; }
function gcPasskeys(){ return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); }
/** Add a passkey to the signed-in account (there is no passkey sign-up). */
function gcRegister(){
  return gcPost("/api/auth/passkey/register/options", {}).then(function(o){
    var pk = o.publicKey; pk.challenge = u2b(pk.challenge); pk.user.id = u2b(pk.user.id);
    (pk.excludeCredentials || []).forEach(function(c){ c.id = u2b(c.id); });
    return navigator.credentials.create({ publicKey: pk }).then(function(cred){
      var r = cred.response;
      return gcPost("/api/auth/passkey/register/verify", { id: o.id, credential: { id: cred.id, rawId: b2u(cred.rawId), type: cred.type,
        response: { clientDataJSON: b2u(r.clientDataJSON), attestationObject: b2u(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } } });
    });
  });
}
/** A passkey assertion: options from one route, the answer to the other (sign-in, the passkey step, a confirmation). */
function gcAssert(opts, verify){
  return gcPost(opts, {}).then(function(o){
    var pk = o.publicKey; pk.challenge = u2b(pk.challenge);
    (pk.allowCredentials || []).forEach(function(c){ c.id = u2b(c.id); });
    return navigator.credentials.get({ publicKey: pk }).then(function(cred){
      var r = cred.response;
      return gcPost(verify, { id: o.id, credential: { id: cred.id, rawId: b2u(cred.rawId), type: cred.type,
        response: { clientDataJSON: b2u(r.clientDataJSON), authenticatorData: b2u(r.authenticatorData), signature: b2u(r.signature), userHandle: r.userHandle ? b2u(r.userHandle) : null } } });
    });
  });
}
function gcLogin(){ return gcAssert("/api/auth/passkey/login/options", "/api/auth/passkey/login/verify"); }
function gcStep(){ return gcAssert("/api/auth/passkey/mfa/options", "/api/auth/passkey/mfa/verify"); }
function gcConfirm(){ return gcAssert("/api/auth/passkey/confirm/options", "/api/auth/passkey/confirm/verify"); }
/** Run fn; when the server asks for a fresh passkey (adding or removing one), confirm with a passkey, then run it again. */
function gcFresh(fn){ return fn().catch(function(e){ if (e && e.confirm) return gcConfirm().then(fn); throw e; }); }
function gcWhy(e){
  if (e && e.name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again when you are ready.";
  if (e && e.name === "InvalidStateError") return "This device already holds a passkey for this account.";
  if (e && e.name === "SecurityError") return "Passkeys only work on " + location.hostname + " over HTTPS.";
  if (e && e.status === 429 && /^HTTP /.test(e.message || "")) return "Too many attempts from your network. Try again in a minute.";
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
/**
 * The email and password form (sign-in, sign-up, the device page): JSON to url with next, then on to the next the
 * server answers (the passkey step for an account with a passkey). min: the shortest new password (sign-up).
 */
function gcPassword(f, url, next, min){
  if (!f) return;
  var b = f.querySelector("button[type=submit]"), err = document.getElementById(f.getAttribute("data-err"));
  f.addEventListener("submit", function(ev){
    ev.preventDefault(); err.textContent = "";
    var email = f.querySelector("[name=email]").value.trim(), pw = f.querySelector("[name=password]").value;
    if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s.]+$/.test(email)) { err.textContent = "Enter a valid email address."; return; }
    if (!pw) { err.textContent = "Enter your password."; return; }
    if (min && Array.from(pw.normalize ? pw.normalize("NFC") : pw).length < min) { err.textContent = "Use at least " + min + " characters."; return; }
    gcBusy(b, true, min ? "Creating..." : "Signing in...");
    gcPost(url, { email: email, password: pw, next: next || null }).then(function(j){ location.href = j.next || "/account"; }, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
  });
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
export function time(iso: string | null, f: "ago" | "date" | "time" = "date", empty = "never"): string {
  if (!iso) return `<span class="muted">${empty}</span>`;
  const fallback = f === "time" ? `${iso.slice(11, 16)} UTC` : iso.slice(0, 10);
  return `<time datetime="${esc(iso)}" data-f="${f}">${esc(fallback)}</time>`;
}

const q = (next: string | null): string => (next ? `?next=${encodeURIComponent(next)}` : "");

const googleButton = (p: { google: boolean }, next: string | null): string =>
  p.google ? `<a class="btn prov paper" href="/auth/google${q(next)}">${GOOGLE_G}<span>Continue with Google</span></a>` : "";

/** Every way in, in the owner's order: Google, an email and a password, then a small GitHub link and Use a passkey. */
function signInWays(o: { google: boolean; github: boolean; next: string | null; signup?: boolean }): string {
  const google = googleButton(o, o.next);
  const form = o.signup
    ? `<form class="pwf" id="pwf" data-err="err" novalidate>
  <div><label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" maxlength="254" placeholder="you@example.com" required></div>
  <div><label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="256" required aria-describedby="pwhint"></div>
  <p class="hint" id="pwhint">At least 10 characters. A few unrelated words are easy to remember and hard to guess. Your email is your username; we do not check it, so use one you read: it is how we can tell the account is yours if you forget your password.</p>
  <button class="btn prov green" type="submit"><span>Create account</span></button>
</form>`
    : `<form class="pwf" id="pwf" data-err="err" novalidate>
  <div><label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" maxlength="254" placeholder="you@example.com" required></div>
  <div><div class="row"><label for="password">Password</label><a href="/login/forgot">Forgot your password?</a></div>
  <input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required></div>
  <button class="btn prov green" type="submit"><span>Sign in</span></button>
</form>`;
  const small = [
    o.github ? `<a href="/auth/github${q(o.next)}">${GITHUB_MARK}<span>Continue with GitHub</span></a>` : "",
    '<button class="lnk" id="pk" type="button"><span>Use a passkey</span></button>',
  ].filter(Boolean);
  return `${google}${google ? '\n<div class="or">or</div>' : ""}
${form}
<p class="err" id="err" role="alert"></p>
<p class="alt">${small.join("")}</p>`;
}

/** A sign-in column on genclass.dev's self-healing sphere (the shell's mesh option, as on /admin's sign-in). */
function authPage(nonce: string, title: string, inner: string, script: string): string {
  return shell(nonce, title, `<style nonce="${nonce}">${DASH_CSS}${ACCOUNT_CSS}</style><div class="auth">${LOGO}${inner}</div>`, CLIENT_JS + script, { bare: true, account: true, mesh: true });
}

export interface AuthPageOptions {
  google: boolean;
  github: boolean;
  /** Where to go after signing in (already checked by safeNext). */
  next: string | null;
  /** A fixed message to show above the options (never text from the request). */
  notice?: string | null;
  /** How long a trial of Pro lasts (TRIAL_DAYS). */
  trialDays?: number;
}

const optional = (days = 7): string => `<p class="opt">The runtime needs no account. Dashboards come with Pro. Get a ${days}-day free trial for analytics.</p>`;

/** The passkey sign-in button's script: sign in, then go to `next` (or reload, on the device page). */
const PASSKEY_LOGIN_JS = `
function gcPasskeyButton(b, err, then){
  if (!b) return;
  if (!gcPasskeys()) { b.disabled = true; b.title = "This browser does not support passkeys."; return; }
  b.addEventListener("click", function(){
    err.textContent = ""; gcBusy(b, true, "Waiting for your passkey...");
    gcLogin().then(then, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
  });
}`;

// --------------------------------------------------------------------------------------------- /login, /signup

/** The scripts of a page with signInWays: the password form, and Use a passkey (signs in, then goes to `next`). */
const waysJs = (url: string, min: number): string => `${PASSKEY_LOGIN_JS}
(function(){
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  gcDropQuery(["next"]);
  gcPassword(document.getElementById("pwf"), "${url}", cfg.next, ${min});
  gcPasskeyButton(document.getElementById("pk"), document.getElementById("err"), function(){ location.href = cfg.next || "/account"; });
})();`;

export function loginPage(nonce: string, o: AuthPageOptions): string {
  const inner = `
<h1>Sign in to GenClass</h1>
<p class="lead">Your account keeps your apps' dashboards in one place: what GenClass detected, on which pages, and what it did.</p>
${o.notice ? `<p class="notice" role="status">${esc(o.notice)}</p>` : ""}
<div class="ways">
${signInWays(o)}
</div>
<p class="swap"><a href="/signup${q(o.next)}">Create an account instead</a></p>
${optional(o.trialDays)}
<script type="application/json" id="cfg">${embed({ next: o.next })}</script>`;
  return authPage(nonce, "Sign in | GenClass", inner, waysJs("/api/auth/password/login", 0));
}

export function signupPage(nonce: string, o: AuthPageOptions): string {
  const inner = `
<h1>Create your GenClass account</h1>
<p class="lead">Your account keeps your apps' dashboards in one place, and lets <code>npx ${RUNTIME_PKG} login</code> connect an app for you.</p>
<div class="ways">
${signInWays({ ...o, signup: true })}
<p class="hint">Want extra security? Add a passkey on your account page once you are in. Use a passkey signs in to an account that already has one.</p>
</div>
<p class="swap"><a href="/login${q(o.next)}">Sign in instead</a></p>
${optional(o.trialDays)}
<script type="application/json" id="cfg">${embed({ next: o.next })}</script>`;
  return authPage(nonce, "Create an account | GenClass", inner, waysJs("/api/auth/password/signup", 10));
}

/** /login/forgot: no email reset exists yet (auth.ts resetSender), so the page says whom to write to. */
export function forgotPage(nonce: string, o: { contact: string }): string {
  const mail = `mailto:${o.contact}?subject=${encodeURIComponent("GenClass password")}`;
  const inner = `
<h1>Forgot your password?</h1>
<p class="lead">GenClass cannot email you a reset link yet. Write to <a href="${esc(mail)}">${esc(o.contact)}</a> from the address you sign in with, and we will reset it once we have checked that the account is yours.</p>
<p class="lead">If your account also signs in with Google, GitHub or a passkey, use that now, then choose a new password on your account page under Security.</p>
<div class="acts"><a class="btn green" href="${esc(mail)}">Email ${esc(o.contact)}</a><a class="btn ghost" href="/login">Back to sign in</a></div>`;
  return authPage(nonce, "Forgot your password | GenClass", inner, "");
}

// --------------------------------------------------------------------------------------------- email collision

export function pendingPage(nonce: string, o: { email: string; provider: "google" | "github" }): string {
  const name = o.provider === "google" ? "Google" : "GitHub";
  const inner = `
<h1>This email already has a GenClass account</h1>
<p class="lead">${name} signed you in as <b>${esc(o.email)}</b>. A GenClass account with that address already exists. We never join accounts because their emails match: an email typed at sign-up is not verified, so anyone could have typed it.</p>
<div class="step">
  <h2>If that account is yours</h2>
  <p>Sign in to it the way you made it (its password or its passkey), then choose Link ${name} on your account page. After that, Continue with ${name} opens that account.</p>
  <a class="btn green" href="/login?next=%2Faccount">Sign in to that account</a>
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

// --------------------------------------------------------------------------------------------- the passkey step

/** /login/passkey: a password, Google or GitHub vouched for an account that has a passkey; no session until it answers. */
export function passkeyStepPage(nonce: string, o: { via: string | null; who: string | null; recovery: string }): string {
  const who = o.who ? ` as <b>${esc(o.who)}</b>` : "";
  const lead =
    o.via === "password"
      ? `Your password signed you in${who}.`
      : `${o.via === "github" ? "GitHub" : o.via === "google" ? "Google" : "Google or GitHub"} signed you in${who}.`;
  const inner = `
<div class="eb">Extra security</div>
<h1>Use your passkey</h1>
<p class="lead">${lead} This account also asks for one of its passkeys.</p>
<div class="ways">
<button class="btn prov green" id="pk" type="button">${KEY_ICON}<span>Use your passkey</span></button>
<p class="err" id="err" role="alert"></p>
</div>
<p class="opt">Lost your passkeys? Email <a href="mailto:${esc(o.recovery)}?subject=GenClass%20passkeys">${esc(o.recovery)}</a>.</p>
<p class="swap"><a href="/login">Cancel</a></p>`;
  const script = `
(function(){
  var b = document.getElementById("pk"), err = document.getElementById("err");
  if (!gcPasskeys()) { b.disabled = true; err.textContent = "This browser does not support passkeys. Open this page where your passkey is."; return; }
  b.addEventListener("click", function(){
    err.textContent = ""; gcBusy(b, true, "Waiting for your passkey...");
    gcStep().then(function(j){ location.href = j.next || "/account"; }, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
  });
})();`;
  return authPage(nonce, "Use your passkey | GenClass", inner, script);
}

// --------------------------------------------------------------------------------------------- messages

/** A short page: a title, one plain sentence, links. `detail` is a small mono line for whoever needs the exact reason. */
export function messagePage(nonce: string, o: { title: string; text: string; links: [string, string][]; detail?: string }): string {
  const links = o.links.map(([label, href], i) => `<a class="btn ${i ? "ghost" : "green"}" href="${esc(href)}">${esc(label)}</a>`).join(" ");
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

const RUN = `<code>npx ${RUNTIME_PKG} login</code>`;

export function devicePage(nonce: string, v: DeviceView): string {
  const entry = `
<form id="cf" novalidate>
  <div><label for="code">Code from your terminal</label>
  <input id="code" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="BCDF-GHJK"></div>
  <button class="btn green" type="submit"><span>Continue</span></button>
</form>
<p class="err" id="err" role="alert"></p>`;
  let inner: string;
  if (!v.signedIn && v.code) {
    // Signed out: the same page for every well-formed code, live or not. Whether it is live shows after sign-in.
    inner = `
<div class="eb">Command line sign-in</div>
<h1>Sign in to continue</h1>
<div class="ucode" aria-label="Code">${esc(v.code)}</div>
<p class="lead">Check that your terminal shows this code, then sign in. This page then shows the request and asks you to approve or deny it.</p>
<div class="ways">
${signInWays({ ...v.providers, next: v.next })}
</div>
<p class="swap"><a href="/signup${q(v.next)}">Create an account instead</a>, then come back here.</p>
<script type="application/json" id="dcfg">${embed({ next: v.next })}</script>`;
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
<div class="acts" id="acts"><button class="btn green" id="yes" type="button"><span>Approve</span></button><button class="btn ghost" id="no" type="button"><span>Deny</span></button></div>
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
  // signed out: sign in here (a password goes on to this page, or to the passkey step and then here) and come back to
  // this page, which then shows the request
  var dcfg = document.getElementById("dcfg");
  if (dcfg) gcPassword(document.getElementById("pwf"), "/api/auth/password/login", JSON.parse(dcfg.textContent).next, 0);
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
  function gone(){ finish("This code is no longer valid", "It expired or was already used. Run npx ${RUNTIME_PKG} login again for a new code."); }
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
    return shell(nonce, "Command line sign-in | GenClass", `<style nonce="${nonce}">${DASH_CSS}${ACCOUNT_CSS}</style><div class="auth">${inner}</div>`, CLIENT_JS + script, { nav: SIGNED_IN_NAV, account: true, mesh: true });
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
  /** The account's password: the email it signs in with and when it was set, changed and last used; null when none. */
  password?: { email: string; created: string; updated: string; lastUsed: string | null } | null;
  providers: { google: boolean; github: boolean };
  notice?: { kind: "ok" | "bad"; text: string };
  /** Dashboards: open (a plan, GenClass's grant or the trial), or locked with the trial still to start, or after it. */
  dashboards?: "open" | "trial" | "ended";
  /** From the query: the pricing page's Start a trial (?trial=1), the locked dashboard's sign-in (?claim=1). */
  pick?: { trial: boolean; claim: boolean };
  /** Where to write when every passkey is lost. */
  recovery?: string;
  /** How long a trial of Pro lasts (TRIAL_DAYS). */
  trialDays?: number;
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
  const recovery = esc(v.recovery ?? "mehar@daybot.ca");
  const required = v.passkeys.length > 0;
  const passkeyRule = required
    ? "<b>Require a passkey at sign-in: on.</b> After your password, Google or GitHub, GenClass asks for one of your passkeys. Removing the last one turns this off."
    : "<b>Require a passkey at sign-in: off.</b> Add a passkey and GenClass asks for it after your password, Google or GitHub.";
  const days = v.trialDays ?? 7;
  const dash = v.dashboards ?? "open";
  const planBlock =
    dash === "open"
      ? ""
      : `<section class="blk" id="plan">
  <div class="blk-h"><h2>Dashboards come with Pro</h2><span class="aside">${dash === "trial" ? `Get a ${days}-day free trial for analytics` : "Your trial has ended"}</span></div>
  <div class="acct-form">${dash === "trial" ? `<button class="btn green" type="button" id="trial"><span>Start your ${days}-day free trial</span></button>` : ""}<a class="btn ${dash === "trial" ? "ghost" : "green"}" href="/account/billing">See plans</a></div>
  <p class="err" id="trialerr" role="alert"></p>
</section>`;
  // the password: the email it signs in with; below the table, Change password (or Add a password)
  const pw = v.password ?? null;
  const pwRow = `<tr><td>Password</td><td>${pw ? `Signs in as ${esc(pw.email)}` : '<span class="muted">Not set</span>'}</td><td data-l="Set">${pw ? time(pw.updated) : ""}</td><td data-l="Last used">${pw ? time(pw.lastUsed, "ago") : ""}</td><td class="act"></td></tr>`;
  const pwForm = pw
    ? `<form class="acct-form" id="pwform" novalidate>
    <input type="email" name="username" autocomplete="username" value="${esc(pw.email)}" hidden>
    <div class="f"><label for="pwcur">Current password</label><input id="pwcur" type="password" autocomplete="current-password" maxlength="256"></div>
    <div class="f"><label for="pwnew">New password</label><input id="pwnew" type="password" autocomplete="new-password" minlength="10" maxlength="256"></div>
    <button class="btn ghost" type="submit" id="pwgo"><span>Change password</span></button>
  </form>
  <p class="err" id="pwerr" role="alert"></p>
  <p class="intro">At least 10 characters. Changing it signs out every other browser and terminal.${required ? " Forgot the current one? Leave it empty: GenClass asks for one of your passkeys instead." : ' Forgot the current one? See <a href="/login/forgot">what to do</a>.'}</p>`
    : `<form class="acct-form" id="pwform" novalidate>
    <div class="f"><label for="pwemail">Email to sign in with</label><input id="pwemail" type="email" autocomplete="username" maxlength="254" value="${esc(a.email ?? "")}" placeholder="you@example.com"></div>
    <div class="f"><label for="pwnew">Password</label><input id="pwnew" type="password" autocomplete="new-password" minlength="10" maxlength="256"></div>
    <button class="btn ghost" type="submit" id="pwgo"><span>Add a password</span></button>
  </form>
  <p class="err" id="pwerr" role="alert"></p>
  <p class="intro">Sign in with this email and a password as well as ${a.google || a.githubLogin ? "Google or GitHub" : "your passkey"}. At least 10 characters.${required ? " GenClass asks for one of your passkeys first." : ""}</p>`;
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
    : `<p class="quiet">No terminal is signed in. Run <code>npx ${RUNTIME_PKG} login</code> in a project folder to sign one in.</p>`;
  const others = v.web.filter((s) => !s.current).length + v.cli.length;

  const body = `
<style nonce="${nonce}">${DASH_CSS}${ACCOUNT_CSS}</style>
<div class="app">
<aside class="side acct" aria-label="Account">
  <div class="proj">Account<small>${who}</small></div>
  <div class="grp">Your apps</div>
  <nav class="apps" aria-label="Your apps">${appsNav}<a class="new" href="#new-app">New app</a></nav>
  <div class="grp">Account</div>
  <div class="out"><a href="/account/billing">Plan and billing</a><a href="#security">Security</a><a href="#sessions">Sessions</a><a href="#delete">Delete account</a><form method="post" action="/logout"><button class="lnk" type="submit">Sign out</button></form></div>
</aside>
<div class="mainc" id="mc" tabindex="-1">
<section class="dh" id="top">
  <div class="eb">Account</div>
  <h1>Your apps</h1>
  <p class="who">Signed in as ${who} · account since ${time(a.created)} · id ${esc(a.id)}</p>
</section>
${v.notice ? `<p class="notice n-${v.notice.kind}" role="status"><b>${v.notice.kind === "ok" ? "Done." : "Not changed."}</b> ${esc(v.notice.text)}</p>` : ""}
${planBlock}
<section class="blk" id="apps">
  <div class="blk-h"><h2>Apps</h2><span class="aside">Table 1. Apps in this account</span></div>
  ${apps}
  <form class="acct-form" id="new-app" novalidate>
    <div class="f"><label for="appname">New app</label><input id="appname" type="text" maxlength="80" autocomplete="off" placeholder="App name, e.g. Acme checkout"></div>
    <button class="btn green" type="submit" id="newgo"><span>Create app</span></button>
  </form>
  <p class="err" id="newerr" role="alert"></p>
  <p class="err" id="linkerr" role="alert"></p>
</section>
<section class="blk" id="claim">
  <div class="blk-h"><h2>Add an existing dashboard</h2><span class="aside">From genclass.dev/start or <code>npx ${RUNTIME_PKG} init</code></span></div>
  <p class="intro">Paste the app's private dashboard link. The app joins this account and keeps its key, so nothing changes in its code. The link keeps working for anyone who already has it until you turn it off in the table above.</p>
  <form class="acct-form" id="claimf" novalidate>
    <div class="f"><label for="link">Dashboard link</label><input id="link" type="text" autocomplete="off" spellcheck="false" placeholder="https://genclass.dev/dashboard/..."></div>
    <button class="btn ghost" type="submit" id="claimgo"><span>Add to account</span></button>
  </form>
  <p class="err" id="claimerr" role="alert"></p>
</section>
<section class="blk" id="security">
  <div class="blk-h"><h2>Security</h2><span class="aside">Table 2. Ways into this account</span></div>
  <div class="tablewrap"><table class="dt rows"><thead><tr><th>Method</th><th>Details</th><th>Added</th><th>Last used</th><th></th></tr></thead><tbody>
  ${pwRow}
  ${google}
  ${github}
  ${keyRows}
  </tbody></table></div>
  <div class="blk-h mt-l" id="password"><h2>${pw ? "Change password" : "Add a password"}</h2></div>
  ${pwForm}
  <div class="blk-h mt-l" id="passkeys"><h2>Passkeys</h2></div>
  <p class="intro" id="pkrule">${passkeyRule}</p>
  <div class="acct-form"><button class="btn ghost" type="button" id="addpk"><span>Add a passkey</span></button></div>
  <p class="err" id="pkerr" role="alert"></p>
  <p class="intro">Adding another passkey, or removing one, asks for one of your passkeys first; removing one also signs out every other browser and terminal. Lost all your passkeys? Email <a href="mailto:${recovery}?subject=GenClass%20passkeys">${recovery}</a>.</p>
</section>
<section class="blk" id="sessions">
  <div class="blk-h"><h2>Sessions</h2><span class="aside">Table 3. Browsers signed in to this account</span></div>
  ${sessions(v.web, "web")}
  <div class="blk-h mt-l" id="cli"><h2>Terminals</h2><span class="aside">Table 4. Signed in with <code>npx ${RUNTIME_PKG} login</code></span></div>
  ${cli}
  ${others ? '<div class="acct-form"><button class="btn ghost" type="button" id="others"><span>Sign out everywhere else</span></button></div>' : ""}
  <p class="err" id="clierr" role="alert"></p>
</section>
<section class="blk" id="delete">
  <div class="blk-h"><h2>Delete account</h2><span class="aside">Cannot be undone</span></div>
  <p class="intro">Deletes this account, its passkeys and its sessions. Apps created in the account are deleted with their stats. Apps that still have a private dashboard link leave the account and keep working through that link. A paid plan is cancelled at once; for a refund of the unused time, email mehar@daybot.ca.</p>
  <div class="acct-form"><button class="btn danger" type="button" id="del"><span>Delete account</span></button></div>
  <p class="err" id="delerr" role="alert"></p>
</section>
<footer class="dfoot">Your account stores your email (as you typed it, or as Google returned it) and whether it is verified, a salted
hash of your password if you set one (never the password), your passkeys' public keys, your Google account id and your GitHub id and login if
you link them, your sign-in sessions and the browsers where your password was right, your trial's dates, and the apps you own. Nothing else. <a href="https://genclass.dev/privacy">Privacy</a> · <a href="https://genclass.dev/terms">Terms</a></footer>
</div>
</div>
<script type="application/json" id="acfg">${embed({ trial: !!v.pick?.trial, claim: !!v.pick?.claim })}</script>`;

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
  // removing a passkey asks for a passkey first when this session has not used one in the last few minutes
  document.querySelectorAll("[data-rmkey]").forEach(function(b){
    b.addEventListener("click", function(){
      if (!gcArm(b, "Confirm: remove and sign out elsewhere")) return;
      b.disabled = true;
      var url = "/api/account/credentials/" + encodeURIComponent(b.getAttribute("data-rmkey"));
      gcFresh(function(){ return gcPost(url, undefined, "DELETE"); }).then(function(){ location.reload(); }, function(e){ document.getElementById("pkerr").textContent = gcWhy(e); b.disabled = false; });
    });
  });
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
  // change the password (the current one, or a passkey when it is left empty) or add one
  var pwf = document.getElementById("pwform");
  if (pwf) pwf.addEventListener("submit", function(ev){
    ev.preventDefault();
    var err = document.getElementById("pwerr"), b = document.getElementById("pwgo"), cur = document.getElementById("pwcur"), em = document.getElementById("pwemail");
    var nw = document.getElementById("pwnew").value; err.textContent = "";
    if (Array.from(nw.normalize ? nw.normalize("NFC") : nw).length < 10) { err.textContent = "Use at least 10 characters."; return; }
    var body = { password: nw };
    if (cur && cur.value) body.current = cur.value;
    if (em) body.email = em.value.trim();
    gcBusy(b, true, "Saving...");
    gcFresh(function(){ return gcPost("/api/auth/password", body); }).then(function(){ location.href = "/account?password=" + (cur ? "changed" : "added"); }, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
  });
  var add = document.getElementById("addpk"), pkerr = document.getElementById("pkerr");
  add.addEventListener("click", function(){
    pkerr.textContent = "";
    if (!gcPasskeys()) { pkerr.textContent = "This browser does not support passkeys."; return; }
    gcBusy(add, true, "Waiting for your passkey...");
    gcFresh(function(){ return gcRegister(); }).then(function(){ location.reload(); }, function(e){ pkerr.textContent = gcWhy(e); gcBusy(add, false); });
  });
  var cfg = JSON.parse(document.getElementById("acfg").textContent);
  var trial = document.getElementById("trial");
  if (trial) {
    trial.addEventListener("click", function(){
      var err = document.getElementById("trialerr"); err.textContent = "";
      gcBusy(trial, true, "Starting...");
      gcPost("/api/billing/trial", {}).then(function(){ location.href = "/account?started=1"; }, function(e){ err.textContent = gcWhy(e); gcBusy(trial, false); });
    });
    if (cfg.trial) trial.focus();
  }
  // back from signing in on a locked dashboard link: return to it (its link was kept in this tab only), where the app
  // can be added to this account; otherwise the link field below is ready for it
  if (cfg.claim) {
    var s = null;
    try { s = sessionStorage.getItem("gc.claim"); sessionStorage.removeItem("gc.claim"); } catch (e) {}
    if (s && /^[A-Za-z0-9]{32}$/.test(s)) { location.replace("/dashboard/" + s); return; }
    var link = document.getElementById("link"); if (link) link.focus();
  }
})();`;
  return shell(nonce, "Account | GenClass", body, CLIENT_JS + script, { nav: SIGNED_IN_NAV, account: true, skip: "mc" });
}

// --------------------------------------------------------------------------------------------- a locked private link

export interface LockedLinkView {
  /** The app's name. */
  name: string;
  /** The visitor's account, when signed in: whether it has Pro now (a plan, grant or trial) and can still start its trial. */
  signedIn: { pro: boolean; canTrial: boolean } | null;
  /** Where the app is: in no account yet, in the visitor's account, or in another one. */
  owner: "none" | "mine" | "other";
  providers: { google: boolean; github: boolean };
  /** How long a trial of Pro lasts (TRIAL_DAYS). */
  trialDays?: number;
}

/**
 * /dashboard/<secret> while the app has no Pro (no account, or an account without a plan, grant or trial):
 * "Dashboards come with Pro. Get a 7-day free trial for analytics." Signed out: Continue with Google (when configured),
 * then Sign in and Create an account (every other way in is there); the link is kept in this tab's sessionStorage only, and /account?claim=1 brings the
 * visitor back here once signed in. Signed in: add the app to the account (POST /api/account/projects/claim, as on
 * /account) and start the trial in one click, or start the trial, or see the plans. Served with the private link's own
 * headers (no referrer); the page's fetch() calls still carry our Origin.
 */
export function lockedLinkPage(nonce: string, v: LockedLinkView): string {
  const back = "/account?claim=1";
  const days = v.trialDays ?? 7;
  const s = v.signedIn;
  let acts: string;
  if (!s) {
    acts = `<div class="ways">
${googleButton(v.providers, back)}
<a class="btn prov green" href="/login${q(back)}"><span>Sign in</span></a><a class="btn prov ghost" href="/signup${q(back)}"><span>Create an account</span></a>
</div>
<p class="opt">Then add this app to your account. It keeps its key and its data.</p>`;
  } else if (v.owner === "other") {
    acts = `<p class="lead">This app is in another GenClass account.</p><div class="acts"><a class="btn ghost" href="/account">Your apps</a></div>`;
  } else if (v.owner === "none") {
    const label = s.canTrial ? `Add to my account and start your ${days}-day free trial` : "Add to my account";
    acts = `<div class="ways"><button class="btn prov green" id="claim" type="button" data-trial="${s.canTrial ? "1" : "0"}"><span>${label}</span></button>
<p class="err" id="err" role="alert"></p></div>
${!s.pro && !s.canTrial ? '<p class="opt">Your trial has ended. <a href="/account/billing">See plans</a></p>' : '<p class="opt">The app keeps its key and its data.</p>'}`;
  } else {
    acts = s.canTrial
      ? `<div class="ways"><button class="btn prov green" id="trial" type="button"><span>Start your ${days}-day free trial</span></button><p class="err" id="err" role="alert"></p></div>`
      : `<p class="lead">Your trial has ended.</p><div class="acts"><a class="btn green" href="/account/billing">See plans</a></div>`;
  }
  const inner = `
<div class="eb">${esc(v.name)}</div>
<h1>Dashboards come with Pro.</h1>
<p class="lead">Get a ${days}-day free trial for analytics.</p>
${acts}
<p class="swap">Keep this link private: it is the only way back to this app without an account.</p>
<script type="application/json" id="cfg">${embed({ signedIn: !!s })}</script>`;
  const script = `
(function(){
  var secret = location.pathname.split("/").filter(Boolean)[1] || "";
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  // signed out: keep the link in this tab for the way back from signing in (/account?claim=1), never on a server
  if (!cfg.signedIn) { try { sessionStorage.setItem("gc.claim", secret); } catch (e) {} return; }
  var err = document.getElementById("err");
  var claim = document.getElementById("claim");
  if (claim) claim.addEventListener("click", function(){
    err.textContent = ""; gcBusy(claim, true, "Adding...");
    gcPost("/api/account/projects/claim", { secret: secret }).then(function(j){
      function go(){ location.href = "/account/apps/" + encodeURIComponent(j.project.id); }
      if (claim.getAttribute("data-trial") !== "1") { go(); return; }
      return gcPost("/api/billing/trial", {}).then(go, go);
    }, function(e){ err.textContent = gcWhy(e); gcBusy(claim, false); });
  });
  var trial = document.getElementById("trial");
  if (trial) trial.addEventListener("click", function(){
    err.textContent = ""; gcBusy(trial, true, "Starting...");
    gcPost("/api/billing/trial", {}).then(function(){ location.reload(); }, function(e){ err.textContent = gcWhy(e); gcBusy(trial, false); });
  });
})();`;
  return shell(nonce, `${v.name} | GenClass`, `<style nonce="${nonce}">${DASH_CSS}${ACCOUNT_CSS}</style><div class="auth">${LOGO}${inner}</div>`, CLIENT_JS + script, { bare: true, mesh: true });
}
