# Listing GenClass on sveltesociety.dev

Research, written 2026-10-24. Nothing is submitted from this repository. Sources: [sveltesociety.dev](https://sveltesociety.dev)
(the Packages page and its search filters), its `/submit` and `/login` pages, the Svelte blog's December 2025
"What's new in Svelte" post, and [svelte.dev/packages](https://svelte.dev/packages).

## How a package gets on sveltesociety.dev now

- Entries are **submitted through the website, not by pull request** since December 2025. The Svelte blog's December
  2025 post: "Instead of opening PRs to add libraries and packages you can now just submit them on the website." The old
  path (a pull request adding the package to a JSON file in the svelte-society/sveltesociety.dev repository) is gone.
- The Packages page has an "Interested in contributing?" block with a **Submit Post** button to
  https://sveltesociety.dev/submit. Opening `/submit` redirects to `/login?redirectTo=/submit`: a **GitHub account is
  required** ("Sign in using one of the following providers": GitHub is the only one). The form's fields are behind
  that login and could not be read without signing in; whoever submits sees them then. From the site's data model
  (every entry has a title, a description, a link, a type and tags, and shows its author), expect those fields.
- Content types on the site (the search's "category" filter): Recipe, Video, **Library**, Resource, Announcement,
  Collection, Job. A package is a **Library**.
- Tags (the search's "tag" filter): AI, Adapter, Auth, DataViz, **DevTools**, Framework, Legacy, Meta, Miscellaneous,
  Official, Progressive Enhancement, Routing, Runes, SDK, SPA, Showcase, State, **SvelteKit**, **Testing**, UI
  Library, **Utility**, a11y, i18n. Tags are chosen on the form.
- No written acceptance rules were found on the site (only Terms of Service and Privacy Policy links on the login
  page). Entries show an author, so the submission is attributed to the GitHub account that posts it. Expect
  moderation before an entry appears; the site does not say how long it takes.

svelte.dev/packages is a different thing: a list curated by the Svelte team ("We've collected a few of our favourite
packages that work well with Svelte and SvelteKit apps"), with no submission path. Its categories include Devtools and
Testing; getting there means being noticed, not applying.

## What the entry needs

GenClass has no Svelte-specific package: the runtime is framework-agnostic, and the SvelteKit path is one import in
`src/hooks.client.ts` ([templates/sveltekit](../../../templates/sveltekit/README.md); `npx @genclass/runtime init`
writes it). The entry should therefore describe `@genclass/runtime` as it behaves in a SvelteKit app, which is what the
template's README already does honestly: it works from the network and user input (stale typeahead responses, duplicate
submits, failure storms, retries, stalls); Svelte runes and stores are not discovered automatically, so decisions that
compare a late response with state need `genclass.atom(...)` / `genclass.guard(...)`.

Before submitting:

- Make sure the SvelteKit template passes `compat/templates-check.mjs` against the released runtime, so the link in
  the entry leads to something that runs (it does as of the compat matrix in `compat/RESULTS.md`).
- Decide which link the entry carries: the npm package (https://www.npmjs.com/package/@genclass/runtime), the
  repository, or the SvelteKit template directory. The template is the most useful landing page for a Svelte reader.

## Draft entry

- **Type:** Library
- **Title:** GenClass
- **Link:** https://github.com/genclass-dev/GenClass-lib/tree/main/templates/sveltekit (or the npm package)
- **Tags:** DevTools, SvelteKit, Utility (Testing fits the coding-agent link in `@genclass/mcp`, but that package is
  not what a Svelte reader installs; leave it out unless the form asks for every applicable tag)
- **Description (draft):** Reports race conditions, stale responses and duplicate submits in the browser while they
  happen. One import in `src/hooks.client.ts`; a small local model (ONNX, in a Web Worker) decides what is worth
  reporting; observe mode, the default, changes nothing. Svelte state is not discovered automatically, so in a
  SvelteKit app GenClass works from the network and user input. Apache-2.0. Anonymous diagnostics are on by default
  on public hosts and off with one option.

The description keeps to what the runtime's README and RESULTS.md back up; it does not claim Svelte state support.
