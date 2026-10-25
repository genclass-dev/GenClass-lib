// GenClass, in the browser only: the module adds a client-only plugin that starts GenClass first. Without options it
// observes (reports what it sees, never changes anything) and loads the devtools overlay in `nuxt dev` only. To let it
// act, set genclass: { mode: "guard" }. Add ?genclass=off to the URL to turn it off for a page load.
export default defineNuxtConfig({
  modules: ["@genclass/nuxt"],
  genclass: {},
  // Nuxt's own devtools are off so the page shows GenClass's overlay alone; turn them on if you like.
  devtools: { enabled: false },
  compatibilityDate: "latest",
});
