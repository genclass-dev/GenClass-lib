// The module's playground: `npm run dev` in packages/nuxt starts it with the module from ../src. One page with a
// search box and a mock API that answers out of order (server/api/search.get.ts). Defaults: observe mode, the
// devtools overlay in development only.
export default defineNuxtConfig({
  modules: ["../src/module"],
  genclass: {},
  devtools: { enabled: false },
  compatibilityDate: "latest",
});
