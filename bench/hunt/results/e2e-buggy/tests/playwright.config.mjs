// Written by bench/hunt: runs the generated regression tests with the harness's injection (fixture.mjs).
export default { testDir: ".", testMatch: /\.hunt\.spec\.mts$/, timeout: 60000, workers: 1, reporter: "line", use: { headless: true, bypassCSP: true, serviceWorkers: "block", storageState: process.env.GENCLASS_HUNT_STORAGE || undefined } };
