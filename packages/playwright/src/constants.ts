// Constants shared by the fixture and the reporter (kept apart so the reporter bundle does not pull the fixture).

/** This package's version (kept equal to package.json by test/options.test.ts). */
export const PACKAGE_VERSION = "0.1.0";
/** Name of the per-test attachment the fixture writes and the reporter reads. */
export const ATTACHMENT_NAME = "genclass";
