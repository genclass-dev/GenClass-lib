// runtime.status.scope and runtime.gates() report what is in force on the current route (Troy trial, 2026-10-09:
// status read `scope: { mode: "heal", aggressiveness: 1 }` while the page ran in observe; that was the route ceiling).
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("status.scope", () => {
  it("without a route rule: the effective mode and aggressiveness, no rule or ceiling", () => {
    const { rt } = setup({ mode: "observe" });
    expect(rt.status.effectiveMode).toBe("observe");
    expect(rt.status.scope).toEqual({ route: "/search", mode: "observe", aggressiveness: rt.aggressiveness });
    expect(rt.gates().mode).toBe("observe");
  });

  it("follows setMode", () => {
    const { rt } = setup({ mode: "observe" });
    rt.setMode("guard");
    expect(rt.status.scope?.mode).toBe("guard");
    expect(rt.gates("delivery").mode).toBe("guard");
  });

  it("with a matching rule: the demoted mode, the rule index and its ceiling", () => {
    const { rt } = setup({ mode: "guard", routes: [{ match: "/other", mode: "off" }, { match: "/search", mode: "observe", aggressiveness: "cautious" }] });
    expect(rt.status.scope).toMatchObject({ route: "/search", mode: "observe", rule: 1, ceiling: "observe", aggressiveness: 0 });
    expect(rt.status.effectiveMode).toBe("observe");
    expect(rt.gates().mode).toBe("observe");
  });

  it("a rule above the global mode cannot raise it: scope.mode stays the global mode", () => {
    const { rt } = setup({ mode: "observe", routes: [{ match: "/search", mode: "heal" }] });
    expect(rt.status.scope).toMatchObject({ mode: "observe", rule: 0, ceiling: "heal" });
  });
});

// Route rules apply to the path the server sees. The browser never percent-decodes `location.pathname`, while most
// servers route on the decoded path and tolerate a trailing slash, repeated slashes, dot segments or `;` parameters,
// so a link to "/se%61rch" reached the same page as "/search" but escaped a rule scoped to "/search" (0.2.3 review).
// A rule now matches the raw path or its normalised form; `scope.route` stays the raw path. Rules only lower the mode.
describe("route rules match look-alike paths (OPTIONS-SPEC §4.3)", () => {
  const at = (pathname: string, routes: NonNullable<Parameters<typeof setup>[0]>["routes"], mode: "observe" | "guard" | "heal" = "guard") =>
    setup({ mode, routes, extraGlobal: { location: { href: `http://app.test${pathname}`, pathname, search: "" } } }).rt;

  it.each(["/se%61rch", "/search/", "//search", "/search;x=1", "/search;jsessionid=abc/", "/./search", "/x/../search", "/search%2F", "/%2Fsearch", "/search/."])(
    "%s falls under an exact /search rule; scope.route stays raw",
    (pathname) => {
      const rt = at(pathname, [{ match: "/search", mode: "off" }]);
      expect(rt.status.scope).toMatchObject({ route: pathname, rule: 0, mode: "off" });
      expect(rt.status.effectiveMode).toBe("off");
    },
  );

  it("the raw path still matches as before, and a plain /search is unchanged", () => {
    const rt = at("/search", [{ match: "/search", mode: "observe" }]);
    expect(rt.status.scope).toMatchObject({ route: "/search", rule: 0, mode: "observe" });
    expect(at("/other", [{ match: "/search", mode: "off" }]).status.scope).toEqual({ route: "/other", mode: "guard", aggressiveness: 0.5 });
  });

  it("matching is case-sensitive: /Search is not /search (use a RegExp with the i flag)", () => {
    expect(at("/Search", [{ match: "/search", mode: "off" }]).status.scope).toEqual({ route: "/Search", mode: "guard", aggressiveness: 0.5 });
    expect(at("/Search/", [{ match: /^\/search$/i, mode: "off" }]).status.scope).toMatchObject({ rule: 0, mode: "off" });
  });

  it("a glob /admin/* does not cover /admin itself; /admin* does, and the glob sees the normalised path too", () => {
    expect(at("/admin", [{ match: "/admin/*", mode: "off" }]).status.scope.rule).toBeUndefined();
    expect(at("/admin", [{ match: "/admin*", mode: "off" }]).status.scope).toMatchObject({ rule: 0, mode: "off" });
    expect(at("/admin//users/", [{ match: "/admin/*", mode: "off" }]).status.scope).toMatchObject({ rule: 0, mode: "off" });
    expect(at("/%61dmin/users", [{ match: "/admin/*", mode: "off" }]).status.scope).toMatchObject({ rule: 0, mode: "off" });
  });

  it("RegExp and predicate rules see both forms", () => {
    expect(at("/search/", [{ match: /^\/search$/, mode: "off" }]).status.scope).toMatchObject({ rule: 0, mode: "off" });
    const seen: string[] = [];
    expect(at("/se%61rch", [{ match: (r) => (seen.push(r), r === "/search"), mode: "off" }]).status.scope).toMatchObject({ rule: 0, mode: "off" });
    expect(seen).toEqual(["/se%61rch", "/search"]);
    // a malformed escape keeps the raw path (and matches nothing else)
    expect(at("/search%", [{ match: "/search", mode: "off" }]).status.scope.rule).toBeUndefined();
  });

  it("a look-alike path runs no action under an observe rule (guard-tier delay scripted)", async () => {
    const { defaultScript } = await import("./helpers.js");
    const s = setup({
      routes: [{ match: "/search", mode: "observe" }],
      triage: "always",
      script: defaultScript({ request: { diagnosis: "overload", action: "delay" } }),
      extraGlobal: { location: { href: "http://app.test/se%61rch", pathname: "/se%61rch", search: "" } },
    });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    expect(s.rt.status.effectiveMode).toBe("observe");
    expect(s.rt.interventions().length).toBe(0);
  });
});
