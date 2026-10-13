// The scanner and the site worker carry the same IANA TLD list and agree on which paths are addresses.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { targetFromPath } from "../src/app.ts";
import { TLD_VERSION, TLDS } from "../src/tlds.ts";

describe("TLD list", () => {
  it("is identical in scan-worker/src/tlds.ts and site/src/tlds.js", async () => {
    // @ts-expect-error plain JavaScript module from the site worker, no types
    const site = (await import("../../site/src/tlds.js")) as { TLDS: Set<string>; TLD_VERSION: string };
    assert.equal(site.TLD_VERSION, TLD_VERSION);
    assert.deepEqual([...site.TLDS].sort(), [...TLDS].sort());
    for (const t of ["com", "dev", "app", "uk", "xn--fiqs8s"]) assert.ok(TLDS.has(t), t);
    for (const t of ["local", "internal", "test", "localhost", "html", "css", "js", "png"]) assert.ok(!TLDS.has(t), t);
  });
  it("the site's genclass.dev/<url> rule and the scanner's path form agree", async () => {
    // @ts-expect-error plain JavaScript module from the site worker, no types
    const { scanTargetFromPath } = (await import("../../site/src/scan-path.js")) as { scanTargetFromPath(p: string, q?: string): string | null };
    for (const p of ["/example.com", "/example.com/a/b", "/https://example.com/x", "/https:/example.com", "/styles.css", "/mend.js", "/docs", "/localhost", "/a b.com", "/foo.notatld"]) {
      assert.equal(scanTargetFromPath(p) !== null, targetFromPath(p) !== null, p);
    }
  });
});
