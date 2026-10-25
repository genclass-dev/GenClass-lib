# Starter templates

Copy-paste starters with [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) already installed
the recommended way (the one line, the dev-only devtools overlay). Each is a fresh app from the framework's own
generator, trimmed to one page with a search box and a mock API that answers out of order, so you can see GenClass
work within a minute.

| template | the one line goes in | run |
|---|---|---|
| [react-vite](react-vite/) | `src/main.tsx` | `npm install && npm run dev` |
| [nextjs](nextjs/) (App Router) | `instrumentation-client.ts` | `npm install && npm run dev` |
| [vue-vite](vue-vite/) | `src/main.ts` | `npm install && npm run dev` |
| [sveltekit](sveltekit/) | `src/hooks.client.ts` | `npm install && npm run dev` |
| [astro](astro/) (Node adapter) | `astro.config.mjs`: the [`@genclass/astro`](../packages/astro/) integration | `npm install && npm run dev` |
| [nuxt](nuxt/) | `nuxt.config.ts`: the [`@genclass/nuxt`](../packages/nuxt/) module | `npm install && npm run dev` |
| [react-router](react-router/) (framework mode, SSR) | `app/entry.client.tsx` | `npm install && npm run dev` |
| [angular](angular/) (SSR) | `src/main.ts` | `npm install && npm run dev` |

Copy one without the rest of the repository:

```bash
npx degit genclass-dev/GenClass-lib/templates/react-vite my-app
cd my-app && npm install && npm run dev
```

Every template:

- **starts in observe mode**: GenClass reports what it finds (devtools overlay, one console line per finding) and
  changes nothing. Switch the import to `@genclass/runtime/auto/guard` (in astro and nuxt: `mode: "guard"` in the
  integration's or module's options) to let it act when its model is confident;
- **loads the devtools overlay in development only**;
- **can be turned off per page load** with `?genclass=off` in the URL;
- sends anonymous, redacted diagnostics by default; each README shows the one-line opt-out.

They need `@genclass/runtime` 0.2.0 or later (automatic state discovery); astro and nuxt also need
`@genclass/astro` and `@genclass/nuxt` 0.1.0 on npm. Each one builds, boots and passes the checks in
`compat/templates-check.mjs` (production build and dev server, Chromium) against the runtime, the integration and the
module packed from this repository; the frameworks behind them are covered by the
[compatibility matrix](../compat/RESULTS.md).
