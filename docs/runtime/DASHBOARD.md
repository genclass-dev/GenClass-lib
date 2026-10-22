# Your GenClass dashboard and the account commands

How an app's diagnostics reach a dashboard at genclass.dev: the app token (project key), the private dashboard link,
GenClass accounts, the CLI's `login`, `connect`, `whoami` and `logout`, and the `.genclass.local` file. For
`@genclass/runtime` 0.3.0 (`0.3.0-beta.0` on the npm `beta` dist-tag); `0.2.x` ignores a token and has none of these
commands. What is sent is in [TELEMETRY.md](../../packages/runtime/TELEMETRY.md); the privacy policy for the
diagnostics and for accounts (what is collected and stored, how long it is kept, your rights) is
[PRIVACY.md](../../PRIVACY.md).

## What is the dashboard?

Each web app gets a **project key** (token: `gc_` + 22 letters and digits) that groups its diagnostics on a
dashboard at genclass.dev. The key is public: it ships in your page and can only add telemetry to its app. Keep the
dashboards in a GenClass account, or use one private link per app without an account. The dashboard is free for every
app, with 90 days of history (1 year on Enterprise), and so is your own classifier, which a person from GenClass trains
on your app's traffic, bug reports or labelled examples once you ask ([pricing](https://genclass.dev/pricing)).

The dashboard reads the same anonymous diagnostics the runtime sends by default; it gets nothing while telemetry is
off ([Why does my dashboard show no data?](#why-does-my-dashboard-show-no-data)).

## What is the difference between the token and the dashboard link?

| | what | who may see it |
|---|---|---|
| token | `gc_` + 22 letters and digits, e.g. `gc_4fQ9...` | public: it ships in your page. It only lets your app's diagnostics be grouped together. |
| dashboard link | `https://genclass.dev/dashboard/<secret>` | **private**: anyone with the link sees your app's stats, and it is the only way to open them |
| CLI session | `gcs_...`, saved in `~/.config/genclass/credentials.json` | **secret**: `logout` ends it at genclass.dev and deletes the file; you can also revoke it from your account page |

## How do I get a dashboard without an account?

Run `npx @genclass/runtime@beta init` while not signed in. After you approve its diff it creates both the token and
the link, writes the token into what it adds, prints the link and saves it in `.genclass.local`
([INSTALL.md](INSTALL.md#how-does-init-create-a-token-and-a-dashboard)). Or click "Get a token" at
[genclass.dev/start](https://genclass.dev/start). A link can be added to an account later (`connect`, or "Add an
existing dashboard" on your account page).

## What is `.genclass.local`?

The file where `init` saves the token and the private dashboard link, before it writes anything else, so a failed
write cannot lose it. init asks git whether the file is ignored; if not, it adds it to the project's `.gitignore`
(inside a git repository without one there, such as a monorepo package, it creates one with that line). `remove`
leaves the file and that line alone. Never paste the link from it into code, docs, commits or pull requests: anyone
with the link sees the app's stats. `connect` reads it to add that dashboard to your account, and sends the link only
to the host it belongs to.

## How do I keep my dashboards in an account?

```bash
npx @genclass/runtime@beta login     # sign in in the browser, then connect the app in this folder
npx @genclass/runtime@beta connect   # connect an app folder later (or another one)
npx @genclass/runtime@beta whoami    # your account and its apps
npx @genclass/runtime@beta logout    # end the CLI session
```

`login` prints a code and opens `https://genclass.dev/login/device`, where you sign in (Google, your email and
password, or GitHub, plus your passkey if your account has one) and approve that code. It waits until you do (Ctrl-C
stops it and saves nothing), then saves the CLI session in `~/.config/genclass/credentials.json`
(`$XDG_CONFIG_HOME/genclass/`; Windows `%APPDATA%\genclass\`), readable only by you. Inside an app's folder, `login`
then asks whether to connect that app; `connect` does that step alone:

- pick one of your account's apps, or a new one named after `package.json`; a new app is created only once you
  approve the changes;
- it writes the key the way `init` does (`genclass.config.*`, `data-token` on the script tag, or the Astro meta
  line), shows the diff and asks first, and sets GenClass up first if `init` has not;
- an app `init` already created without an account (its private link in `.genclass.local`) can be added to your
  account instead, keeping its key and its data.

```
  ✔ Account    you@example.com
  ✔ App        shop-web (a new app in your account, created once you apply the changes)
  ...
  Your dashboard  https://genclass.dev/account/apps/...
```

An app's dashboard in your account opens for you when you are signed in at genclass.dev. Until the app's first event
arrives it shows the key and these same two ways to connect it; you can also sign up at genclass.dev, create an app
there, and pass its key yourself ([below](#how-do-i-pass-a-token-myself)). Signed in, `init` first asks whether a
new app goes into your account instead of getting a private link (`--yes`: it does).

### Account command flags

| flag | command | what it does |
|---|---|---|
| `--yes`, `-y` | login, connect | no questions: `login` connects this folder's app; `connect` uses your app named like `package.json` (or creates it) and applies the changes |
| `--no-browser` | login | print the link only, do not open a browser (it works from any device) |
| `--no-connect` | login | do not offer to connect the app in this folder |
| `--app <id\|name>` | login, connect | use this app of your account |
| `--name <name>` | login, connect | create a new app with this name (default: `package.json`'s name) |
| `--dry-run` | connect | show what would change; it reads your app list, and creates and writes nothing |
| `--no-install` | login, connect | do not run the package manager (when connect sets GenClass up) |
| `--cwd <dir>` | all four | the project directory (default: the current directory) |

`npx @genclass/runtime@beta login --help` prints the same list.

## What does the CLI send to genclass.dev?

Nothing until you run one of these commands (or approve `init`'s changes). `init` creates a dashboard only after you
approve its diff (it sends the `name` from `package.json`). `login` asks genclass.dev for a sign-in code with
`client_name: "genclass-runtime <version>"` (the approval page shows that name and your account page lists the
session under it), and polls until you approve it, then reads your account's apps. `whoami` and `connect` read your
account's apps; creating an app sends its name, and adding an existing dashboard sends its link from
`.genclass.local`. `logout` ends the CLI session. The account requests carry
`user-agent: genclass-runtime-cli/<version>`.

A CLI session can read your account's apps, create apps, add an app from its private link and end itself; it cannot
read stats, end other sessions or change how you sign in.

## How do I pass a token myself?

`GenClass.init({ token })`, `data-token="..."` on the script tag, `<meta name="genclass" content="token=...">` or
`window.GENCLASS_CONFIG = { token }`. A malformed token logs one console warning and is ignored. With `/auto` or the
script tag, GenClass is already running before your code, so set the token where GenClass starts (the
`genclass.config.ts` / `.js` that `init` writes, the meta tag or the script tag), not in a later `GenClass.init()`.

## What does the dashboard show?

Decisions, detections by diagnosis, actions taken, top routes and protected functions, model load, backend (WebGPU or
WASM) and latency, runtime and model versions, and recent detections. With `analytics: true` (new in `0.3.0-beta.1`;
`0.3.0-beta.0` does not have it; off by default), also how visitors use the app: page
views, time on page and scroll depth per page, the most clicked elements, and rage and dead clicks
([TELEMETRY.md](../../packages/runtime/TELEMETRY.md#interaction-analytics)). Put `data-genclass-name="pricing-cta"` on
an element to give it a readable name there. Dashboard data is kept for 90 days (1 year on Enterprise).

## Why does my dashboard show no data?

The dashboard needs telemetry on (the default with `GenClass.init()` in a browser) on a deployed host. Local hosts
(`localhost`, `*.local`, `*.test`, private networks) do not send by default, so a page there does not feed the
dashboard (the console says so once when a token is set). `telemetry: true` or any telemetry options object (for
example `telemetry: { decisionSample: 1 }`) is an explicit opt-in that sends from local hosts too, token included.
With telemetry off for any other reason, a token does nothing (with `debug: true` the console says so once). Visitors
who opt out (`?genclass=no-telemetry`, `localStorage["genclass.telemetry"] = "off"`) or whose browser sends Global
Privacy Control are not counted.

With a token, each telemetry batch carries it and decisions about `protect()`ed functions carry their `fn` name;
nothing else changes about what is sent. Without a token neither is sent.

## Which version do I need?

The token option, `scope`, `protect()` and the `login`, `connect`, `whoami` and `logout` commands are in `0.3.0`
(first as `0.3.0-beta.0`, see the [CHANGELOG](../../packages/runtime/CHANGELOG.md)). A key needs `@genclass/runtime`
`0.3.0-beta.0` or later in your app.
