// Request triage after a browser back/forward traversal (CONTRACT §6 Triage). A page that fetches on mount, re-mounted
// by fast back/forward clicks, sent one GET per navigation; each carried the identical-request fact ("2 identical GET …
// requests in the last 10s: …; #22 started 0.12s before this one, neither from a user action."), its only non-neutral
// fact, so the model was asked about every re-fetch and called them "overload" at up to 0.98 (Troy Bot, 0.3.0-beta.0,
// back_forward_during_loads: 9 false alarms). The first cause-less GET/HEAD of an identity within 2 s after a
// traversal no longer counts that one fact, up to the identity's 7th request in 10 s (a page's own history.back() loop
// is asked again from its 8th). Fragment navigations (which also fire popstate in Chromium) and pushState navigations
// are not traversals: by the Navigation API's entry key where it exists (a new entry has a fresh key, even when it
// pruned forward entries), else by history.length. User-caused requests, non-GET methods, a second identical request
// after the same traversal and every other non-neutral fact still ask. The nav event and every asked situation keep
// their exact text.
import { describe, expect, it } from "vitest";
import type { EvaluateRequest } from "../src/types.js";
import { ManualDecider, setup, type Setup } from "./helpers.js";

const OBSERVE = { fetch: true, nav: true, xhr: false, user: false, errors: false, storage: false, perf: false, websocket: false, timers: false };

/**
 * A same-document page: `location`, a `history` stub (pushState grows `length`, as a browser does) and a window that
 * receives popstate/hashchange. `back(to)` is a back/forward traversal (length unchanged, popstate; hashchange too when
 * only the fragment differs), followed by the router's own replaceState as Next.js does; `hashNav(h)` is a fragment
 * navigation that adds an entry (popstate, then hashchange, as Chromium fires them); `sameHash()` is a click on the
 * hash link already current (popstate only, nothing grows).
 */
function page(o: Parameters<typeof setup>[0] = {}, opts: { length?: boolean; replace?: boolean } = {}) {
  const win = new EventTarget();
  const loc = { href: "http://app.test/", pathname: "/", search: "", hash: "" };
  const go = (to: string) => {
    const u = new URL(to, loc.href);
    Object.assign(loc, { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash });
  };
  const hist: { length?: number; pushState: History["pushState"]; replaceState: History["replaceState"] } = {
    length: 1,
    pushState: (_s, _t, url) => {
      go(String(url));
      if (hist.length !== undefined) hist.length++;
    },
    replaceState: (_s, _t, url) => go(String(url)),
  };
  if (opts.length === false) delete hist.length;
  const s = setup({
    mode: undefined /* observe, as in Troy Bot */,
    observe: OBSERVE,
    extraGlobal: { location: loc, history: hist, addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win) },
    ...o,
  });
  s.server.on("GET", "/api/orders/current", { body: { order: null }, latency: 10 });
  s.server.on("HEAD", "/api/orders/current", { latency: 10 });
  s.server.on("POST", "/api/visitor", { body: { ok: true }, latency: 10 });
  s.server.on("GET", "/api/article", { body: { title: "x" }, latency: 300 });
  const fire = (type: string) => win.dispatchEvent(new Event(type));
  const back = (to: string) => {
    const hashOnly = new URL(to, loc.href).pathname === loc.pathname;
    go(to);
    fire("popstate");
    if (hashOnly) fire("hashchange");
    if (opts.replace !== false) hist.replaceState(null, "", to); // the router's own replaceState (Troy: two navigate lines)
  };
  const hashNav = (h: string) => {
    go(h);
    if (hist.length !== undefined) hist.length++;
    fire("popstate");
    fire("hashchange");
  };
  const sameHash = () => fire("popstate");
  /** The page's fetch-on-mount (cause-less: React and Next run it in a later task). */
  const load = (init?: RequestInit, url = "/api/orders/current") => void s.fetch(url, init);
  return { s, hist, back, hashNav, sameHash, load };
}

/**
 * A session history as a browser keeps it: entries and an index. A new entry (pushState, a fragment navigation) prunes
 * the forward entries, so `history.length` does not grow right after a back; `history.back()`/`go()` traverse
 * (popstate, then hashchange when only the fragment differs). With `navigation`, the Navigation API's `currentEntry`:
 * a fresh `key` for each new entry, kept by replaceState and location.replace. With `dispatchOnPush`, pushState is a
 * router patch installed before GenClass that dispatches its own popstate inside the call (as single-spa's does).
 */
function session(o: Parameters<typeof setup>[0] = {}, opts: { navigation?: boolean; dispatchOnPush?: boolean } = {}) {
  const win = new EventTarget();
  const loc = { href: "http://app.test/", pathname: "/", search: "", hash: "" };
  const go = (to: string) => {
    const u = new URL(to, loc.href);
    Object.assign(loc, { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash });
  };
  let keys = 0;
  const entries = [{ url: loc.href, key: `k${++keys}` }];
  let index = 0;
  const fire = (type: string) => win.dispatchEvent(new Event(type));
  const add = (to: string) => {
    go(to);
    entries.splice(index + 1);
    entries.push({ url: loc.href, key: `k${++keys}` });
    index = entries.length - 1;
  };
  const traverse = (d: number) => {
    const to = entries[index + d];
    if (!to) return;
    const from = new URL(loc.href);
    const u = new URL(to.url);
    index += d;
    go(to.url);
    fire("popstate");
    if (u.pathname === from.pathname && u.search === from.search && u.hash !== from.hash) fire("hashchange");
  };
  const hist = {
    get length() {
      return entries.length;
    },
    pushState: (_s: unknown, _t: string, url?: string | URL | null) => {
      add(String(url));
      if (opts.dispatchOnPush) fire("popstate");
    },
    replaceState: (_s: unknown, _t: string, url?: string | URL | null) => {
      go(String(url));
      entries[index].url = loc.href;
    },
    back: () => traverse(-1),
    forward: () => traverse(1),
    go: (d: number) => traverse(d),
  };
  const navigation = {
    get currentEntry() {
      return { key: entries[index].key, url: entries[index].url };
    },
  };
  const s = setup({
    mode: undefined /* observe */,
    observe: OBSERVE,
    extraGlobal: {
      location: loc,
      history: hist,
      ...(opts.navigation ? { navigation } : {}),
      addEventListener: win.addEventListener.bind(win),
      removeEventListener: win.removeEventListener.bind(win),
    },
    ...o,
  });
  /** A click on a link to fragment `h`: a new entry (popstate, then hashchange, as Chromium fires them). */
  const hashNav = (h: string) => {
    add(h);
    fire("popstate");
    fire("hashchange");
  };
  /** location.replace("#x"): the current entry's URL changes, its key does not. */
  const replaceHash = (h: string) => {
    go(h);
    entries[index].url = loc.href;
    fire("popstate");
    fire("hashchange");
  };
  const load = (url: string) => void s.fetch(url);
  return { s, hist, hashNav, replaceHash, load };
}

const asked = (s: Setup) => s.decider.calls.filter((c) => c.trigger === "request");
const facts = (c: EvaluateRequest) => c.state.facts as string[];
const ROUTES = ["/menu", "/", "/menu", "/", "/talk", "/"];

describe("request triage after a back/forward traversal (CONTRACT §6 Triage)", () => {
  it("6 fast back/forward traversals, each re-mounting a page that fetches once: the model is not asked", async () => {
    const { s, back, load } = page();
    load();
    await s.clock.advance(3400);
    for (const to of ROUTES) {
      back(to);
      await s.clock.advance(5); // the router renders in a later task
      load();
      await s.clock.advance(145);
    }
    await s.clock.advance(2000);
    expect(s.server.log).toHaveLength(7); // one GET per navigation, all sent
    expect(asked(s)).toHaveLength(0); // was 5, all "neither from a user action"
    // the nav events are unchanged: popstate, then the router's replaceState, both `nav <route>` with { route }
    const nav = s.rt.history().filter((e) => e.kind === "nav");
    expect(nav.map((e) => e.name)).toEqual(ROUTES.flatMap((r) => [r, r]));
    expect(nav.map((e) => e.data)).toEqual(ROUTES.flatMap((r) => [{ route: r }, { route: r }]));
    s.rt.destroy();
  });

  it("the same, without the router's replaceState and with HEAD requests", async () => {
    const { s, back, load } = page({}, { replace: false });
    load({ method: "HEAD" });
    await s.clock.advance(3400);
    for (const to of ROUTES) {
      back(to);
      load({ method: "HEAD" });
      await s.clock.advance(150);
    }
    expect(s.server.log).toHaveLength(7);
    expect(asked(s)).toHaveLength(0);
    s.rt.destroy();
  });

  it("an unknown history.length counts as unchanged: a popstate to another route is a traversal", async () => {
    const { s, back, load } = page({}, { length: false });
    load();
    await s.clock.advance(3400);
    for (const to of ROUTES) {
      back(to);
      await s.clock.advance(5);
      load();
      await s.clock.advance(145);
    }
    expect(asked(s)).toHaveLength(0);
    s.rt.destroy();
  });

  it("6 identical GETs 150 ms apart with no traversal and no user action are still asked about, with today's text", async () => {
    const { s, load } = page();
    load();
    await s.clock.advance(3400);
    for (let i = 0; i < 6; i++) {
      load();
      await s.clock.advance(150);
    }
    await s.clock.advance(2000);
    expect(asked(s)).toHaveLength(5);
    expect(facts(asked(s)[0])[0]).toMatch(/^2 identical GET \/api\/orders\/current requests in the last 10s: .*neither from a user action\.$/);
    s.rt.destroy();
  });

  it("pushState and replaceState navigations (a router push, a redirect) are not traversals: still asked", async () => {
    const { s, hist, load } = page();
    load();
    await s.clock.advance(3400);
    for (const to of ROUTES) {
      hist.pushState(null, "", to);
      await s.clock.advance(5);
      load();
      await s.clock.advance(145);
    }
    expect(asked(s)).toHaveLength(5);
    // replaceState to another route: nothing grows, the route differs, still not a traversal
    hist.replaceState(null, "", "/login");
    await s.clock.advance(5);
    load();
    await s.clock.advance(145);
    expect(asked(s)).toHaveLength(6);
    s.rt.destroy();
  });

  it("a fast hash-router route-change loop (history grows; Chromium fires popstate) is still asked", async () => {
    const { s, hashNav, sameHash, load } = page();
    load();
    await s.clock.advance(3400);
    for (let i = 0; i < 6; i++) {
      hashNav(`#/r${i % 2}`);
      await s.clock.advance(5);
      load();
      await s.clock.advance(145);
    }
    expect(asked(s)).toHaveLength(5);
    // a click on the hash link already current: popstate, nothing grows, the route is the same
    sameHash();
    await s.clock.advance(5);
    load();
    await s.clock.advance(145);
    expect(asked(s)).toHaveLength(6);
    s.rt.destroy();
  });

  it("a double-clicked hash link whose click handler fetches is still asked exactly as today", async () => {
    const { s, hashNav, sameHash, load } = page();
    const click = () => s.rt.user({ kind: "click", target: 'link "Article"' }, () => load(undefined, "/api/article?slug=x"));
    click();
    hashNav("#x"); // the link's default action after the handler: a new entry
    await s.clock.advance(120);
    click();
    sameHash(); // the same hash again: popstate only
    await s.clock.advance(2000);
    expect(asked(s)).toHaveLength(1);
    expect(facts(asked(s)[0]).join("\n")).toMatch(/in flight .*they come from separate user actions 0\.12s apart/);
    s.rt.destroy();
  });

  it("a user action's identical GET right after a traversal is still asked", async () => {
    const { s, back, load } = page();
    load();
    await s.clock.advance(500);
    back("/menu");
    await s.clock.advance(5);
    s.rt.user({ kind: "click", target: 'button "Refresh"' }, () => load());
    await s.clock.advance(2000);
    expect(asked(s)).toHaveLength(1);
    s.rt.destroy();
  });

  it("a hot request rate (the baseline fact) still asks after a traversal", async () => {
    const run = async (o: Parameters<typeof setup>[0]) => {
      const { s, back, load } = page(o);
      for (let i = 0; i < 4; i++) {
        load(); // a usual rate: one every 10 s
        await s.clock.advance(10_000);
      }
      for (const to of ROUTES) {
        back(to);
        await s.clock.advance(5);
        load();
        await s.clock.advance(145);
      }
      const out = asked(s).map((c) => {
        // "GET /api/orders/current was requested 5 times in the last 10s; usually 1 per 10s (5×)."
        const m = facts(c).map((f) => / requested (\d+) times in the last 10s; usually ([\d.]+) per 10s/.exec(f)).find(Boolean);
        return { subject: JSON.stringify(c.subject), hot: !!m && Number(m[1]) >= 5 && Number(m[1]) >= 3 * Number(m[2]) };
      });
      s.rt.destroy();
      return out;
    };
    // the re-fetches whose rate fact is non-neutral (5 or more in 10 s, 3x the usual rate), read from every situation
    const hot = (await run({ triage: "always" })).filter((c) => c.hot).map((c) => c.subject);
    expect(hot.length).toBeGreaterThan(0);
    expect((await run({})).map((c) => c.subject)).toEqual(expect.arrayContaining(hot));
  });

  it("a POST re-sent after each traversal is not exempt", async () => {
    const { s, back, load } = page();
    const post = () => load({ method: "POST", body: "{}", headers: { "content-type": "application/json" } }, "/api/visitor");
    post();
    await s.clock.advance(3400);
    for (const to of ROUTES) {
      back(to);
      await s.clock.advance(5);
      post();
      await s.clock.advance(145);
    }
    expect(asked(s)).toHaveLength(5);
    s.rt.destroy();
  });

  it("a second identical GET after the same traversal is still asked", async () => {
    const { s, back, load } = page();
    load();
    await s.clock.advance(3400);
    for (const to of ROUTES) {
      back(to);
      await s.clock.advance(5);
      load();
      await s.clock.advance(40);
      load();
      await s.clock.advance(105);
    }
    // was 11: now the second GET of each pair, and from the 4th traversal on the first one too (the identity then has
    // more than 7 requests in 10 s: a loop, not a person's clicks)
    expect(asked(s)).toHaveLength(9);
    s.rt.destroy();
  });

  it("the exemption ends 2 s after the traversal", async () => {
    const run = async (after: number) => {
      const { s, back, load } = page();
      s.server.on("GET", "/api/orders/current", { body: { order: null }, latency: 5000 });
      load(); // still in flight when the page fetches again
      await s.clock.advance(100);
      back("/menu");
      await s.clock.advance(after);
      load();
      await s.clock.advance(6000);
      const n = asked(s).length;
      s.rt.destroy();
      return n;
    };
    expect(await run(1900)).toBe(0);
    expect(await run(2100)).toBe(1);
  });

  it('triage: "always" still asks about every request after a traversal', async () => {
    const { s, back, load } = page({ triage: "always" });
    load();
    await s.clock.advance(3400);
    for (const to of ROUTES) {
      back(to);
      await s.clock.advance(5);
      load();
      await s.clock.advance(145);
    }
    expect(asked(s)).toHaveLength(7);
    s.rt.destroy();
  });

  it("guard: the re-fetch after a traversal is sent at once, a duplicate is still held for the model", async () => {
    const decider = new ManualDecider();
    const { s, back, load } = page({ mode: "guard", decider });
    load();
    await s.clock.advance(150);
    back("/menu");
    await s.clock.advance(5);
    load(); // 0.155 s after the identical GET before the traversal
    await s.clock.flush();
    expect(decider.pending).toHaveLength(0); // was 1, the GET held for it
    expect(s.server.log.map((l) => l.t)).toEqual([1000, 1155]);
    await s.clock.advance(40);
    load(); // a second identical GET after the same traversal
    await s.clock.flush();
    expect(decider.pending).toHaveLength(1);
    decider.answer();
    await s.clock.advance(100);
    expect(s.server.log).toHaveLength(3);
    s.rt.destroy();
  });
});

describe("request triage after a traversal: loops and entry identity (CONTRACT §6 Triage)", () => {
  /** Asked situations whose identical-request fact is about `GET <path>`. */
  const askedFor = (s: Setup, path: string) => asked(s).filter((c) => facts(c).some((f) => f.includes(` identical GET ${path} requests `))).length;

  for (const navigation of [false, true]) {
    it(`a page's own pushState + history.back() loop keeps being asked once an identity passes 7 requests in 10 s (${navigation ? "Navigation API" : "history.length"})`, async () => {
      // redirect ping-pong: /a pushes /b, /b's guard calls history.back(); each page fetches on mount (cause-less)
      const { s, hist, load } = session({}, { navigation });
      s.server.on("GET", "/api/a", { body: { a: 1 }, latency: 300 });
      s.server.on("GET", "/api/b", { body: { b: 1 }, latency: 300 });
      load("/api/a");
      await s.clock.advance(3000);
      for (let i = 0; i < 20; i++) {
        hist.pushState(null, "", "/b");
        await s.clock.advance(5);
        load("/api/b");
        await s.clock.advance(70);
        hist.back(); // history.length stays 2: the push pruned the forward entry
        expect(hist.length).toBe(2);
        await s.clock.advance(5);
        load("/api/a");
        await s.clock.advance(70);
      }
      await s.clock.advance(2000);
      expect(s.server.log).toHaveLength(41);
      // up to its 7th request within 10 s, each re-fetch is exempt (the 1st /api/b has no identical one, the 2nd /api/a
      // none close enough); from the 8th on every one is asked: /api/a's 8th to 21st, /api/b's 8th to 20th (was 0)
      expect(askedFor(s, "/api/a")).toBe(14);
      expect(askedFor(s, "/api/b")).toBe(13);
      s.rt.destroy();
    });
  }

  it("Navigation API: 6 fast back/forward traversals to entries seen before are not asked", async () => {
    const { s, hist, load } = session({}, { navigation: true });
    s.server.on("GET", "/api/orders/current", { body: { order: null }, latency: 10 });
    load("/api/orders/current");
    hist.pushState(null, "", "/menu");
    hist.pushState(null, "", "/talk");
    await s.clock.advance(3400);
    for (const d of [-1, -1, 1, 1, -1, -1]) {
      hist.go(d);
      await s.clock.advance(5);
      load("/api/orders/current");
      await s.clock.advance(145);
    }
    await s.clock.advance(2000);
    expect(s.server.log).toHaveLength(7);
    expect(asked(s)).toHaveLength(0);
    s.rt.destroy();
  });

  /** On #/feed, open #/article, back; > 2 s later, with a cause-less prefetch of the article in flight, the user clicks the #/article link again (a new entry: the forward one is pruned, history.length does not grow) and the route fetches it. */
  async function fragmentAfterBack(navigation: boolean) {
    const { s, hist, hashNav, load } = session({}, { navigation });
    s.server.on("GET", "/api/article", { body: { title: "x" }, latency: 5000 });
    hashNav("#/feed");
    hashNav("#/article");
    await s.clock.advance(1000);
    hist.back();
    await s.clock.advance(2500);
    load("/api/article"); // the prefetch, still in flight below
    await s.clock.advance(100);
    const len = hist.length;
    hashNav("#/article");
    expect(hist.length).toBe(len);
    await s.clock.advance(5);
    load("/api/article"); // the route's own fetch, from its hashchange handler (a later task, no user action)
    await s.clock.advance(6000);
    const n = asked(s).length;
    s.rt.destroy();
    return n;
  }

  it("Navigation API: a fragment navigation right after a back is a new entry, not a traversal: its duplicate GET is asked", async () => {
    expect(await fragmentAfterBack(true)).toBe(1);
  });

  it("history.length fallback (no Navigation API): that fragment navigation counts as a traversal (documented misread)", async () => {
    expect(await fragmentAfterBack(false)).toBe(0);
  });

  it("Navigation API: a pushState whose earlier patch dispatches popstate inside the call is not a traversal", async () => {
    const { s, hist, load } = session({}, { navigation: true, dispatchOnPush: true });
    s.server.on("GET", "/api/a", { body: { a: 1 }, latency: 5000 });
    hist.pushState(null, "", "/a");
    await s.clock.advance(1000);
    hist.back();
    await s.clock.advance(2500);
    load("/api/a"); // a prefetch, in flight
    await s.clock.advance(100);
    hist.pushState(null, "", "/a"); // the router's push: its patch fires popstate before GenClass's wrapper returns
    await s.clock.advance(5);
    load("/api/a");
    await s.clock.advance(6000);
    expect(asked(s)).toHaveLength(1);
    s.rt.destroy();
  });

  it("Navigation API: location.replace(\"#x\") keeps the entry's key, so it is not a traversal", async () => {
    const { s, replaceHash, load } = session({}, { navigation: true });
    s.server.on("GET", "/api/article", { body: { title: "x" }, latency: 5000 });
    load("/api/article");
    await s.clock.advance(100);
    replaceHash("#/article");
    await s.clock.advance(5);
    load("/api/article");
    await s.clock.advance(6000);
    expect(asked(s)).toHaveLength(1);
    s.rt.destroy();
  });
});
