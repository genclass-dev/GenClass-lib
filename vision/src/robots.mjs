// robots.txt rules for the visual crawl (crawl.mjs): the group for our user agent token, else "*"; the longest
// matching Allow or Disallow wins, Allow on a tie; "*" and a trailing "$" as in RFC 9309. Pure, tested without a
// browser (test/extract.test.mjs).

/** Parse robots.txt and say whether `path` is allowed for `agent` (longest match wins; Allow wins a tie). */
export function robotsAllows(text, agent, path = "/") {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const c = line.indexOf(":");
    if (c < 0) continue;
    const k = line.slice(0, c).trim().toLowerCase();
    const v = line.slice(c + 1).trim();
    if (k === "user-agent") {
      if (!lastWasAgent || !cur) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (k === "allow" || k === "disallow") cur.rules.push({ allow: k === "allow", path: v });
    }
  }
  const a = agent.toLowerCase();
  let g = groups.filter((x) => x.agents.some((n) => n !== "*" && a.includes(n)));
  if (!g.length) g = groups.filter((x) => x.agents.includes("*"));
  if (!g.length) return true;
  let best = null;
  for (const grp of g)
    for (const r of grp.rules) {
      if (r.path === "") continue; // "Disallow:" with no path allows everything
      const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
      if (re.test(path)) {
        const len = r.path.length;
        if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
      }
    }
  return best ? best.allow : true;
}

