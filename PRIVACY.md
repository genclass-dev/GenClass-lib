# GenClass Runtime: privacy policy

_Last updated: 2026-10-13._

This policy covers the diagnostics that `@genclass/runtime` (from `0.1.0-beta.3`) sends to its maintainers. It does not
cover the website or app that uses GenClass; that site has its own privacy policy.

## Who we are

GenClass is maintained by Daybot Solutions Inc. ("we"). Contact: mehar@daybot.ca.

## What we collect

When a website runs GenClass with telemetry on (the default on public websites; off by default on localhost and
private networks unless the website's developer opts in explicitly with `telemetry: true` or a telemetry options
object; version 0.2.1 sent from those hosts by default, by mistake, fixed in 0.2.2), the browser sends us:

- **Decisions the runtime made:** what kind of event it looked at (for example a network response or a store
  write), the model's diagnosis and suggested action, its confidence, and whether anything was changed or undone.
  No text from the page is included by default.
- **The situation text the model read, only if the website's developer opted in** (`include: { situation: true }`).
  This describes recent app activity: request paths, store field names and short summaries of their values
  (including app state GenClass finds on its own, such as React component state), timing, route changes, short
  error messages and short values typed into ordinary fields. GenClass removes passwords, payment details and
  fields whose names look like secrets before this text is created. Other values, such as names, emails or search
  terms typed into the app, can appear in shortened form. Developers who enable it are responsible for telling
  their users.
- **Technical details:** GenClass and model versions, settings, device type (WebGPU or WASM), load times and error
  counts, and the website's hostname.
- **The page's path**, with id-like segments replaced by `:id` and no query string or fragment (for example
  `/orders/:id`), on each page load and each decision.
- **Your approximate country**, from our server provider.
- **The website's GenClass token**, if the site set one (from runtime 0.3.0). It tells us which website the data
  came from, so that website's owner can see it on their dashboard.
- **Names of protected functions, only if the site set a token** (from runtime 0.3.0): the name the developer gave a
  function wrapped with `protect()`, on the decisions about what that function caused. A name that looks like data
  (an e-mail address, a URL, 4 or more digits in a row, a long hex id) is sent as `[redacted]`.

We do **not** store IP addresses, browser user-agent strings or cookies, and the runtime sets no cookies. Each page
load gets a random session ID that is not saved anywhere.

## Why we collect it

To measure how well the model works and to train better versions of it, and to show website owners how GenClass
works on their own site. We do not sell the data, use it for advertising, or try to identify individual people.

## Dashboards for website owners

A website owner can get a private dashboard link for their site's token. Whoever holds that link can see aggregated
diagnostics for that site (counts of decisions, detections and actions, the site's hostnames, routes, the names the
developer gave to protected functions, model speed, versions) and a list of recent detections (time, route or
function name, diagnosis, action). Dashboards do not show the situation text. Data from browsers that opted out or
send Global Privacy Control never reaches a dashboard.

When a developer creates a token with `npx @genclass/runtime init`, after approving its changes, the tool sends us
the name in their project's `package.json`. We keep one record per token: the token, that name, when it was created,
when data first and last arrived, a one-way hash of the dashboard link's secret, and the account it belongs to, if
any. These records are kept until the owner
asks us to delete them (contact below, with the token); the dashboard data itself is deleted after 90 days.

## Accounts on genclass.dev

An account is optional: GenClass, its diagnostics and the private dashboard links work without one. A developer who
creates one (at genclass.dev/signup, or with `npx @genclass/runtime login`, runtime 0.3.0-beta.0 and later) can keep
their apps in one place. An account stores:

- **An email address:** as you typed it when signing up with a passkey (we do not verify it), or as Google returned
  it when you sign in with Google, together with whether it is verified (only Google can mark it verified). We use
  it only for notices about your account. A GitHub sign-in stores no email.
- **Your passkeys' public keys** and, for each, when it was added and last used and how the browser said it connects
  (for example "this device"). The private key never leaves your device.
- **Your Google account id** (the OpenID `sub`) if you sign in with Google, and **your GitHub user id and login** if
  you sign in with GitHub. Google and GitHub sign-in tokens are used once and not kept.
- **Your sign-in sessions:** for the browser and for each terminal you signed in with the CLI, a one-way hash of the
  session secret, when it was created, last used and expires, and the name the CLI gave itself (such as
  "genclass-runtime 0.3.0").
- **The apps you own:** which of the records above (token, name, times) belong to your account, and whether an
  app's private dashboard link still opens it.

Nothing else: no password, no IP address, no browser fingerprint, no tracking cookies. The only cookies are the
session cookie, set when you sign in, and short-lived cookies (10 minutes at most) that keep a Google or GitHub
sign-in tied to your browser. Sessions end after 30 days in the browser and 90 days for the CLI, or when you sign out
or revoke them on your account page. To delete your account, choose Delete account on your account page while
signed in: the account, its passkeys and its sessions are deleted at once, apps created in the account are deleted
with their stats, and apps that still have a private dashboard link leave the account and keep working through that
link. If you cannot sign in any more, write to the contact below from an address Google has verified for that
account; an account id or an unverified email alone is not enough, because both can be known to others.

## Where it goes and how long we keep it

Data is sent to our collector on Cloudflare and stored in Cloudflare R2. It is deleted automatically after
**90 days**; dashboard data is deleted after 90 days too. Only GenClass maintainers can access the stored data, and
the owner of a website's dashboard link can see that website's dashboard. Cloudflare processes it on our behalf.

## How to turn it off

- Developers: `GenClass.init({ telemetry: false })`.
- Anyone: add `?genclass=no-telemetry` to the page URL, or run
  `localStorage.setItem("genclass.telemetry", "off")` in the browser console.
- Browsers that send the **Global Privacy Control** signal are never collected.

## Your rights

Because we do not keep IP addresses, and the diagnostics are not tied to any account, we usually cannot tell which
diagnostics came from you. For a genclass.dev account, we can show or delete everything listed under "Accounts on
genclass.dev". If you have a
question or request (access, deletion or objection), contact mehar@daybot.ca and we will do what we can. You
can also contact your local data protection authority.

## For developers using GenClass

The data comes from your users' browsers. Depending on where you operate, you may need to mention GenClass in your
own privacy policy, or keep `telemetry: false` until your users consent to analytics. Full technical details are in
[TELEMETRY.md](packages/runtime/TELEMETRY.md).

## Changes

We will update this page and the CHANGELOG when we change what we collect or how long we keep it.
