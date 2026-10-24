# Listing `@genclass/astro` on astro.build/integrations

Research and steps, written 2026-10-24. Nothing is submitted from this repository. Sources:
[astro.build/integrations](https://astro.build/integrations/) (its "Submit integration" button links to the
publishing guide) and the Astro docs,
[Publish to npm, Integrations Library](https://docs.astro.build/en/guides/publish-to-npm/#integrations-library) and
the [Integration API reference](https://docs.astro.build/en/reference/integrations-reference/).

## How the catalog works

There is no submission form or review. The docs say: the library pulls in "every package published to npm with the
`astro-component`, `astro-integration`, or `withastro` keyword", and "The library is automatically updated weekly."
It reads `name`, `description`, `repository` and `homepage` from the package's `package.json`. Weekly npm download
counts are shown next to each entry.

A category comes from more keywords; "Packages that don't include any keyword matching a category will be shown as
`Uncategorized`." The category keywords, from the guide:

| category | keywords |
|---|---|
| Accessibility | `a11y`, `accessibility` |
| Adapters | `astro-adapter` |
| Analytics | `analytics` |
| CSS + UI | `css`, `ui`, `icon`, `icons`, `renderer` |
| Frameworks | `renderer` |
| Content Loaders | `astro-loader` |
| Images + Media | `media`, `image`, `images`, `video`, `audio` |
| Performance + SEO | `performance`, `perf`, `seo`, `optimization` |
| Dev Toolbar | `devtools`, `dev-overlay`, `dev-toolbar` |
| Utilities | `tooling`, `utils`, `utility` |

The `astro-integration` keyword also makes `npx astro add @genclass/astro` work (the reference: the package needs the
keyword and "a default export that is a function"; `astro add` installs the package and its peer dependencies and adds
it to `astro.config`).

## What the package already has

`packages/astro/package.json`:

- `keywords`: `astro-integration`, `withastro` (either is enough for the catalog; both are the ones the guide
  recommends), plus `tooling`, which files it under **Utilities**. `devtools` was not used on purpose: the "Dev
  Toolbar" category is for dev toolbar apps, which this integration is not. `performance` would also be a stretch.
- `name`, `description`, `repository` (with `directory: packages/astro`) and `homepage` (https://genclass.dev), the
  fields the catalog reads. If the catalog entry should point at the package's README instead of the site, change
  `homepage` before publishing, or file the override issue below.
- A default export that is a function (`genclass(options)`), so `astro add` works.
- `astro` is a peer dependency. The guide notes some package managers do not install peer dependencies for
  integrations and users then see `Cannot find package` warnings; the README's install line names
  `@genclass/runtime` next to the integration for that reason.

## Steps

1. Publish `@genclass/astro` 0.1.0 to npm through a release workflow (AGENTS.md rule 9; a tag convention and
   workflow like `release-mcp.yml` would be needed for this package).
2. Wait for the weekly update. The entry appears at https://astro.build/integrations/ under Utilities, and in the
   "Recently Added" filter, with the npm description as its text. No action is needed.
3. Optional, after the package is on npm: open an issue at
   https://github.com/withastro/astro.build/issues/new/choose to add an avatar (attach the image) or to override the
   listed name, description or homepage.
4. Check the listing a week later: the description shown is `package.json`'s `description`; if it reads badly in the
   card, shorten it in a patch release (the catalog resyncs weekly) or use the override issue.

## What to say in the listing

The npm description is the listing text. The current one: "GenClass for Astro: an integration that reports your site's
race conditions, stale responses and duplicate submits while they happen, in the browser only. A small local model,
observe mode by default, nothing on the server." It states what it does and the default (observe) without claims the
runtime's RESULTS.md does not back.
