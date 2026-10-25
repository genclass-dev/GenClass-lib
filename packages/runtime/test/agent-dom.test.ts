// @vitest-environment happy-dom
// @genclass/runtime/agent snapshots on a real document (AGENT.md §2): page text, and the lines of live regions.
import { describe, expect, it } from "vitest";
import { connectAgent } from "../src/agent/index.js";
import { setup } from "./helpers.js";

describe("agent: snapshot of the page (AGENT.md §2)", () => {
  it("lines inside live regions (status messages, alerts, toasts) are listed as announcements beside the page text", async () => {
    document.body.innerHTML = `<main><h1>Article</h1><p>300 entries found</p></main><div role="status"><p>Saved document</p><p>Close</p></div><div aria-live="off">Not announced</div>`;
    const s = setup({ mode: undefined, extraGlobal: { location: { href: "http://localhost:5173/a", pathname: "/a", hostname: "localhost", search: "" }, document } });
    s.server.on("POST", "/v1/hello", { body: { run: "r1", schedule: null }, latency: 1 });
    s.server.on("POST", "/v1/events", { body: { ok: true }, latency: 1 });
    const c = connectAgent(s.rt, { schedule: "natural" });
    await s.clock.advance(10);
    const snap = c.snapshot();
    expect(snap.text).toEqual(expect.arrayContaining(["Article", "300 entries found", "Saved document", "Close", "Not announced"]));
    expect(snap.live).toEqual(["Saved document", "Close"]);
    document.body.innerHTML = `<main><h1>Article</h1></main>`;
    expect(c.snapshot().live).toBeUndefined();
    c.disconnect();
  });
});
