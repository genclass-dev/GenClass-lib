// Written by bench/hunt: runs the generated regression tests with the harness's injection (fixture.mjs) and the
// browser settings of the hunt's page loads. GENCLASS_APP_URL is the app's origin; GENCLASS_HUNT_STORAGE a login's
// storage state.
process.env.GENCLASS_HUNT_OPTS ??= "{\"anyHost\":false,\"holdProtected\":false,\"config\":{\"mode\":\"observe\",\"telemetry\":false,\"visual\":false,\"analytics\":false,\"report\":\"console\",\"model\":false},\"model\":false,\"modelDir\":null,\"settleMs\":400}";
const use = {"headless":true,"bypassCSP":true,"ignoreHTTPSErrors":true,"serviceWorkers":"block","viewport":{"width":1280,"height":800}};
export default { testDir: ".", testMatch: /\.hunt\.spec\.mts$/, timeout: 60000, workers: 1, reporter: "line", use: { ...use, storageState: process.env.GENCLASS_HUNT_STORAGE || undefined } };
