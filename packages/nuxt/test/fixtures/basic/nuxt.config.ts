// The test fixture: a one-component app with the module and every option set to something other than its default,
// so the build test can check where each one ends up.
import genclass from "../../../src/module";

export default defineNuxtConfig({
  modules: [genclass],
  genclass: { mode: "guard", token: "gc_test_token", telemetry: false },
  devtools: { enabled: false },
  compatibilityDate: "latest",
});
