// URL discovery for the visual crawl: one homepage per host on AI-builder hosting domains, from the Common Crawl
// URL index (CDX records of the latest crawls), plus a sampled control list from the Tranco top sites. Runs on a
// cluster node, never on the Mac.
//
// Two ways to read the same CDX records:
// - files (default): the crawl's ZipNum index on data.commoncrawl.org. cluster.idx (about 100 MB per crawl) maps
//   SURT key ranges to gzip blocks of about 3,000 CDX lines in cdx-NNNNN.gz; a domain's blocks are found by binary
//   search and read with HTTP range requests. This is what the CDX API server does internally, without its queue
//   (the API answered 502 to about half of our requests on 2026-10-13).
// - api: the CDX API at index.commoncrawl.org (showNumPages, then page=N), a few requests in flight, backoff on 429
//   and 5xx.
// Raw responses are cached on disk, so a rerun resumes instead of asking again.
//
//   node src/discover.mjs [--out DIR] [--via files|api] [--crawl CC-MAIN-YYYY-WW] [--crawls 3] [--seed 7]
//                         [--ai-blocks 400] [--mixed-blocks 40] [--ai-hosts 8000] [--mixed-hosts 1500]
//                         [--control 4000] [--control-top 100000] [--only lovable.app,bolt.host]
//
// Output (DIR, default ~/vision-out/discover):
//   urls.jsonl     one row per host: {url, host, group, builder, domain, source, crawl, ts, rank, shard}
//   summary.json   per domain and crawl: index blocks or pages, read, captures, hosts, kept, errors; control counts
//   cache/         cluster.idx files, CDX blocks or pages, and the Tranco list
//
// Groups: "ai-builder" (hosting domains that only serve apps made with an AI builder), "mixed-host" (general
// hosting that AI builders deploy to, sampled; the crawl records builder fingerprints so these can be split later),
// "control" (Tranco top sites, sampled by rank band). A host appears once; the first group that finds it wins, in
// the order ai-builder, mixed-host, control; within a domain the newest crawl's capture wins.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** Hosting domains. `builder` is the tool that owns the domain (null for mixed hosts). */
export const DOMAINS = [
  { domain: "lovable.app", group: "ai-builder", builder: "lovable" },
  { domain: "lovableproject.com", group: "ai-builder", builder: "lovable" },
  { domain: "bolt.host", group: "ai-builder", builder: "bolt" },
  { domain: "replit.app", group: "ai-builder", builder: "replit" },
  { domain: "repl.co", group: "ai-builder", builder: "replit" },
  { domain: "base44.app", group: "ai-builder", builder: "base44" },
  { domain: "manus.space", group: "ai-builder", builder: "manus" },
  { domain: "created.app", group: "ai-builder", builder: "create" },
  { domain: "windsurf.build", group: "ai-builder", builder: "windsurf" },
  { domain: "emergent.host", group: "ai-builder", builder: "emergent" },
  { domain: "genspark.space", group: "ai-builder", builder: "genspark" },
  { domain: "mocha.app", group: "ai-builder", builder: "mocha" },
  { domain: "vusercontent.net", group: "ai-builder", builder: "v0" },
  { domain: "v0.app", group: "ai-builder", builder: "v0" },
  { domain: "vercel.app", group: "mixed-host", builder: null },
  { domain: "netlify.app", group: "mixed-host", builder: null },
  { domain: "pages.dev", group: "mixed-host", builder: null },
  { domain: "onrender.com", group: "mixed-host", builder: null },
  { domain: "web.app", group: "mixed-host", builder: null },
  { domain: "hosted.app", group: "mixed-host", builder: null },
];

const INDEX = "https://index.commoncrawl.org";
const UA = "genclass-vision-discover/0.1 (+https://genclass.dev; research crawl of public homepages)";

/** Parse --flags into an object (numbers where they look like numbers). */
export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    o[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return o;
}

/** A small seeded RNG (mulberry32), so samples are reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k distinct integers from 0..n-1, sorted, chosen by `rand`. */
export function sampleIndices(n, k, rand) {
  if (k >= n) return [...Array(n).keys()];
  const a = [...Array(n).keys()];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (n - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k).sort((x, y) => x - y);
}

/** Host of a URL, lowercased, without a trailing dot; null when it does not parse. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** The dedupe key for a host: lowercased, a leading www. dropped. */
export function hostKey(host) {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Hosts that are the platform itself, not a user app (the bare domain, www, api, docs and similar). */
export function isPlatformHost(host, domain) {
  if (host === domain) return true;
  const sub = host.slice(0, -(domain.length + 1));
  return /^(www|api|docs|app|status|blog|help|support|cdn|static|assets|admin|dashboard|auth|login)$/.test(sub);
}

/** Stable shard number 0..255 for a host (crawl.mjs splits the list by it). */
export function shardOf(host) {
  return createHash("sha1").update(host).digest()[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with retries: backoff on 429, 503 and network errors; 404 returns null. Caches the body on disk. */
async function fetchCached(url, cacheDir, { timeoutMs = 120000, tries = 7 } = {}) {
  const key = createHash("sha1").update(url).digest("hex").slice(0, 20);
  const path = join(cacheDir, key);
  if (existsSync(path)) return readFile(path, "utf8");
  let wait = 4000;
  for (let t = 1; t <= tries; t++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) {
        await writeFile(path, "");
        return "";
      }
      if (res.ok) {
        const body = await res.text();
        await writeFile(path, body);
        return body;
      }
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
    } catch (e) {
      if (e.fatal) throw e;
    }
    await sleep(wait + Math.floor(Math.random() * 1000));
    wait = Math.min(wait * 2, 90000);
  }
  throw new Error(`gave up after ${tries} tries: ${url}`);
}

/** The latest crawl ids from collinfo.json (newest first). */
async function latestCrawls(n, cacheDir) {
  const body = await fetchCached(`${INDEX}/collinfo.json?d=${new Date().toISOString().slice(0, 10)}`, cacheDir);
  return JSON.parse(body).map((c) => c.id).slice(0, n);
}

/** Parse CDX NDJSON lines into {url, ts, status}. Bad lines are skipped. */
export function parseCdx(body) {
  const out = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.url) out.push({ url: r.url, ts: r.timestamp, status: r.status, mime: r.mime });
    } catch {
      // a truncated or non-JSON line: skip
    }
  }
  return out;
}

/** Simple promise pool. */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, n) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

const DATA = "https://data.commoncrawl.org";

/** The SURT prefix of every subdomain of `domain`: "lovable.app" -> "app,lovable,". */
export function surtPrefix(domain) {
  return `${domain.toLowerCase().split(".").reverse().join(",")},`;
}

/** Parse cluster.idx text into parallel arrays (key, file, offset, length). */
export function parseClusterIdx(text) {
  const keys = [];
  const files = [];
  const offs = [];
  const lens = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const t = line.split("\t");
    if (t.length < 4) continue;
    keys.push(t[0].split(" ")[0]);
    files.push(t[1]);
    offs.push(Number(t[2]));
    lens.push(Number(t[3]));
  }
  return { keys, files, offs, lens };
}

/** Indices of the blocks that can hold keys starting with `prefix` (the block before the first match included). */
export function blocksFor(idx, prefix) {
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  let lo = 0;
  let hi = idx.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (idx.keys[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = Math.max(0, lo - 1); i < idx.keys.length && idx.keys[i] < end; i++) out.push(i);
  return out;
}

/** Parse decompressed CDX block lines ("surt ts {json}") whose key starts with `prefix`. */
export function parseCdxBlock(text, prefix) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const j = line.indexOf("{");
    if (j < 0) continue;
    try {
      const r = JSON.parse(line.slice(j));
      const ts = line.slice(0, j).trim().split(" ")[1];
      out.push({ url: r.url, ts, status: r.status, mime: r.mime, mimeDetected: r["mime-detected"] });
    } catch {
      // a malformed line: skip
    }
  }
  return out;
}

const idxCache = new Map();
/** cluster.idx of a crawl, downloaded once into the cache. */
async function clusterIdx(crawl, cacheDir) {
  if (idxCache.has(crawl)) return idxCache.get(crawl);
  const path = join(cacheDir, `${crawl}-cluster.idx`);
  if (!existsSync(path)) {
    const tmp = `${path}.part`;
    for (let t = 1; ; t++) {
      try {
        const res = await fetch(`${DATA}/cc-index/collections/${crawl}/indexes/cluster.idx`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(600000) });
        if (!res.ok) throw new Error(`cluster.idx HTTP ${res.status}`);
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
        await import("node:fs/promises").then((f) => f.rename(tmp, path));
        break;
      } catch (e) {
        if (t >= 4) throw e;
        await sleep(5000 * t);
      }
    }
  }
  const idx = parseClusterIdx(await readFile(path, "utf8"));
  idxCache.set(crawl, idx);
  return idx;
}

/** One gzip block of a crawl's CDX files, by range request (cached as decompressed text). */
async function cdxBlock(crawl, idx, i, cacheDir) {
  const path = join(cacheDir, `${crawl}-${idx.files[i]}-${idx.offs[i]}.txt`);
  if (existsSync(path)) return readFile(path, "utf8");
  let wait = 2000;
  for (let t = 1; t <= 6; t++) {
    try {
      const res = await fetch(`${DATA}/cc-index/collections/${crawl}/indexes/${idx.files[i]}`, {
        headers: { "user-agent": UA, range: `bytes=${idx.offs[i]}-${idx.offs[i] + idx.lens[i] - 1}` },
        signal: AbortSignal.timeout(120000),
      });
      if (res.status === 206 || res.status === 200) {
        const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
        await writeFile(path, text);
        return text;
      }
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
    } catch (e) {
      if (e.fatal) throw e;
    }
    await sleep(wait);
    wait = Math.min(wait * 2, 60000);
  }
  throw new Error(`block ${idx.files[i]}@${idx.offs[i]}: gave up`);
}

/** Fold one capture into the per-host map: newest capture wins, a root-path capture beats any other path. */
function addCapture(hosts, d, r) {
  if (String(r.status) !== "200") return false;
  const mime = String(r.mime || r.mimeDetected || "");
  if (!/html/.test(mime)) return false;
  const h = hostOf(r.url);
  if (!h || !(h === d.domain || h.endsWith(`.${d.domain}`)) || isPlatformHost(h, d.domain)) return false;
  const k = hostKey(h);
  const prev = hosts.get(k);
  const root = /^https?:\/\/[^/]+\/?(\?.*)?$/.test(r.url);
  if (!prev || (root && !prev.root) || (root === prev.root && r.ts > prev.ts)) hosts.set(k, { host: h, ts: r.ts, root });
  return true;
}

/** One domain on one crawl through the ZipNum files. */
async function discoverDomainFiles(d, crawl, opts, cacheDir, rand) {
  const info = { domain: d.domain, crawl, via: "files", blocks: 0, read: 0, captures: 0, hosts: 0, errors: [] };
  const hosts = new Map();
  let idx;
  try {
    idx = await clusterIdx(crawl, cacheDir);
  } catch (e) {
    info.errors.push(String(e.message || e).slice(0, 200));
    return { info, hosts };
  }
  const prefix = surtPrefix(d.domain);
  const all = blocksFor(idx, prefix);
  info.blocks = all.length;
  const cap = d.group === "ai-builder" ? opts.aiBlocks : opts.mixedBlocks;
  const chosen = sampleIndices(all.length, cap, rand).map((i) => all[i]);
  await pool(chosen, opts.blockConcurrency, async (i) => {
    let text;
    try {
      text = await cdxBlock(crawl, idx, i, cacheDir);
    } catch (e) {
      info.errors.push(String(e.message || e).slice(0, 160));
      return;
    }
    info.read++;
    for (const r of parseCdxBlock(text, prefix)) {
      info.captures++;
      addCapture(hosts, d, r);
    }
  });
  info.hosts = hosts.size;
  return { info, hosts };
}

/** One domain on one crawl: page count, a seeded sample of index pages, hosts with a 200 text/html capture. */
async function discoverDomain(d, crawl, opts, cacheDir, rand) {
  const base = `${INDEX}/${crawl}-index?url=${encodeURIComponent(`*.${d.domain}`)}&output=json`;
  const info = { domain: d.domain, crawl, via: "api", pages: 0, read: 0, captures: 0, hosts: 0, errors: [] };
  let pages = 0;
  try {
    const meta = JSON.parse((await fetchCached(`${base}&showNumPages=true`, cacheDir)) || "{}");
    pages = Number(meta.pages) || 0;
  } catch (e) {
    info.errors.push(String(e.message || e).slice(0, 200));
    return { info, hosts: new Map() };
  }
  info.pages = pages;
  const cap = d.group === "ai-builder" ? opts.aiPages : opts.mixedPages;  // api pages hold about 5 blocks each
  const wantHosts = d.group === "ai-builder" ? opts.aiHosts : opts.mixedHosts;
  // a seeded sample of index pages, read in shuffled order so stopping at wantHosts does not favour early hosts
  const chosen = sampleIndices(pages, cap, rand);
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }
  const hosts = new Map();
  const fl = "url,timestamp,status,mime";
  await pool(chosen, opts.concurrency, async (p) => {
    if (hosts.size >= wantHosts) return;
    let body;
    try {
      body = await fetchCached(`${base}&fl=${fl}&filter=status:200&filter=mime:text/html&page=${p}`, cacheDir);
    } catch (e) {
      info.errors.push(`page ${p}: ${String(e.message || e).slice(0, 160)}`);
      return;
    }
    info.read++;
    for (const r of parseCdx(body)) {
      info.captures++;
      addCapture(hosts, d, r);
    }
  });
  info.hosts = hosts.size;
  return { info, hosts };
}

/** Tranco: the latest list id through the API, then the top N as CSV (rank,domain). Falls back to the zip. */
async function trancoTop(n, cacheDir) {
  try {
    const meta = JSON.parse(await fetchCached(`https://tranco-list.eu/api/lists/date/latest?d=${new Date().toISOString().slice(0, 10)}`, cacheDir));
    const id = meta.list_id;
    const csv = await fetchCached(`https://tranco-list.eu/download/${id}/${n}`, cacheDir);
    const rows = parseTranco(csv);
    if (rows.length > n / 2) return { id, rows };
  } catch {
    // fall through to the zip
  }
  const zip = join(cacheDir, "tranco-top-1m.csv.zip");
  if (!existsSync(zip)) {
    const res = await fetch("https://tranco-list.eu/top-1m.csv.zip", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`tranco zip HTTP ${res.status}`);
    await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  }
  const csv = execFileSync("python3", ["-I", "-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);sys.stdout.write(z.read(z.namelist()[0]).decode())", zip], { maxBuffer: 1 << 28 }).toString();
  return { id: "top-1m.csv.zip", rows: parseTranco(csv).slice(0, n) };
}

/** "1,google.com" lines into [{rank, domain}]. */
export function parseTranco(csv) {
  const out = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = /^(\d+),([a-z0-9.-]+\.[a-z0-9-]+)$/i.exec(line.trim());
    if (m) out.push({ rank: Number(m[1]), domain: m[2].toLowerCase() });
  }
  return out;
}

/** Control sample: equal counts from rank bands 1-1k, 1k-10k, 10k-top (seeded). */
export function sampleControl(rows, k, rand) {
  const bands = [
    rows.filter((r) => r.rank <= 1000),
    rows.filter((r) => r.rank > 1000 && r.rank <= 10000),
    rows.filter((r) => r.rank > 10000),
  ].filter((b) => b.length);
  const out = [];
  const per = Math.ceil(k / bands.length);
  for (const b of bands) for (const i of sampleIndices(b.length, per, rand)) out.push(b[i]);
  return out.slice(0, k);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const via = a.via === "api" ? "api" : "files";
  const opts = {
    out: a.out || join(homedir(), "vision-out", "discover"),
    via,
    crawls: a.crawls || (via === "files" ? 3 : 1),
    seed: a.seed ?? 7,
    concurrency: a.concurrency || 3,
    blockConcurrency: a["block-concurrency"] || 12,
    domainConcurrency: via === "files" ? a["domain-concurrency"] || 4 : 1,
    aiPages: a["ai-pages"] ?? 40,
    mixedPages: a["mixed-pages"] ?? 6,
    aiBlocks: a["ai-blocks"] ?? 400,
    mixedBlocks: a["mixed-blocks"] ?? 40,
    aiHosts: a["ai-hosts"] ?? 8000,
    mixedHosts: a["mixed-hosts"] ?? 1500,
    control: a.control ?? 4000,
    controlTop: a["control-top"] ?? 100000,
    only: a.only ? String(a.only).split(",") : null,
  };
  const cacheDir = join(opts.out, "cache");
  await mkdir(cacheDir, { recursive: true });
  const t0 = Date.now();
  const crawls = a.crawl ? String(a.crawl).split(",") : await latestCrawls(opts.crawls, cacheDir);
  const seen = new Set();
  const rows = [];
  const summary = { started: new Date(t0).toISOString(), crawls, opts, domains: [], control: null };
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  log(`crawls ${crawls.join(", ")} via ${via}`);
  // the cluster.idx files first, one at a time (about 100 MB each)
  if (via === "files") for (const c of crawls) await clusterIdx(c, cacheDir).then(() => log(`cluster.idx ${c} ready`));
  const domains = DOMAINS.filter((d) => !opts.only || opts.only.includes(d.domain));
  const found = new Map();
  await pool(domains, opts.domainConcurrency, async (d) => {
    // one RNG per domain, so the sample does not depend on which domain finished first
    const rand = rng((opts.seed * 2654435761 + createHash("sha1").update(d.domain).digest().readUInt32LE(0)) >>> 0);
    const merged = new Map();
    for (const crawl of crawls) {
      const { info, hosts } = via === "files" ? await discoverDomainFiles(d, crawl, opts, cacheDir, rand) : await discoverDomain(d, crawl, opts, cacheDir, rand);
      let fresh = 0;
      for (const [k, v] of hosts) if (!merged.has(k)) (merged.set(k, { ...v, crawl }), fresh++);
      info.new = fresh;
      summary.domains.push(info);
      log(`${d.domain} ${crawl}: ${via === "files" ? `${info.blocks} blocks` : `${info.pages} pages`}, read ${info.read}, ${info.captures} captures, ${info.hosts} hosts (${fresh} new)${info.errors.length ? `, ${info.errors.length} errors` : ""}`);
    }
    found.set(d.domain, { merged, rand });
  });
  // keep up to the cap per domain, in DOMAINS order (ai-builder before mixed-host), seeded subset when capped
  for (const d of domains) {
    const { merged, rand } = found.get(d.domain);
    const want = d.group === "ai-builder" ? opts.aiHosts : opts.mixedHosts;
    const list = [...merged.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    let kept = 0;
    for (const i of sampleIndices(list.length, want, rand)) {
      const [k, v] = list[i];
      if (seen.has(k)) continue;
      seen.add(k);
      kept++;
      rows.push({ url: `https://${v.host}/`, host: v.host, group: d.group, builder: d.builder, domain: d.domain, source: `commoncrawl-cdx-${via}`, crawl: v.crawl, ts: v.ts, rank: null, shard: shardOf(v.host) });
    }
    summary.domains.push({ domain: d.domain, total: list.length, kept });
    log(`${d.domain}: ${list.length} hosts over ${crawls.length} crawls, kept ${kept}`);
  }
  const rand = rng(opts.seed);
  if (opts.control > 0 && !opts.only) {
    try {
      const { id, rows: top } = await trancoTop(opts.controlTop, cacheDir);
      let kept = 0;
      for (const r of sampleControl(top, opts.control, rand)) {
        const k = hostKey(r.domain);
        if (seen.has(k)) continue;
        seen.add(k);
        kept++;
        rows.push({ url: `https://${r.domain}/`, host: r.domain, group: "control", builder: null, domain: null, source: "tranco", crawl: id, ts: null, rank: r.rank, shard: shardOf(r.domain) });
      }
      summary.control = { list: id, top: top.length, kept };
      log(`control: Tranco ${id}, ${top.length} rows, kept ${kept}`);
    } catch (e) {
      summary.control = { error: String(e.message || e).slice(0, 200) };
      log(`control failed: ${summary.control.error}`);
    }
  }
  await writeFile(join(opts.out, "urls.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  summary.total = rows.length;
  summary.byGroup = rows.reduce((m, r) => ((m[r.group] = (m[r.group] || 0) + 1), m), {});
  summary.seconds = Math.round((Date.now() - t0) / 1000);
  await writeFile(join(opts.out, "summary.json"), JSON.stringify(summary, null, 2));
  log(`wrote ${rows.length} urls (${JSON.stringify(summary.byGroup)}) to ${join(opts.out, "urls.jsonl")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
