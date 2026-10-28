# GenClass Runtime: privacy policy

_Last updated: 2026-10-27._

This policy covers the diagnostics that `@genclass/runtime` (from `0.1.0-beta.3`) sends to its maintainers. It does not
cover the website or app that uses GenClass; that site has its own privacy policy.

## Who we are

GenClass is maintained by Daybot Solutions Inc. ("we"). Contact: mehar@daybot.ca.

## What we collect

When a website runs GenClass with telemetry on (the default on public websites; off by default on localhost and
private networks unless the website's developer opts in explicitly with `telemetry: true` or a telemetry options
object; version 0.2.1 sent from those hosts by default, by mistake, fixed in 0.2.2), the browser sends us:

- **Decisions the runtime made:** what kind of event it looked at (for example a network response or a store
  write), the model's diagnosis and suggested action, its confidence, whether anything was changed or undone, and
  (from runtime 0.3.0) whether a detection was a lower-confidence "possible" one, with a count of those per page
  load. From runtime 0.3.0, routine decisions (nothing found, nothing changed) are sampled: one in four is sent, at
  most 200 per page load, and the page load's summary says how many were sent and left out; every detection is
  sent. No text from the page is included by default.
- **The situation text the model read, only if the website's developer opted in** (`include: { situation: true }`).
  This describes recent app activity: request paths, store field names and short summaries of their values
  (including app state GenClass finds on its own, such as React component state), timing, route changes, short
  error messages and short values typed into ordinary fields. GenClass removes passwords, payment details and
  fields whose names look like secrets before this text is created. Other values, such as names, emails or search
  terms typed into the app, can appear in shortened form. Developers who enable it are responsible for telling
  their users.
- **Technical details:** GenClass and model versions, settings, device type (WebGPU or WASM), load times and error
  counts, and the website's hostname.
- **The page's path**, with id-like segments (and, from runtime 0.3.0, segments containing an `@`, such as an e-mail
  address) replaced by `:id` and no query string or fragment (for example `/orders/:id`), on each page load and each
  decision. Other words in the path, such as a username, are sent as they are.
- **Your approximate country**, from our server provider.
- **The website's GenClass token**, if the site set one (from runtime 0.3.0). It tells us which website the data
  came from, so that website's owner can see it on their dashboard.
- **Names of protected functions, only if the site set a token** (from runtime 0.3.0): the name the developer gave a
  function wrapped with `protect()`, on the decisions about what that function caused. A name that looks like data
  (an e-mail address, a URL, 4 or more digits in a row, a long hex id) is sent as `[redacted]`.
- **How visitors use the site, only if the website's developer turned on interaction analytics** (`analytics: true`
  with a token; from runtime 0.3.0-beta.1, off by default): for each page view, the page's path (as above), how long
  the page was visible and in use (at most 30 seconds after the last mouse, key, scroll or touch input), how far down
  the page the visitor scrolled (25, 50, 75 or 100 %), and how many times each element was clicked, clicked 3 or more
  times within a second, or clicked without anything changing on the page. An element is named from the page's code
  (a name the developer gave it, an id, a link's address on the same site, the other site's address only, class names
  or its position on the page), never by its text. With a newer runtime (after 0.3.0-beta.1), also per **visit** (page
  views with no gap over 30 minutes): a random visit ID that the browser keeps in its local storage for those 30
  minutes, together with a flag saying the browser visited the site before; the website the visitor came from (its
  domain only, such as google.com); the campaign names in the link (`utm_source`, `utm_medium`, `utm_campaign`, with
  anything that looks like an ID removed); the type of device (desktop, mobile or tablet), the browser family and the
  operating system family (never the full user-agent string); and the pages of the visit in order. We do not collect
  what visitors type, where the mouse was, the order of clicks, or anything that links one visit to another, and we
  do not count unique visitors. We store only a one-way hash of the visit ID, and delete visit records 90 days after
  the visit started. We use this data only to show it on that website's dashboard (including funnels the website's
  owner sets up there: a few pages in order and how many visits reached each) and in its export, never to train or
  evaluate the model. Also, within one page load: how each page view was reached (a page load, a reload, the
  browser's back or forward button, a link inside the site), the previous page's path and the time spent before
  moving on, the element the visitor first clicked or (with the keyboard) first moved to on each page and how long
  that took, and, when the page load ends, its pages in order (at most 10) and that it ended there.

We do **not** store IP addresses, browser user-agent strings or cookies, and the runtime sets no cookies. Each page
load gets a random session ID that is not saved anywhere. Only when the website turned on interaction analytics does
the runtime keep one entry in the browser's local storage (the visit ID and the visited-before flag above); the
website's developer can remove it by turning analytics off for that visitor.

## Why we collect it

To measure how well the model works and to train better versions of it, and to show website owners how GenClass
works on their own site. We do not sell the data, use it for advertising, or try to identify individual people.

## Dashboards for website owners

A website owner can get a private dashboard link for their site's token. Whoever holds that link can see aggregated diagnostics for that site (counts of decisions, detections, possible detections and actions, the site's hostnames,
routes, the names the developer gave to protected functions, model speed, versions; with interaction analytics on,
page views, the paths between pages, time on page, scroll depth and clicks per page and element, visits per day, pages per visit, where visits
came from, devices, countries, new or returning, entry and exit pages and funnels) and a list of recent detections
(time, route or function name, diagnosis, action). Dashboards do not show the situation text. Data from browsers that opted out or
send Global Privacy Control never reaches a dashboard.

When a developer creates a token with `npx @genclass/runtime@beta init` (runtime 0.3.0-beta.0 and later;
`npx @genclass/runtime init` once 0.3.0 is `latest`), after approving its changes, the tool sends us the name in
their project's `package.json`. When they create one at https://genclass.dev/start, we receive the app name they
type, if any. We keep one record per token: the token, that name, when it was created,
when data first and last arrived, a one-way hash of the dashboard link's secret, and the account it belongs to, if
any. These records are kept until the owner
asks us to delete them (contact below, with the token); the dashboard data itself is deleted after 90 days.

## Accounts on genclass.dev

An account is optional: GenClass, its diagnostics and the private dashboard links work without one. A developer who
creates one (at genclass.dev/signup, or with `npx @genclass/runtime@beta login`, runtime 0.3.0-beta.0 and later;
`npx @genclass/runtime login` once 0.3.0 is `latest`) can keep their apps in one place. An account stores:

- **An email address:** as Google returned it when you sign in with Google, or as you typed it (trimmed and
  lowercased) when you sign up with an email and a password or add a password to your account, together with whether
  it is verified (only Google can mark it verified; we do not verify a typed address). A typed address is also your
  username. We use it only for notices about your account. A GitHub sign-in stores no email.
- **Your password, if you set one,** only as a salted one-way hash (PBKDF2-HMAC-SHA256, 600,000 iterations; the
  password itself is never stored or logged), with when it was set and last used, and how many wrong passwords were
  entered for the account in a row and when (to slow down guessing).
- **Browsers where your password was right:** a one-way hash of a random cookie value, when it was first and last
  used, and its wrong passwords in a row, so that browser can still sign in while someone elsewhere enters wrong
  passwords. Forgotten when you change your password, when you delete your account, or after 400 days unused.
- **Your passkeys' public keys** and, for each, when it was added and last used and how the browser said it connects
  (for example "this device"). The private key never leaves your device.
- **Your Google account id** (the OpenID `sub`) if you sign in with Google, and **your GitHub user id and login** if
  you sign in with GitHub. Google and GitHub sign-in tokens are used once and not kept.
- **Your sign-in sessions:** for the browser and for each terminal you signed in with the CLI, a one-way hash of the
  session secret, when it was created, last used and expires, when it last used a passkey, and the name the CLI gave
  itself (such as "genclass-runtime 0.3.0").
- **The apps you own:** which of the records above (token, name, times) belong to your account, and whether an
  app's private dashboard link still opens it.

Nothing else: no readable password, no IP address, no browser fingerprint, no tracking cookies. The only cookies are
the session cookie, set when you sign in, the device cookie (`__Host-gc_device`, 400 days), set when your password is
right, and short-lived cookies (10 minutes at most) that keep a Google or GitHub sign-in, and the passkey step after
a password, Google or GitHub, tied to your browser. Sessions end after 30 days in the browser and 90 days for the CLI, or when you sign out
or revoke them on your account page. To delete your account, choose Delete account on your account page while
signed in: the account, its password, its passkeys and its sessions are deleted at once, apps created in the account are deleted
with their stats, and apps that still have a private dashboard link leave the account and keep working through that
link. If you cannot sign in any more, write to the contact below from an address Google has verified for that
account, or, if you forgot your password, from the address you sign in with (GenClass cannot email a reset link
yet); an account id alone is not enough, because it can be known to others.

## Paid plans, payments and Stripe

No plan is sold on genclass.dev today: Free costs nothing and includes your own classifier, and Enterprise is agreed by
email. A paid plan (the Individual plan was one until 22 October 2026) is paid through Stripe, which processes payments
for us. When you upgrade, we send Stripe
your account's email (if it has one) and your GenClass account id, and you type your card or other payment details
into Stripe's own checkout page: they go to Stripe and never reach GenClass. Stripe handles them under its own privacy
policy (stripe.com/privacy) and keeps your invoices and receipts, which you can see under Manage billing on your
billing page.

GenClass stores only your Stripe customer id, your subscription id, the subscription's status and renewal or end date,
and your plan. Never card numbers, bank details or billing addresses. For a purchase of the Individual plan we also keep a
record of the purchase (account id, email, subscription id, time) so that a person from GenClass can write to the buyer
to start the work.

**Forwarding** is off unless an account turns it on for one of its apps. Then, for each new likely detection
from that app (never a possible one), GenClass sends a short record to the services that account chose (Sentry,
PostHog, Datadog, Slack or its own webhook URL): the kind of problem, the model's confidence, what triggered the
check, the page path, the runtime and model versions, the time and a link to the app's dashboard. Never text from
the page. Those services handle the records under their own terms with the account owner. The keys and URLs for them
are stored encrypted.

**Export** lets an account download, or read with an export key, the events GenClass received for its own apps, as
stored. Export keys are stored as one-way hashes.

For apps on a plan with a year of history (Enterprise, and the Individual plan while it was paid for), the dashboard
data and the stored events are kept for 1 year instead of 90 days: for Individual, also for 30 days after the paid
period ends; for Enterprise, until the agreement ends. Then they are deleted as for every other app. Deleting your
account cancels a paid plan at once and deletes the forwarding settings, export keys and stored copies made for your apps; Stripe keeps its
own records of past payments as the law requires.

## Where it goes and how long we keep it

Data is sent to our collector on Cloudflare and stored in Cloudflare R2. It is deleted automatically after
**90 days**; dashboard data is deleted after 90 days too (visit records 90 days after the visit started). Only GenClass maintainers can access the stored data, and
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
[TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).

## Changes

We will update this page and the CHANGELOG when we change what we collect or how long we keep it.
