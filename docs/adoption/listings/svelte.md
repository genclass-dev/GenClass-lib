# Svelte listings for @genclass/sv

Where the SvelteKit add-on (`packages/sv`, npm `@genclass/sv`) can be listed, with the text to paste. Submit only
after `@genclass/sv@0.1.0` and `@genclass/runtime@0.3.0-beta.1` are both on npm: the add-on writes
`^0.3.0-beta.1`, which npm cannot install before that runtime release exists.

## npm keyword search (no submission)

The Svelte CLI docs send people to packages with the `sv-add` keyword
([npmx.dev/search?q=keyword:sv-add](https://www.npmx.dev/search?q=keyword:sv-add)). `packages/sv/package.json`
has it, so publishing is the listing.

## sveltesociety.dev

The submit form (https://sveltesociety.dev/submit) needs a signed-in account, so the field names below were not seen
on the form itself; check them when submitting.

| field | value |
|---|---|
| Type / category | Package (or "Add-on" if the form offers it) |
| Title | @genclass/sv |
| Short description | `npx sv add @genclass` sets up GenClass in a SvelteKit app: it reports race conditions in the browser (stale responses, duplicate submits, failure storms) with a small on-device model. |
| URL | https://github.com/genclass-dev/GenClass-lib/tree/main/packages/sv |
| npm package | @genclass/sv |
| Repository | https://github.com/genclass-dev/GenClass-lib |
| Tags | sv-add, sveltekit, debugging, testing, network, developer-tools |
| License | Apache-2.0 |

Longer description, if the form has one:

> A community add-on for the Svelte CLI. `npx sv add @genclass` adds `@genclass/runtime`, imports it first in
> `src/hooks.client`, and loads the GenClass overlay in development only. GenClass watches fetch, XHR, WebSocket,
> EventSource and user input in the browser and reports stale responses, duplicate requests, retries and failure
> storms; it starts in observe mode, which never changes a request. Its model (about 13 MB, cached) is downloaded from
> jsDelivr on a browser's first visit. The add-on writes GenClass's telemetry opt-out unless you choose to send
> anonymous diagnostics. `npx @genclass/runtime remove` undoes it.

## The GenClass README

One line for the Install section of the root README (under the `npx @genclass/runtime@beta init` line), once the
add-on is on npm:

```bash
npx sv add @genclass                  # SvelteKit, through the Svelte CLI (telemetry off unless you choose it)
```
