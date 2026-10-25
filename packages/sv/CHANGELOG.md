# Changelog

## 0.1.0 (unreleased)

- First version: a community add-on for the Svelte CLI, `npx sv add @genclass` and `npx sv create --add @genclass`.
  SvelteKit only (`unsupported("Requires SvelteKit")` elsewhere).
- Adds `@genclass/runtime` `^0.3.0-beta.1` to `dependencies` (a project that lists it under `devDependencies`
  keeps it there; a stricter existing range stays).
- `src/hooks.client.(ts|js)`: `import genclass from "@genclass/runtime/auto"` (`/auto/guard` with `mode: guard`)
  as the first statement and the devtools overlay behind `import.meta.env.DEV` at the end. A missing file is created
  as one marked block; an existing file keeps its code. An existing `/auto` import is re-pointed at the chosen mode
  and given a binding instead of being duplicated.
- `src/app.html`: `<meta name="genclass" content="telemetry=off" />` unless `telemetry: yes` (default `no`). An
  existing genclass meta tag gets `telemetry=off` added instead.
- Everything added carries the `genclass:init` marker, so `npx @genclass/runtime remove` takes it out byte for byte.
  Running the add-on again with the same answers changes nothing.
- Next steps say what the model download costs, whether diagnostics are sent, and how to undo the setup.
- Bundled with `@sveltejs/sv-utils` 1.0.2 (one file, `sv` external); no dependencies of its own.
