// After orchestrate.mjs: out/demo-raw.mov (the display at Retina size) becomes
//   out/demo-full.mp4      the whole take, real time, 1512 px wide
//   out/demo-condensed.mp4 the same take with Claude's working stretches (between "prompt N" and "prompt N done" in
//                          chapters.txt) at 4x, everything else real time
// Run from the repository root: node demo-site/record/postprocess.mjs
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
const RAW = join(OUT, "demo-raw.mov");
if (!existsSync(RAW)) throw new Error("no out/demo-raw.mov");
const run = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"] }).toString();
const duration = Number(run(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${RAW}"`).trim());

// chapters: "[mm:ss] text"; the recording starts at the "recording started" line
const lines = readFileSync(join(OUT, "chapters.txt"), "utf8").split("\n").filter(Boolean);
const at = (l) => { const m = /^\[(\d+):(\d+)\]/.exec(l); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
const t0 = at(lines.find((l) => l.includes("recording started")) ?? lines[0]);
const rel = (l) => Math.max(0, at(l) - t0);
const spans = [];
for (const l of lines) {
  const m = /prompt (\d+): /.exec(l);
  if (m) {
    const done = lines.find((x) => x.includes(`prompt ${m[1]} done`));
    if (done) spans.push([rel(l) + 2, rel(done) - 1]); // keep the typed prompt and the end real time
  }
}
console.log(`raw ${duration.toFixed(0)} s; ${spans.length} working stretches to speed up`);

run(`ffmpeg -y -loglevel error -i "${RAW}" -vf "scale=1512:-2" -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -movflags +faststart "${join(OUT, "demo-full.mp4")}"`);
console.log("wrote demo-full.mp4");

// the condensed cut: segments in order, each at 1x or 4x, concatenated
const segs = [];
let cur = 0;
for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
  if (a > cur) segs.push([cur, a, 1]);
  segs.push([a, b, 4]);
  cur = b;
}
if (cur < duration) segs.push([cur, duration, 1]);
const dir = join(OUT, ".segs");
mkdirSync(dir, { recursive: true });
const list = [];
segs.forEach(([a, b, speed], i) => {
  if (b - a < 0.2) return;
  const f = join(dir, `s${String(i).padStart(2, "0")}.mp4`);
  run(`ffmpeg -y -loglevel error -ss ${a} -to ${b} -i "${join(OUT, "demo-full.mp4")}" -vf "setpts=PTS/${speed}" -an -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p "${f}"`);
  list.push(`file '${f}'`);
});
writeFileSync(join(dir, "list.txt"), list.join("\n") + "\n");
run(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${join(dir, "list.txt")}" -c copy -movflags +faststart "${join(OUT, "demo-condensed.mp4")}"`);
const d2 = Number(run(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${join(OUT, "demo-condensed.mp4")}"`).trim());
console.log(`wrote demo-condensed.mp4 (${d2.toFixed(0)} s)`);
