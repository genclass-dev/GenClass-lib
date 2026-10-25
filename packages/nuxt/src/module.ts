// @genclass/nuxt: the GenClass runtime as a Nuxt module. Role: from the `genclass` key of nuxt.config, register one
// client-only plugin that starts GenClass first, and, when the options need it, the page-configuration module it
// imports before the runtime. Invariants: nothing runs on the server (the plugin is client-only, so the server build
// never imports @genclass/runtime); the module only chooses the runtime's documented entry (`/auto` or `/auto/guard`)
// and its documented page configuration (`window.GENCLASS_CONFIG`), so GenClass behaves exactly as with the one-line
// install; the devtools overlay loads in `nuxt dev` only unless `devtools: "always"` asks for it. The generated code
// is in source.ts, where the tests check it.

import { addPluginTemplate, addTemplate, defineNuxtModule } from "@nuxt/kit";
import { configSource, pageConfig, pluginSource, validate, type ModuleOptions } from "./source";

export type { ModuleOptions };

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: "@genclass/nuxt",
    configKey: "genclass",
    compatibility: { nuxt: ">=3.17.0" },
  },
  defaults: { mode: "observe", devtools: "dev" },
  setup(options, nuxt) {
    validate(options);
    const cfg = pageConfig(options);
    if (cfg) {
      addTemplate({ filename: "genclass.config.mjs", write: true, getContents: () => configSource(cfg) });
    }
    // Prepended to the app's plugins (addPluginTemplate's default), so its module evaluates before theirs: GenClass
    // is installed when the entry chunk runs, before Nuxt creates the app, and before any other plugin's first request.
    addPluginTemplate({
      filename: "genclass.client.mjs",
      mode: "client",
      write: true,
      getContents: () => pluginSource(options, nuxt.options.dev),
    });
  },
});
