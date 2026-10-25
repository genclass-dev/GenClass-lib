# Listing GenClass in the Vue and Angular communities

Research and draft entries, written 2026-10-24. Nothing is submitted from this repository. Two channels per framework
were checked: the framework's own site, and the community "awesome" list.

## Vue: awesome-vue

[vuejs/awesome-vue](https://github.com/vuejs/awesome-vue) (branch `master`, about 73,500 stars) is "A curated list of
awesome things related to Vue.js". There is no resources directory on vuejs.org to apply to; awesome-vue is the list.

**Rules.** The repository's `CONTRIBUTING` link points at `.github/contributing.md`, which no longer resolves; the
pull request template (`.github/pull_request_template.md`) carries the checklist a submission is held to:

- "Title as described", "Make sure you put things in the right category!", "Always add your items to the end of a
  list".
- For open-source entries: "Link description does not contain a link to an author / third-party resource"; "The
  documentation (README) contains a description of the project, illustration of the project with a demo or screenshots
  and a CONTRIBUTING section"; "The documentation is in English."; "The project is active and maintained."; "The
  project accepts contributions."; "Not a commercial product".
- One PR template structure, with Fix/Feature checkboxes, not to be edited.

Entry format, from the list itself: `- [Vue DevTools](https://github.com/vuejs/devtools) - Browser devtools extension
for debugging Vue.js applications.` One line, the name linked, a dash, one sentence.

**Category.** The list has no "Monitoring", "Error handling" or "Debugging" heading. The fit is
**Dev Tools > Inspect** (its subtitle is "Inspecting & debugging"; it holds entries such as a tool for "real-time
monitoring of component renders and reactive dependency tracking"). The alternative is **Dev Tools > Test**.
"Utilities > HTTP Requests" is for HTTP clients, which GenClass is not.

**Before submitting.**

- The checklist asks for a demo or screenshots and a CONTRIBUTING section in the project's README. The repository has
  `CONTRIBUTING.md` at its root and the runtime's README shows console output; the maintainers may read "README" as
  the repository's. Add a screenshot of the overlay to the root README, and a "Contributing" line pointing at
  `CONTRIBUTING.md`, before opening the PR.
- "Not a commercial product": the library is Apache-2.0 and works without an account; genclass.dev sells dashboards on
  top of it. The entry links the library, not the site, and the description says what the library does. Be ready for
  the question.
- GenClass is not Vue-specific. The honest hook is the Vue path: `templates/vue-vite` and the `@genclass/nuxt`
  module. Automatic state discovery does not cover Vue refs or Pinia, so the description must not imply it does.

**Draft entry** (Dev Tools > Inspect, appended at the end of the list):

```
- [GenClass](https://github.com/genclass-dev/GenClass-lib) - Reports race conditions, stale responses and duplicate submits in the browser while they happen; one import (or the Nuxt module), a small local model, changes nothing by default.
```

## Angular

### angular.dev

angular.dev has **no community resources directory** to submit to. Its footer links are Social Media (Blog, X,
Bluesky, YouTube, Discord, GitHub, Stack Overflow), Community (Contribute, Code of Conduct, Report Issues, Google's
DevLibrary, Angular Google Developer Experts) and Resources (Press Kit, Roadmap). The old angular.io/resources page
(a JSON file in the Angular repository, fed by pull requests) went with angular.io; nothing replaced it on angular.dev.
"Contribute" is the Angular repository's CONTRIBUTING.md, about code and docs, not listings.

The one official-adjacent channel the footer names is **Google's Dev Library** (https://devlibrary.withgoogle.com),
which lists open-source projects and articles built with Google technologies, Angular among them, and takes
submissions through a form on the site. Its pages are rendered in the browser and could not be read here; whoever
submits should read the acceptance criteria on the site first (open source, a README, working code are the usual
asks). A GenClass submission there would be the Angular template (`templates/angular`) or the runtime with the Angular
row of `compat/RESULTS.md` as the evidence.

### awesome-angular

[PatrickJS/awesome-angular](https://github.com/PatrickJS/awesome-angular) (branch `gh-pages`, about 10,000 stars),
"Something missing? PRs welcomed!". Its `contributing.md`:

- "Search previous suggestions before making a new one, as yours may be a duplicate."
- "Make sure the list is useful before submitting. That implies it has enough content and every item has a good
  succinct description."
- "Make an individual pull request for each suggestion."
- "Titles should be capitalized."
- "Use the following format: `[List Name](link)`"
- "Link additions should be added to the bottom of the relevant category."
- "New categories or improvements to the existing categorization are welcome."
- "Check your spelling and grammar."
- "Make sure your text editor is set to remove trailing whitespace."
- "The pull request and commit should have a useful title."

Entry format, from the list: `* [rxjs-leak-finder](https://github.com/FlorinCiocirlan/rxjs-leak-finder) - A dev-mode
tool that finds leaked RxJS subscriptions in Angular apps.` A bullet, the name linked, a dash, one sentence.

**Category.** Under "Development Utilities", **Debugging** is the fit (it holds `angular-scan`, which "Automatically
detects and highlights Angular components that are re-rendering", and `rxjs-leak-finder`). "Runtime" is for things
that run Angular itself (dynamic compile, platforms); "Performance" and "Networking" are stretches.

**Before submitting.** The Angular path is one import in `src/main.ts` (`templates/angular`, `npx @genclass/runtime
init`), covered by the compat matrix (Angular 22 with SSR, `HttpClient` on fetch and on XHR). Angular signals are not
discovered automatically; the description must not imply they are.

**Draft entry** (Development Utilities > Debugging, appended at the bottom):

```
* [GenClass](https://github.com/genclass-dev/GenClass-lib) - Reports race conditions, stale responses and duplicate submits in the browser while they happen; one import in main.ts, a small local model, changes nothing by default.
```

## Checklist for either PR

1. The package versions the templates name are on npm (the runtime is; `@genclass/nuxt` and `@genclass/astro` are not
   yet).
2. The linked README has a screenshot or a short demo recording of the overlay (awesome-vue asks for one).
3. One PR per list, one entry per PR, appended at the end of its category, with the list's exact line format.
4. Reply to review questions with numbers from `docs/runtime/RESULTS.md` and `compat/RESULTS.md`, not adjectives.
