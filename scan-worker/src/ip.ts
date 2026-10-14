// IP literal parsing and classification for the scanner's block list. Pure: no I/O, no globals.
//
// Used three ways: on the address a person types (IP literals are refused outright), on the A/AAAA answers for the
// hostname (a public name that resolves into a private range is refused), and on every request the browser makes
// while scanning (a page cannot make the scanner's browser fetch a private address by literal).

/** Parses an IPv4 literal in any form inet_aton accepts (127.0.0.1, 127.1, 2130706433, 0x7f000001, 0177.0.0.1). */
export function parseIPv4(input: string): number[] | null {
  const s = input.replace(/\.$/, "");
  if (!s || s.length > 64) return null;
  const parts = s.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!p) return null;
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = Number(p);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums.pop() as number;
  for (const n of nums) if (n > 255) return null;
  const rest = 4 - nums.length;
  if (last >= 2 ** (8 * rest)) return null;
  const out = [...nums];
  for (let i = rest - 1; i >= 0; i--) out.push(Math.floor(last / 2 ** (8 * i)) % 256);
  return out;
}

/** Parses an IPv6 literal (brackets, an embedded IPv4 tail and a zone id are accepted) into eight 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return null;
  const lastColon = s.lastIndexOf(":");
  const after = s.slice(lastColon + 1);
  if (after.includes(".")) {
    // an embedded IPv4 tail (::ffff:127.0.0.1) becomes two hex groups (::ffff:7f00:1)
    const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(after) ? parseIPv4(after) : null;
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4[0] * 256 + v4[1]).toString(16)}:${(v4[2] * 256 + v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  if (!head) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const back = parse(halves[1]);
  if (!back) return null;
  const fill = 8 - head.length - back.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...back];
}

const inV4 = (b: number[], net: number[], bits: number): boolean => {
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, bits - 8 * i));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if ((b[i] & mask) !== (net[i] & mask)) return false;
  }
  return true;
};

/** Why an IPv4 address must not be fetched, or null for a public unicast address. */
export function blockedIPv4(b: number[]): string | null {
  if (inV4(b, [0, 0, 0, 0], 8)) return "this-network";
  if (inV4(b, [127, 0, 0, 0], 8)) return "loopback";
  if (inV4(b, [10, 0, 0, 0], 8) || inV4(b, [172, 16, 0, 0], 12) || inV4(b, [192, 168, 0, 0], 16)) return "private";
  if (inV4(b, [169, 254, 0, 0], 16)) return b[2] === 169 && b[3] === 254 ? "metadata" : "link-local";
  if (inV4(b, [100, 64, 0, 0], 10)) return "cgnat"; // includes 100.100.100.200, a cloud metadata address
  if (inV4(b, [192, 0, 0, 0], 24) || inV4(b, [192, 88, 99, 0], 24)) return "reserved";
  if (inV4(b, [192, 0, 2, 0], 24) || inV4(b, [198, 51, 100, 0], 24) || inV4(b, [203, 0, 113, 0], 24)) return "documentation";
  if (inV4(b, [198, 18, 0, 0], 15)) return "benchmark";
  if (inV4(b, [224, 0, 0, 0], 4)) return "multicast";
  if (inV4(b, [240, 0, 0, 0], 4)) return "reserved"; // includes 255.255.255.255
  return null;
}

const inV6 = (g: number[], net: number[], bits: number): boolean => {
  for (let i = 0; i < 8; i++) {
    const take = Math.max(0, Math.min(16, bits - 16 * i));
    if (take === 0) return true;
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((g[i] & mask) !== ((net[i] ?? 0) & mask)) return false;
  }
  return true;
};
const v4Of = (hi: number, lo: number): number[] => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

/** Why an IPv6 address must not be fetched, or null for a public unicast address. */
export function blockedIPv6(g: number[]): string | null {
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  if (inV6(g, [0, 0, 0, 0, 0, 0xffff], 96)) return blockedIPv4(v4Of(g[6], g[7])) ?? null; // IPv4-mapped
  if (inV6(g, [0, 0, 0, 0, 0, 0], 96)) return "reserved"; // IPv4-compatible (deprecated)
  if (inV6(g, [0x64, 0xff9b, 0, 0, 0, 0], 96)) return blockedIPv4(v4Of(g[6], g[7])) ?? null; // NAT64
  if (inV6(g, [0x64, 0xff9b, 1], 48)) return "private"; // local-use NAT64
  if (inV6(g, [0x100, 0, 0, 0], 64)) return "reserved"; // discard-only
  if (inV6(g, [0x2001, 0xdb8], 32)) return "documentation";
  if (inV6(g, [0x2001, 0], 32)) return "reserved"; // Teredo tunnels
  if (inV6(g, [0x2002], 16)) return blockedIPv4(v4Of(g[1], g[2])); // 6to4 embeds an IPv4 address
  if (inV6(g, [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254], 128)) return "metadata";
  if (inV6(g, [0xfc00], 7)) return "private";
  if (inV6(g, [0xfe80], 10)) return "link-local";
  if (inV6(g, [0xfec0], 10)) return "private"; // site-local (deprecated)
  if (inV6(g, [0xff00], 8)) return "multicast";
  return null;
}

export interface IpClass {
  version: 4 | 6;
  /** Null for a public unicast address. */
  blocked: string | null;
}

/** Classifies a hostname that is an IP literal (as the URL parser leaves it: dotted quad or [v6]); null otherwise. */
export function classifyIp(host: string): IpClass | null {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[") || h.includes(":")) {
    const g = parseIPv6(h);
    return g ? { version: 6, blocked: blockedIPv6(g) } : null;
  }
  // a hostname whose last label is numeric is an IPv4 literal to the URL parser; anything else is a name
  const labels = h.replace(/\.$/, "").split(".");
  const lastLabel = labels[labels.length - 1] ?? "";
  if (!/^(0x[0-9a-f]*|\d+)$/i.test(lastLabel)) return null;
  const b = parseIPv4(h);
  return b ? { version: 4, blocked: blockedIPv4(b) } : { version: 4, blocked: "invalid" };
}
