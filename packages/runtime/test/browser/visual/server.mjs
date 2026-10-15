// Static server for the measured visual checks' browser tests (test/browser/visual/*.spec.ts):
//   /dist/...        the built package (dist/genclass.global.js loads dist/visual/index.js from here)
//   /f/...           fixture pages and their CSS
//   /csp/...         the same fixtures with a strict Content-Security-Policy header
//   /img/WxH.png     a solid-colour PNG of that natural size (?c=rrggbb, ?delay=ms)
//   /missing/...     404 (text/plain)
//   /html404/...     404 with an HTML body (what many hosts answer for a missing stylesheet)

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = { dist: resolve(HERE, "../../../dist"), f: join(HERE, "fixtures"), csp: join(HERE, "fixtures") };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'";

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A w x h RGB PNG filled with one colour. */
export function png(w, h, rgb = [96, 128, 160]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export async function startServer() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("Cache-Control", "no-store");
    const [, top, ...rest] = decodeURIComponent(u.pathname).split("/");
    if (top === "img") {
      const m = /^(\d+)x(\d+)\.png$/.exec(rest.join("/"));
      if (!m) return void res.writeHead(404).end();
      const c = /^[0-9a-f]{6}$/i.exec(u.searchParams.get("c") ?? "")?.[0];
      const body = png(Math.min(4000, Number(m[1])), Math.min(4000, Number(m[2])), c ? [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)) : undefined);
      const send = () => res.writeHead(200, { "Content-Type": "image/png", "Content-Length": body.length }).end(body);
      const delay = Number(u.searchParams.get("delay") ?? 0);
      return void (delay > 0 ? setTimeout(send, Math.min(delay, 10_000)) : send());
    }
    if (top === "missing") return void res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    if (top === "html404") return void res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><title>Not found</title><h1>Not found</h1>");
    const root = ROOTS[top];
    if (!root) return void res.writeHead(404).end();
    if (top === "csp") res.setHeader("Content-Security-Policy", CSP);
    const file = normalize(join(root, rest.join("/") || "index.html"));
    if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(403).end();
    let st;
    try {
      st = statSync(file);
    } catch {
      return void res.writeHead(404).end("not found");
    }
    if (!st.isFile()) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Content-Length": st.size });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}
