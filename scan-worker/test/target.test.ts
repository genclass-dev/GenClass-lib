// URL normalisation, the SSRF block list (IPv4/IPv6 in every literal form, IDN, trailing dots, userinfo), the DNS
// check and the robots.txt opt-out.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockedIPv4, blockedIPv6, classifyIp, parseIPv4, parseIPv6 } from "../src/ip.ts";
import { blockedAddress, hostAllowedForRequest, normaliseTarget, resolveCheck, robotsCheck, robotsDisallows, robotsRulesFor } from "../src/target.ts";
import { fakeFetch } from "./helpers.ts";

const ok = (input: string) => {
  const t = normaliseTarget(input);
  assert.ok(t.ok, `${input} should be accepted: ${JSON.stringify(t)}`);
  return t;
};
const no = (input: string, code?: string) => {
  const t = normaliseTarget(input);
  assert.equal(t.ok, false, `${input} should be refused, got ${JSON.stringify(t)}`);
  if (code && !t.ok) assert.equal(t.code, code, `${input}: ${t.message}`);
  return t;
};

describe("IPv4 literals in every form", () => {
  it("parses dotted, short, decimal, hex and octal forms to the same address", () => {
    for (const f of ["127.0.0.1", "127.1", "2130706433", "0x7f000001", "0x7f.0.0.1", "0177.0.0.1", "0177.0.0.01", "127.0.0.1."]) {
      assert.deepEqual(parseIPv4(f), [127, 0, 0, 1], f);
    }
    assert.deepEqual(parseIPv4("3232235777"), [192, 168, 1, 1]);
    assert.equal(parseIPv4("256.0.0.1"), null);
    assert.equal(parseIPv4("1.2.3.4.5"), null);
    assert.equal(parseIPv4("example"), null);
  });
  it("classifies the blocked ranges", () => {
    const cases: [string, string | null][] = [
      ["127.0.0.1", "loopback"], ["10.1.2.3", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["172.32.0.1", null],
      ["192.168.0.1", "private"], ["169.254.169.254", "metadata"], ["169.254.10.1", "link-local"], ["100.64.0.1", "cgnat"],
      ["100.100.100.200", "cgnat"], ["100.128.0.1", null], ["0.0.0.0", "this-network"], ["224.0.0.1", "multicast"],
      ["255.255.255.255", "reserved"], ["192.0.2.1", "documentation"], ["198.18.0.1", "benchmark"], ["8.8.8.8", null], ["1.1.1.1", null],
    ];
    for (const [ip, why] of cases) assert.equal(blockedIPv4(parseIPv4(ip)!), why, ip);
  });
});

describe("IPv6 literals", () => {
  it("parses compressed forms, brackets, zone ids and IPv4 tails", () => {
    assert.deepEqual(parseIPv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIPv6("[::1]"), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIPv6("fe80::1%eth0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIPv6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    assert.deepEqual(parseIPv6("2001:db8::8a2e:370:7334"), [0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334]);
    assert.equal(parseIPv6("1::2::3"), null);
    assert.equal(parseIPv6("12345::"), null);
  });
  it("classifies loopback, mapped, NAT64, 6to4, ULA, link-local and metadata", () => {
    const cases: [string, string | null][] = [
      ["::1", "loopback"], ["::", "unspecified"], ["::ffff:10.0.0.1", "private"], ["::ffff:7f00:1", "loopback"], ["::ffff:8.8.8.8", null],
      ["64:ff9b::a9fe:a9fe", "metadata"], ["2002:c0a8:0101::1", "private"], ["fd00::1", "private"], ["fc00::1", "private"],
      ["fe80::1", "link-local"], ["fd00:ec2::254", "metadata"], ["ff02::1", "multicast"], ["2001:db8::1", "documentation"],
      ["2606:4700:4700::1111", null],
    ];
    for (const [ip, why] of cases) assert.equal(blockedIPv6(parseIPv6(ip)!), why, ip);
  });
  it("classifyIp tells IP literals from names", () => {
    assert.equal(classifyIp("example.com"), null);
    assert.equal(classifyIp("1password.com"), null);
    assert.deepEqual(classifyIp("[::1]"), { version: 6, blocked: "loopback" });
    assert.deepEqual(classifyIp("8.8.8.8"), { version: 4, blocked: null });
  });
});

describe("normaliseTarget: what a person types", () => {
  it("adds https:// and keeps the path and query, drops the fragment", () => {
    const t = ok("example.com/pricing?plan=pro#faq");
    assert.equal(t.url, "https://example.com/pricing?plan=pro");
    assert.equal(t.display, "example.com/pricing?plan=pro");
    assert.equal(ok("  Example.COM  ").url, "https://example.com/");
    assert.equal(ok("//example.com/a").url, "https://example.com/a");
    assert.equal(ok("http://example.com").url, "http://example.com/");
    assert.equal(ok("https:example.com").url, "https://example.com/");
    assert.equal(ok("https:/example.com/x/").display, "example.com/x");
    assert.equal(ok("example.com/?ref=a").display, "example.com/?ref=a");
  });
  it("accepts only http and https", () => {
    for (const s of ["ftp://example.com", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ws://example.com", "chrome://settings", "view-source:https://example.com"]) no(s, "scheme");
  });
  it("strips credentials, and judges the real host after the userinfo", () => {
    const t = ok("https://user:secret@example.com/");
    assert.equal(t.url, "https://example.com/");
    assert.ok(!t.url.includes("secret"));
    no("https://example.com@127.0.0.1/", "ip");
    no("example.com:pass@169.254.169.254/latest/meta-data", "ip");
  });
  it("refuses non-default ports", () => {
    no("example.com:8080", "port");
    assert.equal(ok("https://example.com:443/").url, "https://example.com/");
    assert.equal(ok("http://example.com:80/").url, "http://example.com/");
  });
  it("refuses every IP literal, private ones with the reason", () => {
    for (const s of ["127.0.0.1", "http://2130706433/", "http://0x7f000001", "http://0177.0.0.1/", "127.1", "[::1]", "http://[::ffff:127.0.0.1]/", "[fe80::1]", "[fd00::1]", "169.254.169.254", "100.100.100.200", "10.0.0.1", "8.8.8.8", "[2606:4700:4700::1111]"]) no(s, "ip");
    assert.match((no("169.254.169.254") as { message: string }).message, /metadata/);
    assert.match((no("8.8.8.8") as { message: string }).message, /hostname/);
  });
  it("refuses local and reserved names, with or without a trailing dot", () => {
    for (const s of ["localhost", "localhost.", "app.localhost", "printer.local", "db.internal", "metadata.google.internal", "site.test", "x.example", "a.invalid", "abc.onion", "1.0.0.127.in-addr.arpa", "router.home.arpa", "nas.lan"]) no(s, "local");
  });
  it("refuses genclass.dev and the scanner itself", () => {
    for (const s of ["genclass.dev", "https://www.genclass.dev/pricing", "genclass.dev.", "genclass-scan.mehar-144.workers.dev"]) no(s, "self");
  });
  it("needs a public top-level domain", () => {
    for (const s of ["intranet", "foo.notatld", "myserver", "a..com", "-a.com", "a-.com"]) assert.equal(normaliseTarget(s).ok, false, s);
    ok("example.co.uk");
    ok("example.dev");
    ok("shop.example.app");
  });
  it("turns IDNs into punycode and keeps internationalised TLDs", () => {
    assert.equal(ok("bücher.de").host, "xn--bcher-kva.de");
    assert.equal(ok("例子.中国").host, "xn--fsqu00a.xn--fiqs8s");
    assert.equal(ok("EXAMPLE.com.").host, "example.com");
  });
  it("refuses empty, oversized, whitespace and non-string input", () => {
    no("", "invalid");
    no("   ", "invalid");
    no(`example.com/${"a".repeat(2100)}`, "invalid");
    no("exa mple.com", "invalid");
    no("example.com/\u0000", "invalid");
    assert.equal(normaliseTarget(42).ok, false);
    assert.equal(normaliseTarget(null).ok, false);
  });
});

describe("hostAllowedForRequest: every request and redirect hop in the browser", () => {
  it("aborts private literals and local names, lets public hosts and data: through", () => {
    for (const u of ["http://127.0.0.1/admin", "http://2130706433/", "http://[::1]:8080/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://localhost:3000/", "http://db.internal/", "http://printer.local/"]) {
      assert.equal(hostAllowedForRequest(u).ok, false, u);
    }
    for (const u of ["https://example.com/a.css", "https://8.8.8.8/x", "data:image/png;base64,AAAA", "blob:https://example.com/1", "https://genclass.dev/model/x"]) assert.equal(hostAllowedForRequest(u).ok, true, u);
    assert.equal(hostAllowedForRequest("ftp://example.com/").ok, false);
  });
});

describe("resolveCheck: DNS answers", () => {
  it("accepts a public name and refuses names that resolve privately or not at all", async () => {
    const { fetch } = fakeFetch({ "example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"], "evil.example.com": ["127.0.0.1"], "mixed.com": ["8.8.8.8", "10.0.0.1"], "v6.com": ["fd00::1"], "gone.com": "nx" });
    assert.equal((await resolveCheck("example.com", fetch)).ok, true);
    for (const [h, code] of [["evil.example.com", "private"], ["mixed.com", "private"], ["v6.com", "private"], ["gone.com", "nxdomain"]]) {
      const r = await resolveCheck(h, fetch);
      assert.equal(r.ok, false, h);
      assert.equal((r as { code: string }).code, code, h);
    }
  });
  it("fails closed when the resolver cannot be reached", async () => {
    const r = await resolveCheck("example.com", async () => {
      throw new Error("offline");
    });
    assert.equal(r.ok, false);
    assert.equal((r as { code: string }).code, "dns");
  });
  it("blockedAddress covers both families", () => {
    assert.equal(blockedAddress("192.168.1.1"), "private");
    assert.equal(blockedAddress("::ffff:192.168.1.1"), "private");
    assert.equal(blockedAddress("1.1.1.1"), null);
  });
});

describe("robots.txt: a GenClassScan group opts a site out", () => {
  const txt = "User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n\nuser-agent: genclassscan\nDisallow: /private\nAllow: /private/ok$\n";
  it("reads only the group that names GenClassScan, case-insensitively", () => {
    const rules = robotsRulesFor(txt, "GenClassScan")!;
    assert.deepEqual(rules, [{ allow: false, path: "/private" }, { allow: true, path: "/private/ok$" }]);
    assert.equal(robotsRulesFor("User-agent: *\nDisallow: /", "GenClassScan"), null);
  });
  it("longest match wins and Allow wins a tie; * and $ work", () => {
    const rules = robotsRulesFor(txt, "GenClassScan")!;
    assert.equal(robotsDisallows(rules, "/"), false);
    assert.equal(robotsDisallows(rules, "/private/x"), true);
    assert.equal(robotsDisallows(rules, "/private/ok"), false);
    assert.equal(robotsDisallows([{ allow: false, path: "/*.php$" }], "/a/b.php"), true);
    assert.equal(robotsDisallows([{ allow: false, path: "/*.php$" }], "/a/b.php?x"), false);
  });
  it("robotsCheck refuses a disallowed page and allows when robots.txt is missing", async () => {
    const t = ok("example.com/private/page");
    const blocked = await robotsCheck(t, fakeFetch({}, { "example.com": "User-agent: GenClassScan\nDisallow: /\n" }).fetch, "ua");
    assert.equal(blocked.ok, false);
    assert.equal((await robotsCheck(t, fakeFetch({}, {}).fetch, "ua")).ok, true);
    assert.equal((await robotsCheck(t, fakeFetch({}, { "example.com": "User-agent: *\nDisallow: /\n" }).fetch, "ua")).ok, true);
  });
  it("does not follow a robots.txt redirect to a private host", async () => {
    const t = ok("example.com/");
    const calls: string[] = [];
    const r = await robotsCheck(t, async (u) => {
      calls.push(u);
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/robots.txt" } });
    }, "ua");
    assert.equal(r.ok, true);
    assert.deepEqual(calls, ["https://example.com/robots.txt"]);
  });
});
