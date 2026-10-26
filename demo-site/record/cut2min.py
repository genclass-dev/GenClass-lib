# The 2-minute cut of the seamless take: out/demo-raw.mov -> out/demo-2min.mp4 (1920x1080, 30 fps) and
# out/demo-2min-cuts.txt. Every source time and zoom region below belongs to the take recorded on 2026-10-26
# (657.8 s, Terminal 70x50): a new take needs its own times, found from out/chapters.txt (video time = chapter time
# minus the "recording started" line) and checked frame by frame. Written by an agent with ffmpeg only.
# One intermediate per segment (out/.cut2); segments in one group are joined by hard cuts (all consecutive terminal
# shots share a group), groups are joined with 0.4 s cross-dissolves; 0.5 s fade in, 1 s fade to black.
# Run from anywhere: python3 demo-site/record/cut2min.py [segment names to re-render]
import os, subprocess, sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", ".cut2")
os.makedirs(OUT, exist_ok=True)
SRC = os.path.join(OUT, "..", "demo-raw.mov")
FINAL = os.path.join(OUT, "..", "demo-2min.mp4")
CUTS = os.path.join(OUT, "..", "demo-2min-cuts.txt")
FPS = 30
XF = 0.4

# regions: (x, y, w) in source px; h = w*9/16
FULL = (0, 100, 3024)
TW = 1328                                  # whole terminal width: px x 1694-3022 (window 1692-3024)
def T(y): return (1694, y, TW)            # 1328x747
TB = T(1194)                               # terminal bottom: prompt line and cursor (y 1194-1941); every terminal y is 4 px below a text-row boundary so no glyph is cut
R = {
  "bug": (0, 300, 1344),
  "start": (0, 60, 1680),
  "connect": (40, 250, 1568),             # below the URL bar of the dashboard
  "med": (0, 400, 1680),
  "card": (640, 760, 1040),
  "obs": (0, 300, 1680),
  "guard": (0, 400, 1680),
  "overview": (0, 330, 1680),             # below the URL bar and the top nav
  "problems": (120, 600, 1504),
  "loads": (0, 60, 1680),
  "fig": (150, 600, 1440),
  "table": (120, 340, 1504),
}

S = []
def seg(name, group, src_in, dur, speed, label, keys, kind=None):
    S.append(dict(name=name, group=group, src_in=src_in, dur=dur, speed=speed, label=label, keys=keys, kind=kind))

seg("01_bug", 1, 356.9, 4.4, 1, "Cold open (from the live site in observe, cropped below the URL bar): 'react' typed, the 8 results for 'r' stay; ends before the overlay opens at 361.4", [(0, R["bug"])])
seg("02_start", 2, 19.6, 3.2, 1, "genclass.dev/start, app name typed (token page skipped)", [(0, R["start"])])
seg("03_connect", 3, 27.0, 5.0, 1, "Dashboard Connect dialog, 'Copy the prompt' clicked (Copied)", [(0, R["connect"])])
seg("04_paste", 4, 32.0, 4.0, 1.5, "Prompt 1 pasted into Claude Code", [(0, T(116))])
seg("05_ff1", 4, 38.0, 9.0, 16, "Claude integrates GenClass (fast-forward)", [(0, TB)])
seg("06_done1", 4, 211.0, 5.0, 1, "Prompt 1 summary 'What I changed', pan down to '✓ done 150 s'",
    [(0, T(150)), (1.0, T(150)), (3.8, T(1194)), (5.0, T(1194))], kind="pan")
seg("07_p2", 4, 230.0, 3.3, 1.5, "Prompt 2 typed: guard, overlay, atom", [(0, TB)])
seg("08_ff2", 4, 235.0, 2.7, 12, "Claude makes the three changes (fast-forward)", [(0, TB)])
seg("09_done2", 4, 270.5, 4.5, 1, "Prompt 2 summary, pan down to '✓ done 29 s'",
    [(0, T(294)), (1.2, T(294)), (3.6, T(1194)), (4.5, T(1194))], kind="pan")
seg("10_hotfix", 5, 291.0, 14.0, 1, "Dev page in guard: 'react' typed, right list, badge 1, overlay 'Prevented a stale response'",
    [(0, FULL), (4.4, FULL), (5.6, R["med"]), (7.6, R["med"]), (8.6, R["card"]), (14.0, R["card"])], kind="zoom")
seg("11_p3", 6, 306.0, 2.3, 1.5, "Prompt 3: deploy to Vercel", [(0, TB)])
seg("12_ff3", 6, 309.5, 2.6, 12, "vercel --prod (fast-forward)", [(0, TB)])
seg("13_live", 6, 343.0, 3.6, 1, "'The deploy worked, and the production URL is https://tiny-shop-before.vercel.app'", [(0, TB)])
seg("14_obs_a", 7, 357.6, 3.0, 1, "Live site ?genclass=observe: 'react' typed, 8 results (wrong)", [(0, R["obs"])])
seg("15_obs_b", 7, 362.5, 4.0, 1, "Overlay Detections: Stale write / Stale response, 'Would have run discard'", [(0, R["obs"])])
seg("16_guard_a", 8, 383.8, 3.8, 1, "Live site in guard: 'react' typed, right list", [(0, R["guard"])])
seg("17_guard_b", 8, 387.6, 0.45, 4, "(add to cart, overlay opening)", [(0, R["guard"])])
seg("18_guard_c", 8, 389.4, 4.2, 1, "Overlay Interventions: Prevented a stale response", [(0, R["guard"])])
seg("19_overview", 9, 412.0, 3.2, 1, "Dashboard overview: 4 problems, 1 stopped by GenClass, model loaded 100%", [(0, R["overview"])])
seg("20_problems", 10, 417.0, 4.0, 1, "Dashboard Problems: Stale responses", [(0, R["problems"])])
seg("21_p4", 11, 442.5, 2.0, 1.5, "Prompt 4: explore the search", [(0, TB)])
seg("22_loads", 12, 458.0, 2.25, 13, "Five explore page loads typing 'react' (fast-forward)", [(0, R["loads"])])
seg("23_race", 13, 516.0, 4.8, 1, "'Explore x1 found a race ... f17', report and explanation, pan to '✓ done 22 s'",
    [(0, T(582)), (2.2, T(582)), (3.8, T(1194)), (4.8, T(1194))], kind="pan")
seg("24_repro", 13, 562.5, 3.5, 1, "Replay r7: REPRODUCED, then Edit src/main.js", [(0, T(510))])
seg("25_fix", 13, 571.0, 4.0, 1, "The fix in src/main.js (searchSeq), regression test saved", [(0, T(402))])
seg("26_notrepro", 13, 597.0, 3.8, 1, "Replay r8: not reproduced, the fix holds", [(0, T(510))])
seg("27_summary", 13, 637.0, 5.0, 1, "Three-line summary: Found / Proved / Fixed, '✓ done 6 s'", [(0, TB)])
seg("28_fig", 14, 640.6, 4.6, 1, "Dashboard Loop: Closed-loop development figure", [(0, R["fig"])])
seg("29_table", 15, 648.0, 3.6, 1, "Dashboard Loop: 'What your agent did' table", [(0, R["table"])])
seg("30_fig2", 16, 653.7, 3.9, 1, "Closed-loop figure again, fade to black", [(0, R["fig"])])

def h(w): return w * 9 // 16

def ev(keys, t):
    if len(keys) == 1:
        return f"{keys[0][1]}"
    e = f"{keys[-1][1]}"
    for i in range(len(keys) - 2, -1, -1):
        t0, v0 = keys[i]; t1, v1 = keys[i + 1]
        if v0 == v1:
            part = f"{v0}"
        else:
            p = f"clip(({t}-{t0})/{t1 - t0},0,1)"
            part = f"({v0}+({v1 - v0})*{p}*{p}*(3-2*{p}))"
        e = f"if(lt({t},{t1}),{part},{e})"
    return e

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(" ".join(cmd)); print(r.stderr[-3000:]); sys.exit(1)

enc = ["-an", "-c:v", "libx264", "-preset", "fast", "-crf", "12", "-pix_fmt", "yuv420p", "-r", str(FPS)]

def render(s):
    out = os.path.join(OUT, s["name"] + ".mp4")
    n = s["frames"]
    src_dur = s["dur"] * s["speed"] + 0.5
    keys = s["keys"]
    if s["kind"] is None:
        x, y, w = keys[0][1]
        vf = f"crop={w}:{h(w)}:{x}:{y},scale=1920:1080:flags=lanczos,setsar=1,setpts=(PTS-STARTPTS)/{s['speed']},fps={FPS}"
    elif s["kind"] == "pan":   # terminal column, constant width, y animated at half-pixel steps
        x, _, w = keys[0][1]
        yk = [(t, 2 * (r[1] - 60)) for t, r in keys]
        vf = (f"crop={w}:1904:{x}:60,format=yuv444p,scale={2*w}:3808:flags=lanczos,"
              f"crop={2*w}:{2*h(w)}:0:'{ev(yk, 't')}',scale=1920:1080:flags=lanczos,format=yuv420p,setsar=1,fps={FPS}")
    else:                      # zoom: base = 3024x1864 from y 100, 2x, zoompan on the crop width
        T_ = "(on/30)"
        wk = [(t, r[2]) for t, r in keys]
        xk = [(t, 2 * r[0]) for t, r in keys]
        yk = [(t, 2 * (r[1] - 100)) for t, r in keys]
        vf = (f"crop=3024:1864:0:100,scale=6048:3728:flags=bicubic,"
              f"zoompan=z='3024/({ev(wk, T_)})':x='{ev(xk, T_)}':y='{ev(yk, T_)}':d=1:s=1920x1080:fps={FPS},setsar=1")
    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{s['src_in']}", "-t", f"{src_dur:.3f}", "-i", SRC, "-vf", vf,
         "-frames:v", str(n)] + enc + [out])

for s in S:
    s["frames"] = round(s["dur"] * FPS)
only = set(sys.argv[1:])
for s in S:
    if not only or s["name"] in only:
        print("render", s["name"], flush=True)
        render(s)

groups = {}
for s in S:
    groups.setdefault(s["group"], []).append(s)
gfiles, gdurs = [], []
for g in sorted(groups):
    segs = groups[g]
    if len(segs) == 1:
        gf = os.path.join(OUT, segs[0]["name"] + ".mp4")
    else:
        gf = os.path.join(OUT, f"g{g:02d}.mp4")
        lst = os.path.join(OUT, f"g{g:02d}.txt")
        with open(lst, "w") as f:
            for s in segs:
                f.write(f"file '{os.path.join(OUT, s['name'] + '.mp4')}'\n")
        run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", gf])
    gfiles.append(gf)
    gdurs.append(sum(s["frames"] for s in segs) / FPS)

inputs = []
for gf in gfiles:
    inputs += ["-i", gf]
fl = [f"[{i}:v]settb=1/{FPS},setpts=PTS-STARTPTS,format=yuv420p[v{i}]" for i in range(len(gfiles))]
cur = "v0"; acc = gdurs[0]
for i in range(1, len(gfiles)):
    fl.append(f"[{cur}][v{i}]xfade=transition=fade:duration={XF}:offset={acc - XF:.4f}[x{i}]")
    cur = f"x{i}"; acc += gdurs[i] - XF
total = acc
fl.append(f"[{cur}]fade=t=in:st=0:d=0.5,fade=t=out:st={total - 1.0:.4f}:d=1.0[out]")
run(["ffmpeg", "-v", "error", "-y"] + inputs + ["-filter_complex", ";".join(fl), "-map", "[out]", "-an",
     "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", str(FPS), FINAL])

t = 0.0
lines = ["demo-2min.mp4: cut list (source = demo-raw.mov, 657.8 s take, 3024x1964; regions are source px x,y,w x h; output 1920x1080 30 fps)",
         f"Hard cuts inside a group (every run of consecutive terminal shots is one group); {XF} s cross-dissolves between groups;",
         f"0.5 s fade in, 1 s fade to black. Terminal shots use the whole terminal width (px x 1694-3022). Total {total:.2f} s.", ""]
for g in sorted(groups):
    lines.append(f"[group {g}]")
    for s in groups[g]:
        d = s["frames"] / FPS
        src_out = s["src_in"] + d * s["speed"]
        regs = []
        for kt, r in s["keys"]:
            cur_r = f"{r[0]},{r[1]},{r[2]}x{h(r[2])}"
            if not regs or regs[-1][0] != cur_r:
                regs.append((cur_r, kt))
        zoom = regs[0][0] if len(regs) == 1 else " -> ".join(f"{a}@{b}s" for a, b in regs)
        lines.append(f"{s['name']:<12} out {t:6.2f}s  src {s['src_in']:7.2f}-{src_out:7.2f}  speed {s['speed']:>4}x  dur {d:5.2f}s  region {zoom}")
        lines.append(f"{'':<12} {s['label']}")
        t += d
    t -= XF
lines += ["", "Captions: none (this ffmpeg build has no drawtext/subtitles filter)."]
with open(CUTS, "w") as f:
    f.write("\n".join(lines) + "\n")
print("total", total)
