"""The visual-bug feature on genclass.dev: the numbers file (src/data/visual.json), the drawn bug examples, the scan box,
and the blocks of the homepage section (src/partials/visual.html) and of /visual (src/pages/visual.html).

build.py calls markers(body) on every page. A number reaches a page only from visual.json. The file has three blocks,
each with its own switch: status "live" shows the measured checks (the checks block must be complete), model.status
"live" adds the learned model's tables, crawl.status "live" adds the crawl figure (measured signals, shown as upper
bounds). A block switched on with a field missing, or with numbers that disagree with their parts, stops the build
(src/data/README.md). What the pages say about the model, the runtime and the scan box follows model.stage,
checks_in_runtime, scan_live and scan_runs, and ready_by is the date shown as when the model's results are due (a date
already past stops the build while the model is draft).
VISUAL_DATA=<file> builds from another file, such as visual.sample.json, to preview the live layout: every figure and
table is then stamped "Sample data, not measured", and build.py writes that build to site/.preview/, never public/.
"""
import datetime, decimal, functools, hashlib, html, json, os, pathlib, re, subprocess

ROOT = pathlib.Path(__file__).parent
REPO = ROOT.parent
GH = "https://github.com/genclass-dev/GenClass-lib"
DATA = pathlib.Path(os.environ.get("VISUAL_DATA") or ROOT / "src/data/visual.json")
if not DATA.is_absolute() and not DATA.exists():
    DATA = REPO / DATA
SCAN_JS = ROOT / "public/scan-box.js"
FAMILY_IDS = ("text", "media", "styles", "overflow", "occlusion", "controls", "leaks", "blank", "motion", "dark",
              "responsive", "design", "other")
esc = html.escape

# ---------------------------------------------------------------- drawings
# Inline SVG on a 160 x 100 plate: a pale panel ground, a white page or phone drawn in ink and rule greys, and the
# defect marked with a dashed red-orange box. Drawn for this site; none is a screenshot of a real site.
INK, INK2, INK3, RULE, RULE2, PANEL, BUG, BUGT = "#0E1F4D", "#3D4B6B", "#5A6684", "#DFE4EC", "#C6CEDB", "#F5F8FB", "#F0451C", "#C42A12"
NIGHT, NLINE = "#0B1736", "#26355E"
SANS = "font-family:Figtree,'Helvetica Neue',Arial,sans-serif"
MONO = "font-family:'Geist Mono',ui-monospace,Menlo,monospace"

def _bug(x, y, w, h):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="3" fill="none" stroke="{BUG}" stroke-width="1.4" stroke-dasharray="3 2"/>'

def _bars(x, y, widths, fill=RULE2, h=3.5, gap=7):
    return "".join(f'<rect x="{x}" y="{y + i * gap}" width="{w}" height="{h}" rx="1.75" fill="{fill}"/>' for i, w in enumerate(widths))

SERIF = "font-family:'Times New Roman',Times,serif"

def _text(x, y, s, size=8, fill=INK, weight=400, mono=False, anchor="start", face=None):
    return (f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" '
            f'style="{face or (MONO if mono else SANS)}">{esc(s)}</text>')

def _page(inner, dark=False):
    bg, line = (NIGHT, NLINE) if dark else ("#fff", RULE)
    dots = "".join(f'<circle cx="{16 + 5.5 * i}" cy="15.2" r="1.5" fill="{NLINE if dark else RULE2}"/>' for i in range(3))
    return f'<rect x="10.5" y="10.5" width="139" height="79" rx="4" fill="{bg}" stroke="{line}"/><path d="M10.5 20.5h139" stroke="{line}"/>{dots}{inner}'

def _phone(inner):
    return (f'<rect x="46.5" y="5.5" width="50" height="89" rx="7" fill="#fff" stroke="{INK3}" stroke-width="1.2"/>'
            f'<rect x="63" y="9" width="17" height="2.6" rx="1.3" fill="{RULE}"/>{inner}')

def _cursor(x, y):
    return (f'<path d="M{x} {y}v11.5l2.9-2.8 2.2 4.8 2-.9-2.2-4.7h4z" fill="#fff" stroke="{INK}" stroke-width="1" '
            f'stroke-linejoin="round"/>')

ART = {
    # a label set in the same colour as its button
    "text": _page(f'<rect x="18" y="28" width="70" height="6" rx="1.5" fill="{INK}"/>{_bars(18, 40, [104, 86])}'
                  f'<rect x="18.5" y="58.5" width="58" height="20" rx="4" fill="#fff" stroke="#E6EAF0"/>'
                  + _text(47.5, 71.6, "Sign up", 9, "#EEF1F5", 600, anchor="middle")
                  + f'<rect x="84.5" y="58.5" width="46" height="20" rx="4" fill="none" stroke="{RULE2}"/>'
                  + _text(107.5, 71.6, "Log in", 9, INK2, 500, anchor="middle") + _bug(14, 54, 67, 29)),
    # an image that never loaded: the browser's broken-image glyph and the alt text
    "media": _page(f'<rect x="18.5" y="27.5" width="123" height="40" rx="2" fill="{PANEL}" stroke="{RULE}"/>'
                   f'<path d="M73.5 36.5h10l4 4v10h-14z" fill="#fff" stroke="{INK3}" stroke-width="1.1" stroke-linejoin="round"/>'
                   f'<path d="M83.5 36.5v4h4M75.5 48.5l3-3.4 2.4 2.4 2-2 3 3" fill="none" stroke="{INK3}" stroke-width="1.1" stroke-linejoin="round"/>'
                   + _text(80, 61, "team-photo.jpg", 6.5, INK3, mono=True, anchor="middle")
                   + _bars(18, 74, [84, 58]) + _bug(14, 23, 132, 49)),
    # a utility class with no generated CSS: the button falls back to the browser's default look and font
    "styles": _page(_text(18, 32, 'class="bg-brand-600"', 7, INK3, mono=True)
                    + f'<rect x="18.5" y="39.5" width="50" height="16" rx="1.5" fill="#EFEFEF" stroke="#767676" stroke-width=".8"/>'
                    + _text(43.5, 50.6, "Buy now", 8.5, "#000", anchor="middle", face=SERIF)
                    + _text(18, 69, "Free shipping on all orders", 7.5, "#000", face=SERIF)
                    + _text(18, 79, "Returns within thirty days", 7.5, "#000", face=SERIF)
                    + _bug(14, 35, 59, 25)),
    # one fixed-width block makes the whole page scroll sideways on a phone
    "overflow": _phone(f'<rect x="52" y="17" width="28" height="5" rx="1.5" fill="{INK}"/>{_bars(52, 27, [38, 30], h=3)}'
                       f'<rect x="52.5" y="40.5" width="44" height="24" rx="1" fill="{PANEL}" stroke="{RULE2}"/>'
                       f'<path d="M52.5 48.5h44M52.5 56.5h44M67.5 40.5v24M82.5 40.5v24" stroke="{RULE}"/>'
                       + _bug(96.5, 40.5, 50, 24)
                       + f'<path d="M97 48.5h49M97 56.5h49M112.5 41v23M127.5 41v23" stroke="#F9C7BA"/>'
                       + _bars(52, 70, [38, 26], h=3)
                       + f'<rect x="52" y="86" width="38" height="2" rx="1" fill="#E6EAF0"/><rect x="52" y="86" width="19" height="2" rx="1" fill="{INK3}"/>'
                       + f'<path d="M106 75h32M134 72l4 3-4 3M110 72l-4 3 4 3" fill="none" stroke="{BUG}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'),
    # a sticky header painted over the top of a heading
    "occlusion": _page(_text(18, 41.5, "Order summary", 10.5, INK, 600)
                       + f'<rect x="11" y="21" width="138" height="16" fill="#fff"/><path d="M11 37.5h138" stroke="{RULE}"/>'
                       f'<rect x="18" y="26.5" width="24" height="5" rx="1.5" fill="{INK}"/>{_bars(86, 27.5, [12], h=3)}'
                       f'{_bars(102, 27.5, [12], h=3)}<rect x="122" y="24.5" width="20" height="9" rx="2" fill="{INK}"/>'
                       + _bars(18, 52, [110, 96, 104]) + _bug(14, 31, 80, 14)),
    # an invisible layer on top of a button takes the click
    "controls": _page(f'<rect x="18" y="28" width="62" height="6" rx="1.5" fill="{INK}"/>{_bars(18, 40, [100, 80])}'
                      f'<rect x="18" y="59" width="60" height="20" rx="4" fill="{INK}"/>'
                      + _text(48, 72, "Checkout", 8.5, "#fff", 600, anchor="middle")
                      + f'<rect x="12.5" y="54.5" width="104" height="31" rx="3" fill="{BUG}" fill-opacity=".07" stroke="{BUG}" stroke-width="1.4" stroke-dasharray="3 2"/>'
                      + _cursor(71, 70)),
    # template output that reached the page
    "leaks": _page(_text(18, 36, "Hi,", 11, INK, 600) + _text(37, 36, "undefined", 11, INK, 600) + _bug(34, 26, 60, 14)
                   + _text(18, 50, "[object Object]", 7, INK2, mono=True) + _bug(15, 43.5, 71, 9.5)
                   + f'<rect x="18.5" y="57.5" width="66" height="27" rx="3" fill="#fff" stroke="{RULE}"/>'
                   + _text(24, 64.8, "Pro plan", 7, INK2) + _text(24, 79.5, "$NaN", 11, INK, 700) + _text(57, 79.5, "/ month", 6.5, INK3)
                   + _bug(20, 68, 36, 15.5) + _bars(96, 60, [42, 34, 44])),
    # the app never rendered: an empty root under the browser bar
    "blank": _page(_text(80, 58, '<div id="root"></div>', 6.5, "#AAB4C8", mono=True, anchor="middle") + _bug(14, 24, 132, 62)),
    # a late banner pushes the button down after the visitor aimed at it
    "motion": _page(f'<rect x="18" y="27" width="64" height="6" rx="1.5" fill="{INK}"/>'
                    f'<rect x="18.5" y="37.5" width="123" height="18" rx="2" fill="{PANEL}" stroke="{RULE}"/>'
                    f'<rect x="18.5" y="40.5" width="48" height="14" rx="3" fill="none" stroke="{INK3}" stroke-dasharray="2 2"/>'
                    f'<rect x="18" y="63" width="49" height="15" rx="3" fill="{INK}"/>' + _text(42.5, 73, "Accept", 7.5, "#fff", 600, anchor="middle")
                    + f'<path d="M74 44v26M71 67l3 3 3-3" fill="none" stroke="{BUG}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'
                    + _cursor(38, 45) + _bars(88, 64, [50, 40], h=3)),
    # a dark theme applied halfway: dark text on the dark surface, one card left light
    "dark": _page(f'<rect x="18" y="28" width="70" height="6" rx="1.5" fill="#1C2B57"/>{_bars(18, 40, [104, 90, 98], fill="#18264F")}'
                  f'<rect x="18" y="64" width="62" height="19" rx="3" fill="#fff"/>{_bars(24, 70, [38, 26], h=3)}'
                  + _bug(14, 24, 128, 33), dark=True),
    # a phone shown the desktop layout, shrunk to fit
    "responsive": _phone(f'<rect x="51" y="15" width="16" height="2.4" rx=".8" fill="{INK}"/>{_bars(78, 15.4, [12], h=1.6)}'
                         + "".join(_bars(51 + c * 13.5, 22, [11, 9, 11, 10, 8, 11, 9, 10], fill=RULE2, h=1.3, gap=4) for c in range(3))
                         + f'<rect x="51" y="57" width="9" height="3" rx=".8" fill="{INK}"/>{_bars(51, 66, [38, 34, 37, 30], h=1.3, gap=4)}'
                         + _bug(48.5, 12.5, 46, 72) + f'<path d="M95 46h7" stroke="{BUG}" stroke-width="1.2"/>'
                         + _text(104, 44, "no viewport", 6.4, BUGT, mono=True) + _text(104, 52, "meta tag", 6.4, BUGT, mono=True)),
    # three cards whose tops and buttons do not line up
    "design": _page("".join(f'<rect x="{x}.5" y="{y}.5" width="36" height="52" rx="3" fill="#fff" stroke="{RULE}"/>'
                            f'<rect x="{x + 3}" y="{y + 3}" width="31" height="14" rx="1.5" fill="{PANEL}"/>'
                            f'{_bars(x + 3, y + 21, [28, 22], h=2.6, gap=5)}<rect x="{x + 3}" y="{b}" width="18" height="6" rx="1.5" fill="{INK}"/>'
                            for x, y, b in ((18, 29, 70), (62, 33, 75), (106, 29, 66)))
                    + f'<path d="M14 29.5h132" stroke="{BUG}" stroke-width=".9" stroke-dasharray="2 2"/>'),
    # fields labelled only by their placeholder: once filled, nothing says what they were
    "other": _page(f'<rect x="18" y="28" width="56" height="6" rx="1.5" fill="{INK}"/>'
                   f'<rect x="18.5" y="40.5" width="94" height="14" rx="3" fill="#fff" stroke="{RULE2}"/>' + _text(24, 50, "ana@example.com", 7, INK)
                   + f'<rect x="18.5" y="60.5" width="94" height="14" rx="3" fill="#fff" stroke="{RULE2}"/>' + _text(24, 70, "Toronto", 7, INK)
                   + _bug(14, 36, 103, 43)),
}

def art(fid, label):
    return (f'<svg class="vart" viewBox="0 0 160 100" role="img" aria-label="{esc(label)}">'
            f'<rect width="160" height="100" rx="8" fill="{PANEL}"/>{ART[fid]}</svg>')

# The catalog's families in its order (research/visual/CATALOG.md on the visual-data branch), with the VISUAL.md v1
# check kinds that cover each one. Sentences are plain descriptions; none carries a number.
FAMILIES = [
    ("text", "Unreadable text", "Text the same colour as its background, too faint, too small, or set over an image.",
     ["text-invisible"], "A Sign up label drawn in nearly the same colour as its white button."),
    ("media", "Missing or broken media", "Images, icons and charts that fail to load, never existed, or render stretched.",
     ["image-broken", "image-css-broken", "image-distorted", "media-failed", "icon-font-failed"], "An image box showing the broken-image glyph and its file name."),
    ("styles", "Missing styles or fonts", "CSS the page asks for and never gets: Tailwind classes that generated nothing, theme tokens that resolve to nothing, fonts and stylesheets that fail to load.",
     ["stylesheet-failed", "font-failed", "css-var-undefined", "csp-blocked"], "A button with the class bg-brand-600 rendered in the browser's default grey style and serif font."),
    ("overflow", "Layout overflow and clipping", "Content wider than its box: the page scrolls sideways on a phone, cards blow out, labels are cut off.",
     ["page-overflow-x"], "A phone whose table runs past the right edge of the screen, with a sideways scroll bar."),
    ("occlusion", "Overlap and occlusion", "Something paints over what the visitor needs: a sticky header over a heading, a dialog behind the page.",
     ["focus-obscured", "control-unreachable", "dialog-covered"], "A sticky header covering the top half of the heading Order summary."),
    ("controls", "Hidden or unreachable controls", "Controls that exist but cannot be used: an invisible layer takes the click, the page stays frozen after a modal closes, actions appear only on hover.",
     ["click-blocked", "pointer-events-leak", "scroll-lock-stuck"], "A Checkout button under an invisible layer; the cursor's click lands on the layer."),
    ("leaks", "Template and data leaks", "What should never reach a visitor: undefined, NaN, [object Object], Lorem ipsum, garbled characters.",
     ["text-template-leak", "text-placeholder", "text-encoding"], "A page reading Hi, undefined, with [object Object] and a price of $NaN per month."),
    ("blank", "Blank page and missing content", "The page, or a part of it, renders nothing.",
     ["page-blank"], "A browser window with nothing under its bar but an empty root element."),
    ("motion", "Motion and shift", "Content jumps while the page loads, or waits at opacity 0 for an animation that never runs.",
     ["layout-shift"], "A late banner pushing an Accept button down just as the cursor reaches its old place."),
    ("dark", "Dark mode", "A dark theme applied halfway: dark text left on a dark surface, light cards left behind.",
     ["text-invisible"], "A dark page whose heading and text are dark too, with one card still white."),
    ("responsive", "Responsive", "Bugs that appear only at some widths: a phone shown the desktop layout, rows that never wrap.",
     ["viewport-meta-missing", "page-overflow-x"], "A phone showing a desktop page shrunk to tiny text; no viewport meta tag."),
    ("design", "Alignment, spacing and consistency", "Nothing is broken, but edges, gaps and buttons do not line up.",
     [], "Three cards whose tops and buttons sit at different heights against a guide line."),
    ("other", "Other", "Fields labelled only by placeholder text, emoji used as icons, and pages that render differently in Safari, Firefox and Chrome.",
     [], "Two filled form fields with no labels, so nothing says what they hold."),
]
FAM = {f[0]: f for f in FAMILIES}

# The homepage's six: what the owner asked to feature, with the catalog id of each and the VISUAL.md v1 check kind that
# covers it, or None when no measured check does yet (the drawing then says so).
SPECIMENS = [
    ("text", "Invisible text", "A label in the same colour as its button.", "text-invisible", "text-invisible"),
    ("media", "Broken images", "An image URL that was made up, or a host that went away.", "image-broken", "image-broken"),
    ("overflow", "Layouts that break on phones", "One fixed-width block and the whole page scrolls sideways.", "page-overflow-x", "page-overflow-x"),
    ("leaks", "Template leaks", "undefined, NaN or [object Object] where the data should be.", "template-text-leak", "text-template-leak"),
    ("styles", "Tailwind classes that never generate", "A class built from a variable or an invented shade gets no CSS at all.", "tailwind-class-missing", None),
    ("controls", "Covered buttons", "An invisible layer on top takes the click.", "click-blocked", "click-blocked"),
]
assert all(k is None or k in FAM[fid][3] for fid, *_, k in SPECIMENS), "a specimen's check kind must be one of its family's"

# ---------------------------------------------------------------- data
UTC = datetime.timezone.utc
NOW = datetime.datetime.now(UTC)
STAGES = ("planned", "training")  # model.stage while the model is draft; each renders the weakest sentence that is true
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})")

def _moment(s):
    """An ISO date ("2026-10-14") as a date, or a date-time with a zone ("2026-10-14T22:00:00Z") as an aware datetime;
    anything else is None."""
    if not isinstance(s, str): return None
    try:
        if _DATE.fullmatch(s): return datetime.date.fromisoformat(s)
        if _STAMP.fullmatch(s): return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        pass
    return None

def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)

def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)

def _places(v):
    """Decimal places of a number as written in the data (0.425 -> 3, 0.30000000000000004 -> 17)."""
    return max(0, -decimal.Decimal(str(v)).normalize().as_tuple().exponent)

def _digits(v):
    return len(decimal.Decimal(str(v)).normalize().as_tuple().digits)

@functools.lru_cache(None)
def _on_main(path):
    """True when path is committed on origin/main: a github.com/.../blob/main/<path> link only resolves then. A file in
    this checkout that has not reached main gets no link."""
    try:
        r = subprocess.run(["git", "-C", str(REPO), "cat-file", "-e", f"origin/main:{path}"], capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0

def _src_href(s):
    if s.get("url"): return s["url"]
    p = s.get("path")
    if p and not p.startswith("/") and ".." not in p and _on_main(p): return f"{GH}/blob/main/{p}"
    return None

def _status(block):
    return ((D.get(block) or {}).get("status")) or "draft"

def _check(d):
    """(problems, missing): problems are present-but-wrong values (the build stops); missing are fields still null.
    The checks block is always checked; the model and crawl blocks only once their own status is "live"."""
    problems, missing = [], []
    def get(path):
        v = d
        for k in path.split("."):
            v = v.get(k) if isinstance(v, dict) else None
        return v
    def need(path, kind, v=None, where=None):
        v = get(path) if where is None else v
        name = where or path
        if v is None or v == "" or v == []:
            missing.append(name); return False
        ok = {"text": isinstance(v, str) and v.strip() != "",
              "date": _moment(v) is not None,
              "count": _is_int(v) and v > 0,
              "n": _is_int(v) and v >= 0,
              "share": _is_num(v) and 0 <= v <= 1,
              "positive": _is_num(v) and v > 0}[kind]
        if not ok:
            problems.append(f"{name} = {v!r} is not a {kind}" + {"share": " (a fraction from 0 to 1)",
                            "n": " (a whole number, 0 or more)",
                            "date": ' (an ISO date, "2026-10-14", or a date-time with a zone, "2026-10-14T22:00:00Z")'}.get(kind, ""))
            return False
        if kind == "share" and _places(v) > 5:
            problems.append(f"{name} = {v!r} has more decimals than anything measures: round it to at most 3 decimal places "
                            f"as a percentage (5 as a fraction)")
            return False
        if kind == "positive" and _digits(v) > 4:
            problems.append(f"{name} = {v!r}: round it to at most 4 significant digits")
            return False
        return True
    def rows(path, at_least=1):
        r = get(path)
        if not isinstance(r, list) or len(r) < at_least:
            missing.append(f"{path} (has {len(r) if isinstance(r, list) else 0} entries, needs {at_least})"); return []
        out = []
        for i, x in enumerate(r):
            if isinstance(x, dict): out.append((f"{path}[{i}]", x))
            else: problems.append(f"{path}[{i}] must be an object")
        return out
    def field(w, x, k, kind):
        return need("", kind, x.get(k), f"{w}.{k}")

    need("updated", "date")

    # ---- the measured checks (docs/runtime/RESULTS.md sections 8 and 9, docs/runtime/VISUAL.md)
    for p in ("checks.name", "checks.version", "checks.branch", "checks.measured_on"): need(p, "text")
    need("checks.date", "date"); kinds = get("checks.kinds"); need("checks.kinds", "count")
    fx_ok = [need(f"checks.fixtures.{k}", "count") for k in ("planted", "found", "kinds", "tests_passed")]
    need("checks.fixtures.on", "text")
    if all(fx_ok) and get("checks.fixtures.found") > get("checks.fixtures.planted"):
        problems.append("checks.fixtures.found is above checks.fixtures.planted")
    need("checks.recall.run", "count"); need("checks.recall.on", "text")
    seen = set()
    rr = rows("checks.recall.rows")
    for w, r in rr:
        if field(w, r, "kind", "text"):
            if r["kind"] in seen: problems.append(f"{w}.kind {r['kind']!r} appears twice")
            seen.add(r["kind"])
        ok = [field(w, r, "planted", "count"), field(w, r, "found", "n"), field(w, r, "recall", "share")]
        if all(ok):
            if r["found"] > r["planted"]: problems.append(f"{w}: found {r['found']} is above planted {r['planted']}")
            elif round(r["found"] / r["planted"], 2) != round(r["recall"], 2):
                problems.append(f"{w}: recall {r['recall']} is not found / planted ({r['found']} / {r['planted']}) to 2 decimals")
    if _is_int(kinds) and rr and len(rr) != kinds:
        problems.append(f"checks.recall.rows has {len(rr)} kinds, checks.kinds says {kinds}")
    for p in ("checks.recall.misses", "checks.clean.runs", "checks.clean.loads", "checks.clean.real", "checks.public.real",
              "checks.cost.note"): need(p, "text")
    tot = {k: get(f"checks.clean.{k}") for k in ("page_views", "false_reports", "fixes_applied")}
    t_ok = [need("checks.clean.page_views", "count"), need("checks.clean.false_reports", "n"), need("checks.clean.fixes_applied", "n")]
    sums = {k: 0 for k in tot}
    for w, r in rows("checks.clean.rows"):
        field(w, r, "pages", "text")
        ok = [field(w, r, k, "count" if k == "page_views" else "n") for k in ("page_views", "findings", "confirmed_real", "false_reports", "fixes_applied")]
        if all(ok):
            if r["findings"] != r["confirmed_real"] + r["false_reports"]:
                problems.append(f"{w}: findings must be confirmed_real + false_reports (an unlabelled finding counts as false)")
            for k in sums: sums[k] += r[k]
        else:
            t_ok.append(False)
    if all(t_ok):
        for k, v in tot.items():
            if sums[k] != v: problems.append(f"checks.clean.{k} is {v}, its rows add up to {sums[k]}")
    need("checks.public.sites", "count"); need("checks.public.on", "text")
    head = get("checks.public.run"); need("checks.public.run", "count")
    runs = {}
    for w, r in rows("checks.public.runs"):
        ok = [field(w, r, "run", "count"), field(w, r, "sites", "count"), field(w, r, "loads", "count"),
              field(w, r, "findings", "n"), field(w, r, "per_load", "share")]
        looked = r.get("looked_at", True)
        if not isinstance(looked, bool): problems.append(f"{w}.looked_at must be true or false"); continue
        if looked:
            ok += [field(w, r, k, "n") for k in ("confirmed_real", "check_errors", "unconfirmed")]
        elif r.get("confirmed_real") is not None or r.get("check_errors") is not None:
            problems.append(f"{w}: nobody looked at these findings, so confirmed_real and check_errors stay null")
        elif field(w, r, "unconfirmed", "n") and _is_int(r.get("findings")) and r["unconfirmed"] != r["findings"]:
            problems.append(f"{w}: with looked_at false every finding is unconfirmed")
        if all(ok):
            runs[r["run"]] = r
            if _is_int(get("checks.public.sites")) and r["sites"] > get("checks.public.sites"):
                problems.append(f"{w}: more sites measured than checks.public.sites")
            if round(r["findings"] / r["loads"], _places(r["per_load"])) != r["per_load"]:
                problems.append(f"{w}: per_load {r['per_load']} is not findings / loads ({r['findings']} / {r['loads']}) as written")
            if looked and r["confirmed_real"] + r["check_errors"] + r["unconfirmed"] != r["findings"]:
                problems.append(f"{w}: confirmed_real + check_errors + unconfirmed must equal findings")
    if _is_int(head) and runs and (head not in runs or not runs[head].get("looked_at", True)):
        problems.append(f"checks.public.run {head} must be a run in checks.public.runs whose findings were looked at")
    for p in ("checks.cost.run", "checks.cost.first_load_bytes"): need(p, "count")
    for p in ("checks.cost.chunk_kb_gzip", "checks.cost.chunk_kb_min", "checks.cost.slice_budget_ms", "checks.cost.pass_budget_ms"): need(p, "positive")
    need("checks.cost.first_load_entry", "text")
    for w, r in rows("checks.cost.passes"):
        field(w, r, "on", "text"); field(w, r, "loads", "count"); field(w, r, "within_budget", "share")
        for trio in (("p50_ms", "p95_ms", "max_ms"), ("slice_p50_ms", "slice_p95_ms", "slice_max_ms")):
            if all([field(w, r, k, "positive") for k in trio]) and not r[trio[0]] <= r[trio[1]] <= r[trio[2]]:
                problems.append(f"{w}: {', '.join(trio)} must not fall")
    if not any(s.get("id") == "results" and _src_href(s) for s in d.get("sources") or []):
        missing.append('sources entry "results" with a url, or a path committed on origin/main')

    # ---- the learned model, only once model.status is "live"
    if _status("model") == "live":
        for p in ("model.name", "model.version", "model.input", "model.eval.data", "model.eval.split",
                  "model.eval.false_reports_per", "model.cost_measured_on"):
            need(p, "text")
        for p in ("model.trained_on.sites_ai", "model.trained_on.sites_control", "model.trained_on.injected_faults",
                  "model.trained_on.elements", "model.natural_pages"):
            need(p, "count")
        need("model.natural_precision", "share"); need("model.size_kb", "positive"); need("model.ms_per_element", "positive")
        seen = set()
        for w, f in rows("model.families"):
            if f.get("id") not in FAMILY_IDS:
                problems.append(f"{w}.id must be one of {', '.join(FAMILY_IDS)}"); continue
            if f["id"] in seen: problems.append(f"{w}.id {f['id']!r} appears twice")
            seen.add(f["id"])
            field(w, f, "name", "text")
            ok = [field(w, f, "recall_at_fp_0_1", "share"), field(w, f, "recall_at_fp_1", "share"), field(w, f, "examples", "count")]
            if all(ok) and f["recall_at_fp_1"] < f["recall_at_fp_0_1"]:
                problems.append(f"{w}: recall at 1% false reports ({f['recall_at_fp_1']}) is below recall at 0.1% "
                                f"({f['recall_at_fp_0_1']}); allowing more false reports cannot lower recall")

    # ---- GenClass Vision (the page check's screenshot model, beta), only once vision.status is "live"
    if _status("vision") == "live":
        for p in ("vision.name", "vision.version", "vision.stage", "vision.ms_measured_on", "vision.labels", "vision.teacher",
                  "vision.clef_params"):
            need(p, "text")
        for p in ("vision.size_mb", "vision.params_m", "vision.ms_per_crop"): need(p, "positive")
        for p in ("vision.test.ap", "vision.test.ap_clef", "vision.test.ap_openai", "vision.ship_bar"): need(p, "share")
        t_ok = [need("vision.test.crops", "count"), need("vision.test.real", "count")]
        if all(t_ok) and get("vision.test.real") > get("vision.test.crops"): problems.append("vision.test.real is above vision.test.crops")
        b_ok = [need(f"vision.behind_rules.{k}", "count") for k in ("flags", "flags_real", "kept", "kept_real")]
        if all(b_ok):
            b = get("vision.behind_rules")
            if not (b["kept_real"] <= b["kept"] <= b["flags"] and b["flags_real"] <= b["flags"] and b["kept_real"] <= b["flags_real"]):
                problems.append("vision.behind_rules: kept_real <= kept <= flags and kept_real <= flags_real <= flags must hold")
        if get("vision.in_scan") is not True:
            problems.append("vision.in_scan must be true: the block describes the model the page check runs")
        if not any(s.get("id") == "vision" and _src_href(s) for s in d.get("sources") or []):
            missing.append('sources entry "vision" with a url')

    # ---- the crawl figure, only once crawl.status is "live": measured signals, shown as upper bounds
    if _status("crawl") == "live":
        need("crawl.date", "date"); need("crawl.sites_ai", "count"); need("crawl.sites_control", "count"); need("crawl.basis", "text")
        for w, s in rows("crawl.signals", 3):
            field(w, s, "name", "text"); field(w, s, "view", "text")
            field(w, s, "share_ai", "share"); field(w, s, "share_control", "share")
        if not any(s.get("id") == "crawl" and _src_href(s) for s in d.get("sources") or []):
            missing.append('sources entry "crawl" with a url, or a path committed on origin/main')
    return problems, missing

def _fail(msg):
    raise SystemExit(f"{DATA}: {msg}")

D = json.loads(DATA.read_text())
STATUS = D.get("status")
if STATUS not in ("draft", "live", "sample"):
    _fail(f"status must be \"draft\" or \"live\", not {STATUS!r}")
SAMPLE = STATUS == "sample"
if SAMPLE and DATA.resolve() == (ROOT / "src/data/visual.json").resolve():
    _fail("status \"sample\" belongs only in visual.sample.json")
for b in ("model", "crawl", "vision"):
    if _status(b) not in ("draft", "live"):
        _fail(f'{b}.status must be "draft" or "live", not {_status(b)!r}')
    if _status(b) == "live" and STATUS == "draft":
        _fail(f'{b}.status is "live" but status is "draft": the checks block goes live first')
if D.get("checks_in_runtime") is not None and not isinstance(D["checks_in_runtime"], str):
    _fail("checks_in_runtime must be a runtime version string or null")
if D.get("ready_by") is not None and _moment(D["ready_by"]) is None:
    _fail(f'ready_by must be an ISO date ("2026-10-14") or a date-time with a time zone ("2026-10-14T22:00:00Z") or null, '
          f'not {D["ready_by"]!r}')
SCAN_LIVE = D.get("scan_live", False)
if not isinstance(SCAN_LIVE, bool):
    _fail("scan_live must be true or false")
SCAN_RUNS = D.get("scan_runs") or "subset"
if SCAN_RUNS not in ("subset", "chunk", "all"):
    _fail('scan_runs must be "subset" (the page check\'s old built-in checks), "chunk" (the runtime\'s visual chunk, every '
          'kind but click-blocked) or "all" (every kind)')
STAGE = (D.get("model") or {}).get("stage") or "planned"
if STAGE not in STAGES:
    _fail(f"model.stage must be one of {', '.join(STAGES)}, not {STAGE!r}")
PROBLEMS, MISSING = _check(D)
if PROBLEMS:
    _fail("fix these values before building:\n  " + "\n  ".join(PROBLEMS))
if STATUS != "draft" and MISSING:
    _fail(f'status is "{STATUS}" but the pages need these fields, which are missing:\n  ' + "\n  ".join(MISSING)
          + '\nFill them, or set status to "draft".')
LIVE = STATUS != "draft"              # the measured checks' numbers are shown
MODEL_LIVE = LIVE and _status("model") == "live"
CRAWL_LIVE = LIVE and _status("crawl") == "live"
VISION_LIVE = LIVE and _status("vision") == "live"   # GenClass Vision, the page check's screenshot model (beta)
SHIPPED = bool(D.get("checks_in_runtime"))
C = D.get("checks") or {}
READY_BY = None if MODEL_LIVE else D.get("ready_by")  # when the model's results are due
if READY_BY:
    t = _moment(READY_BY)
    if (t < NOW.date()) if not isinstance(t, datetime.datetime) else (t < NOW):
        _fail(f"ready_by {READY_BY} has passed and the model is still draft, so the site would show a date that was "
              f"missed. Publish the model's numbers (model.status \"live\"), set a new date and say why, or set ready_by to null.")

def when(s):
    """An ISO date or date-time for a reader: October 14, 2026, or October 14, 2026, 22:00 UTC (always shown in UTC)."""
    t = _moment(s)
    if isinstance(t, datetime.datetime):
        t = t.astimezone(UTC)
        return f"{t:%B} {t.day}, {t.year}, {t:%H:%M} UTC"
    return f"{t:%B} {t.day}, {t.year}"

def when_html(s):
    """when(s) in a <time>, the date and the time each kept on one line (a heading breaks between them, not inside)."""
    t = _moment(s)
    iso = t.astimezone(UTC).strftime("%Y-%m-%dT%H:%MZ") if isinstance(t, datetime.datetime) else t.isoformat()
    parts = when(s).rsplit(", ", 1) if isinstance(t, datetime.datetime) else [when(s)]
    text = ", ".join(f'<span class="vwhen">{p}</span>' for p in parts)
    return f'<time datetime="{iso}">{text}</time>'

REPORT = (f"visual: SAMPLE DATA from {DATA}, every number is made up; written to site/.preview/, not site/public/" if SAMPLE
          else f"visual: checks live, model {'live' if MODEL_LIVE else STAGE + ' (no numbers)'}, crawl figure "
               f"{'on' if CRAWL_LIVE else 'off'}, scan box {'on' if SCAN_LIVE else 'off'}"
               + (f", model results due {when(READY_BY)}" if READY_BY else "") if LIVE else
          f"visual: draft, model {STAGE}, results due {when(READY_BY) if READY_BY else '(no date set)'}, scan box "
          f"{'on' if SCAN_LIVE else 'off'}; no numbers shown (missing: {', '.join(MISSING) or 'nothing'})")

def pct(x):
    """A fraction as a percentage at the precision written in the data: 0.42 -> 42%, 0.425 -> 42.5%, 0.0013 -> 0.13%."""
    return format((decimal.Decimal(str(x)) * 100).normalize(), "f") + "%"

def fixed(x):
    """A number in plain notation as written: 0.07 -> 0.07, 0.00001 -> 0.00001 (never 1e-05)."""
    return format(decimal.Decimal(str(x)).normalize(), "f")

def count(n):
    return f"{n:,}"

def dec2(x):
    """Recall as RESULTS.md writes it: 1.00, 0.67."""
    return f"{float(x):.2f}"

STAMP = '<span class="vsample">Sample data, not measured</span>' if SAMPLE else ""

# What the page check runs, by scan_runs:
#   "subset": the old built-in checks of scan-worker/src/checks.ts (branch wave2/scan), in the site's words. Branch
#             wave2/scan-launch deleted them.
#   "chunk":  the runtime's visual chunk (branch wave2/scan-launch, scan-worker/README.md "How it runs"): every kind
#             except click-blocked, because the scanner clicks nothing but the race probe's submit button.
#   "all":    every kind.
SCAN_SUBSET = ("text under 1.5:1 contrast, broken images, stylesheets and fonts that failed to load, template leaks, "
               "sideways scrolling on a phone, and controls covered on the first screen")
SCAN_SKIP = "click-blocked"
SCAN_SKIP_WHY = "which needs a visitor's clicks"

def scan_runs(lead="The page check runs", which=True):
    if SCAN_RUNS == "all": return f"{lead} the same checks on one public page"
    if SCAN_RUNS == "chunk": return f"{lead} the same checks on one public page, except <code>{SCAN_SKIP}</code>, {SCAN_SKIP_WHY}"
    return f"{lead} a built-in subset of them on one public page" + (f": {SCAN_SUBSET}" if which else "")

def model_sentence():
    """What the model is, at its stage: the weakest sentence that is true. What it reads is said only from model.input."""
    if STAGE == "training":
        s = ("A learned model is still being trained and evaluated on a crawl of AI-built and regular sites, with faults "
             "injected from outside each page so every example has a known label. It has no published numbers yet.")
    else:
        s = ("A learned model is planned, to be trained on a crawl of AI-built and regular sites with faults injected from "
             "outside each page, so every example has a known label.")
    inp = (D.get("model") or {}).get("input")
    return s + (f" It reads {esc(inp)}." if inp else "")

def model_short():
    """The model's state in a few words, for status rows and notices."""
    if MODEL_LIVE: return f'{esc(D["model"]["name"])} {esc(D["model"]["version"])}'
    return "Still being trained and evaluated" if STAGE == "training" else "Planned"

# ---------------------------------------------------------------- copy that depends on the data
def vt(key):
    """Sentences that change with checks_in_runtime, scan_live, the checks' status and the model (<!--@vt key--> in the
    pages)."""
    if key == "home-eyebrow":
        return "Visual bugs" if SHIPPED or SCAN_LIVE else "Visual bugs, in testing"
    if key == "home-intro":
        model = ("" if MODEL_LIVE else " The learned model is still being evaluated, and the scan does not use it." if STAGE == "training"
                 else " A learned model is planned; the scan does not use one.")
        if SCAN_LIVE: return "Invisible text, broken images, layouts that break on phones. Paste a URL to find them."
        if SHIPPED: return "GenClass measures them in the page, as the visitor's browser renders it."
        return "GenClass is testing checks that measure them in the page, as the visitor's browser renders it."
    if key == "lede":
        if SHIPPED or LIVE:
            s = "GenClass measures them on the page and names the element, what was measured, and a fix."
            return s + (" Paste an address to run the checks on one public page." if SCAN_LIVE else "")
        return "GenClass is testing checks that measure them on the page and name the element, what was measured, and a fix."
    if key == "ctas":
        if SCAN_LIVE: return '<a class="btn" href="#scan">Scan a page</a><a class="btn ghost" href="#numbers">Measured results</a>'
        return '<a class="btn" href="#families">What it finds</a><a class="btn ghost" href="#numbers">Results</a>'
    if key == "how-h2":
        model = ("a trained model" if MODEL_LIVE else "a model still in evaluation" if STAGE == "training" else "a planned model")
        return f"Measured checks, {model}, and opt-in fixes."
    if key == "fix-step":
        s = ("observe mode reports and never changes the page. With visual fixes turned on in guard or heal mode, three "
             "narrow fixes can run: a readable text colour, a leaked <code>pointer-events: none</code> removed from "
             "<code>body</code>, a stuck scroll lock released. Each is measured again after it runs, and each can be undone.")
        tail = ""
        if LIVE:
            tail = (f" On the unmodified pages of the bench, {count(C['clean']['fixes_applied'])} fixes were applied "
                    f"in {count(C['clean']['page_views'])} page views.")
        return (("Observe mode " + s[len("observe mode "):]) if SHIPPED else f"In testing: {s}") + tail
    if key == "how-note":
        design = src_link("checks", "the visual checks design", bare=False)
        lead = f"Design and thresholds: {design}. " if design else ""
        return f"{lead}The checks never feed the network model, and they read no pixels."
    if key == "limit-browser":
        s = ("In your app, the checks run in the colour scheme, width and hover state each visitor is using." if SHIPPED else
             "Once they ship in the runtime, the checks run in your app in the colour scheme, width and hover state each "
             "visitor is using.")
        return s + (" The page check adds a phone view and dark mode." if SCAN_LIVE else "")
    if key == "docs-h2":
        return "Visual bugs" if SHIPPED else "Visual bugs and the page check" if SCAN_LIVE else "Visual bugs (in testing)"
    if key == "docs-scan":
        if not SCAN_LIVE: return ""
        return (f" {scan_runs()}. Paste the address into the box on the <a href=\"/#visual\">homepage</a>, or open "
                f"<code>genclass.dev/</code> followed by the address.")
    if key == "docs-numbers":
        if not LIVE: return ""
        r = _public_run()
        return (f" Measured in CI on {when(C['date'])}: {count(C['fixtures']['found'])} of {count(C['fixtures']['planted'])} "
                f"planted faults found on fixture pages, {count(C['clean']['false_reports'])} false reports in "
                f"{count(C['clean']['page_views'])} page views of unmodified apps, and on public home pages "
                f"({_public_label(r)}), {count(r['findings'])} findings in {count(r['loads'])} loads, "
                f"{count(r['confirmed_real'])} of them confirmed real and {count(r['unconfirmed'])} unconfirmed.")
    raise SystemExit(f"visual.py: unknown text key {key!r}")

def _public_run():
    return next(r for r in C["public"]["runs"] if r["run"] == C["public"]["run"])

def _public_label(r):
    """Which bench run and how many of the sites a public-site number is from: "bench run 4, 31 of 40 sites"."""
    return f"bench run {count(r['run'])}, {count(r['sites'])} of {count(C['public']['sites'])} sites"

def _public_unreviewed():
    """Later bench runs whose findings nobody looked at (confirmed_real null), as "run 5" or "runs 5 and 6"."""
    later = [x["run"] for x in C["public"]["runs"] if x["run"] > C["public"]["run"] and x.get("confirmed_real") is None]
    if not later: return ""
    return ("run " if len(later) == 1 else "runs ") + " and ".join(count(n) for n in later)

def llms_head(rt):
    if SHIPPED: return f"Visual bug checks, from runtime {D['checks_in_runtime']}"
    if not LIVE: return f"In testing, not in {rt}"
    return f"Visual bug checks: measured in CI, not in {rt} yet" + ("; the page check is open" if SCAN_LIVE else "")

def llms_line():
    kinds = ('unreadable text, broken images, pages that scroll sideways on phones, template leaks such as "undefined", '
             'stylesheets and fonts that fail, covered controls')
    if LIVE:
        r = _public_run()
        lines = [f"- Visual bug checks ({kinds}): {count(C['kinds'])} kinds of measured check with documented thresholds, "
                 f"{esc(C['name'])} {esc(C['version'])}, not a model. Measured on {esc(C['measured_on'])}, {when(C['date'])}: "
                 f"{count(C['fixtures']['found'])} of {count(C['fixtures']['planted'])} planted faults found on fixture pages; "
                 f"{count(C['clean']['false_reports'])} false reports in {count(C['clean']['page_views'])} page views of unmodified "
                 f"demo, template and compatibility apps; on public home pages ({_public_label(r)}), {count(r['findings'])} findings in "
                 f"{count(r['loads'])} loads, {count(r['confirmed_real'])} confirmed real, {count(r['unconfirmed'])} unconfirmed. "
                 f"https://genclass.dev/visual#numbers"]
        if SCAN_LIVE:
            what = ("the same checks" if SCAN_RUNS == "all" else f"the same checks except {SCAN_SKIP}, {SCAN_SKIP_WHY}"
                    if SCAN_RUNS == "chunk" else f"a built-in subset of the checks ({SCAN_SUBSET})")
            lines.append(f"- Page check: https://genclass.dev/visual#scan, or genclass.dev/<address>. A cloud browser loads one public page and runs {what}.")
        if VISION_LIVE:
            v = D["vision"]
            lines.append(f"- {v['name']} {v['version']} ({v['stage']}): a {fixed(v['size_mb'])} MB screenshot model that gives each visual finding in "
                         f"the page check a second opinion, not scored. Average precision {fixed(v['test']['ap'])} on {count(v['test']['crops'])} held-out "
                         f"crops against Clef's {fixed(v['test']['ap_clef'])}; labels by {v['labels']}. https://genclass.dev/visual#vision")
        if MODEL_LIVE:
            m = D["model"]
            lines.append(f"- Learned visual model {m['name']} {m['version']}, numbers as of {when(D['updated'])}: https://genclass.dev/visual#numbers")
        else:
            lines.append("- Learned visual model: " + ("still being trained and evaluated" if STAGE == "training" else "planned")
                         + "; no published numbers" + (f", results due by {when(READY_BY)}" if READY_BY else "") + ".")
        return "\n".join(lines)
    model = ("A model is being trained" if STAGE == "training" else "A model is planned, to be trained") + \
        " on crawled pages with injected faults; no published numbers yet" + (f", results due by {when(READY_BY)}" if READY_BY else "")
    return f"- Visual bug checks ({kinds}): measured checks with documented thresholds. {model}. https://genclass.dev/visual"

FOOTER_LABEL = "Visual bugs" if SHIPPED or SCAN_LIVE else "Visual bugs (in testing)"

# ---------------------------------------------------------------- blocks
def scanform(name):
    i = f"scan-{name}"
    return f'''<form class="scanbox" action="/scan" method="get" data-scan>
      <label for="{i}">Page address</label>
      <div class="scanbox-row">
        <input id="{i}" name="url" type="text" inputmode="url" autocomplete="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="your-site.com" required aria-describedby="{i}-msg {i}-help">
        <button class="btn" type="submit">Scan</button>
      </div>
      <p class="scanbox-msg" id="{i}-msg" data-scan-msg aria-live="polite"></p>
      <p class="scanbox-help" id="{i}-help">{"Desktop and phone. Nothing is submitted to your site." if name == "home" else "A cloud browser loads that one page as a desktop and as a phone and reports each problem with its element and what was measured. No form or POST request reaches your server."} <a href="/scan/about">How it works →</a></p>
    </form>'''

def state():
    """The status rows under the homepage intro: the date of the numbers (or when the model's results are due), the
    page check, whether the checks are in the runtime, and the model."""
    rows = []
    if LIVE:
        rows.append(("Numbers as of", when_html(C["date"]) + STAMP, True))
    elif READY_BY:
        rows.append(("Model results due", when_html(READY_BY), True))
    if SCAN_LIVE:
        rows.append(("Page check", "Open. " + ("All of the checks" if SCAN_RUNS == "all" else
                                               "All of the checks except the one that needs a visitor's clicks"
                                               if SCAN_RUNS == "chunk" else "A built-in subset of the checks")
                     + ", on one public page.", False))
    if SHIPPED:
        rows.append(("In the runtime", f"From runtime {esc(D['checks_in_runtime'])}.", False))
    else:
        rows.append(("In the runtime", "Not yet. In testing for a release after {{rt}}." if LIVE or SCAN_LIVE
                     else "In testing. Not in runtime {{rt}}.", False))
    if MODEL_LIVE:
        model = f'{model_short()}. <a href="/visual#numbers">Results →</a>'
    else:
        model = ("Being trained and evaluated." if STAGE == "training" else "Planned.") + " No published numbers."
        if READY_BY and LIVE: model += f" Results due {when_html(READY_BY)}."
    rows.append(("Learned model", model, False))
    due = ' class="due"'
    cells = "".join(f'<div{due if big else ""}><dt>{k}</dt><dd>{v}</dd></div>' for k, v, big in rows)
    return f'<dl class="vstate">{cells}</dl>'

def checks_nums():
    """The homepage's four measured numbers for the checks, with what each counts and where it comes from."""
    if not LIVE: return ""
    fx, cl, r = C["fixtures"], C["clean"], _public_run()
    pub = C["public"]
    cells = [
        (count(C["kinds"]), "kinds of visual bug, each a measurement against a documented threshold",
         f'{esc(C["name"])} {esc(C["version"])}'),
        (f'{count(fx["found"])} of {count(fx["planted"])}', f'planted faults found on test pages, each on its element',
         f'{esc(fx["on"])}'),
        (count(cl["false_reports"]), f'false reports in {count(cl["page_views"])} page views of unmodified demo, template and test apps',
         f'desktop and phone, light and dark; bench runs {esc(cl["runs"])}'),
        (f'{count(r["confirmed_real"])} of {count(r["findings"])}',
         f'findings on public home pages confirmed real by a person, in {count(r["loads"])} loads; {count(r["unconfirmed"])} unconfirmed, '
         f'{count(r["check_errors"])} check errors',
         f'{_public_label(r)}; the checks were tuned on these sites'
         + (f'; {_public_unreviewed()} {"is" if _public_unreviewed().startswith("run ") else "are"} not reviewed yet' if _public_unreviewed() else '')),
    ]
    items = "".join(f'<div><b>{big}</b><p>{p}</p><small>{small}</small></div>' for big, p, small in cells)
    scan = f" {scan_runs('The page check runs')}." if SCAN_LIVE else ""
    return f'''<figure class="vnums-fig">
      <div class="vnums">{items}</div>
      <figcaption>Measured on {esc(C["measured_on"])}, {when_html(C["date"])}, on the checks built for the runtime.{scan} These are measurements of fixed checks, not of a model.{STAMP} <a href="/visual#numbers">Every number with its label →</a></figcaption>
    </figure>'''

def specimens():
    def cell(fid, t, s, cid, kind):
        gap = "" if kind else '<p class="vnone">No check yet</p>'
        return f'<div><h3>{esc(t)}</h3>{art(fid, FAM[fid][4])}<p>{esc(s)}</p><code>{cid}</code>{gap}</div>'
    cells = "".join(cell(*s) for s in SPECIMENS)
    covered = sum(1 for *_, k in SPECIMENS if k)
    words = ("None", "One", "Two", "Three", "Four", "Five", "All")
    gaps = len(SPECIMENS) - covered
    note = (f" {words[covered]} of the six have a measured check; {'the one' if gaps == 1 else 'the ones'} marked "
            f"No check yet {'does' if gaps == 1 else 'do'} not." if gaps else " Each has a measured check.")
    return f'''<figure class="vspec-fig">
      <div class="vspec">{cells}</div>
      <figcaption><b>Fig. 1</b> Six of the bugs in the {src_link("catalog", "GenClass catalog of visual bugs in AI-built sites")}, with their catalog ids.{note} Drawn for this page; none is a screenshot of a real site. <a href="/visual#families">Every family →</a></figcaption>
    </figure>'''

def home_specimens():
    """The homepage's drawings: only the bugs that have a measured check, a title and one line each."""
    cells = "".join(f'<div><h3>{esc(t)}</h3>{art(fid, FAM[fid][4])}<p>{esc(s)}</p></div>'
                    for fid, t, s, cid, kind in SPECIMENS if kind)
    return f'''<figure class="vspec-fig">
      <div class="vspec">{cells}</div>
      <figcaption>Drawn examples. <a href="/visual#families">Every bug family →</a></figcaption>
    </figure>'''

def home_proof():
    """One line of measured proof under the drawings, linking to the labelled numbers."""
    if not LIVE: return ""
    fx, cl = C["fixtures"], C["clean"]
    return (f'<p class="note vnote">{count(fx["found"])} of {count(fx["planted"])} planted bugs found. '
            f'{count(cl["false_reports"])} false alarms in {count(cl["page_views"])} views of correct pages. '
            f'<a href="/visual#numbers">How we measured →</a></p>')

def crawl_fig():
    """Fig. 2: measured signals on crawled pages, AI-built against regular sites. Only with crawl.status "live"; the
    shares are measured signals, not verified bugs, and are labelled as upper bounds."""
    if not CRAWL_LIVE: return ""
    c = D["crawl"]
    rows = c["signals"]
    def bar(v, cls):
        return f'<div class="vb"><div class="t"><i class="{cls}" style="width: {float(v) * 100:.2f}%"></i></div><b>{pct(v)}</b></div>'
    plot = "".join(f'<div class="vrow"><div class="vn">{esc(r["name"])} <span class="vview">{esc(r["view"])}</span></div><div class="vpair">'
                   f'{bar(r["share_ai"], "a")}{bar(r["share_control"], "c")}</div></div>' for r in rows)
    label = "; ".join(f'{r["name"]}, {r["view"]}: {pct(r["share_ai"])} of AI-built sites, {pct(r["share_control"])} of regular sites' for r in rows)
    table = "".join(f'<tr><td>{esc(r["name"])}</td><td>{esc(r["view"])}</td><td class="n">{pct(r["share_ai"])}</td><td class="n">{pct(r["share_control"])}</td></tr>' for r in rows)
    sub = (f'{when(c["date"])} crawl of {count(c["sites_ai"])} AI-built and {count(c["sites_control"])} regular sites. '
           f'{esc(c["basis"])}. Measured signals, not verified bugs, so each share is an upper bound.')
    src = src_link("crawl", "Crawl results", bare=False)
    return f'''<figure class="vcrawl">
        <div class="frame">
          <div class="ftitle">Measured signals on crawled pages: upper bounds{STAMP}</div>
          <div class="fsub">{sub}</div>
          <div class="legend"><span><span class="key" style="background: {INK}"></span>AI-built sites</span><span><span class="key" style="background: {REF}"></span>Regular sites</span></div>
          <div class="vbars" role="img" aria-label="Paired bar chart of measured signals, upper bounds. {esc(label)}.">{plot}</div>
          <details class="tview"><summary>Table view</summary><div class="tbl-wrap"><table class="vtbl"><thead><tr><th>Signal</th><th>View</th><th>AI-built sites</th><th>Regular sites</th></tr></thead><tbody>{table}</tbody></table></div></details>
        </div>
        <figcaption><b>Fig. 2</b> Share of crawled pages showing each signal. A signal is a measurement, not a bug a person confirmed, and it can count elements a visitor never sees, such as hidden carousel slides, so the share of pages with the real bug is at most this.{f" {src}." if src else ""}</figcaption>
      </figure>'''

def home_live():
    """Under the drawings: the crawl figure when it is live, then the model: a line with its numbers, or what it is."""
    out = crawl_fig()
    if not MODEL_LIVE:
        where = '<a href="/visual#numbers">/visual</a>'
        after = (f" If it meets its bar, its results go on {where} with the data and the split behind each number."
                 if STAGE == "training" else f" Its results will be published on {where}, with the data and the split behind each number.")
        lead = " Every number above is from the measured checks." if LIVE else ""
        return out + f'<p class="note vnote">{model_sentence()}{after}{lead}</p>'
    m = D["model"]; t = m["trained_on"]
    return out + f'''<div class="vmodel">
        <p><b>{esc(m["name"])} {esc(m["version"])}</b> reads {esc(m["input"])}. It was trained on {count(t["sites_ai"])} AI-built and {count(t["sites_control"])} regular sites with {count(t["injected_faults"])} faults injected from outside the page, and measured on {esc(m["eval"]["split"])}.{STAMP}</p>
        <p><a href="/visual#numbers">Recall per family, false reports, size and cost →</a></p>
      </div>'''

# the regular-sites series in Fig. 2: a lighter navy that keeps 3:1 against the #E6EBF2 track and against white
# (#AAB4C8, the site's usual reference grey, is 1.7:1 on the track)
REF = "#7A879F"

def status_notice():
    if SHIPPED:
        checks = f"The visual checks ship in runtime {esc(D['checks_in_runtime'])}; earlier versions do not have them."
    elif LIVE:
        checks = "The visual checks are built and measured in CI. They are not in runtime {{rt}} yet: they are in testing for a later release."
    else:
        checks = "The visual checks are not in runtime {{rt}}: they are built and in testing for a later release."
    scan = (f" {scan_runs(which=False)}." if SCAN_LIVE else " The page check, which scans one public page, is not open yet.")
    nums = f" Check numbers as of {when_html(C['date'])}, from the results linked under Sources." if LIVE else ""
    if MODEL_LIVE:
        model = f" Model numbers as of {when_html(D['updated'])}."
    else:
        model = (" The learned model is still being trained and evaluated" if STAGE == "training" else " The learned model is planned") + \
            (" and has no published numbers; none of the checks' numbers come from it." if VISION_LIVE else
             " and has no published numbers; nothing on this page comes from it.")
        if READY_BY: model += f" Its results are due by <b>{when_html(READY_BY)}</b>."
    lead = "" if SHIPPED or LIVE else "<b>In testing.</b> "
    return f'<p class="notice vstatus">{lead}{checks}{scan}{nums}{model}</p>'

def families():
    cells = "".join(
        f'<div id="f-{fid}">{art(fid, alt)}<h3>{esc(name)}</h3><p>{esc(sent)}</p>'
        + (f'<p class="chk">Checks: {", ".join(f"<code>{k}</code>" for k in kinds)}</p>' if kinds else
           f'<p class="chk">{"No check: design quality, not breakage" if fid == "design" else "No measured check yet"}</p>')
        + '</div>' for fid, name, sent, kinds, alt in FAMILIES)
    return f'''<figure class="vfam-fig">
      <div class="vfam">{cells}</div>
      <figcaption><b>Fig. 1</b> The bug families of the catalog, in its order. Check names are the kinds the measured checks report under. Drawn for this page; none is a screenshot of a real site.</figcaption>
    </figure>'''

def model_step():
    if not MODEL_LIVE:
        after = (" If it meets its bar, its recall and false reports will be published on this page with the data and the split."
                 if STAGE == "training" else " Its recall and false reports will be published on this page, with the data and the split.")
        vis = (f' {esc(D["vision"]["name"])}, a separate model that reads screenshot crops, gives the page check a second opinion '
               f'as a {esc(D["vision"]["stage"])} (<a href="#vision">below</a>).' if VISION_LIVE else "")
        return f'<p>{model_sentence()}{after}{vis}</p>'
    m, t = D["model"], D["model"]["trained_on"]
    return (f'<p>{esc(m["name"])} {esc(m["version"])} was trained on {count(t["sites_ai"])} AI-built and {count(t["sites_control"])} '
            f'regular sites, {count(t["elements"])} labelled elements, with {count(t["injected_faults"])} faults injected from outside '
            f'the page. It reads {esc(m["input"])}. Its recall and false reports are in Tables 5 and 6.{STAMP}</p>')

def _scan_numbers_note():
    """How the numbers on /visual relate to the page check: they were measured on the runtime's bench, not through it."""
    if not SCAN_LIVE: return ""
    if SCAN_RUNS == "subset":
        return " The page check runs a built-in subset of them; these numbers are for the full set built for the runtime."
    skip = f", except <code>{SCAN_SKIP}</code>" if SCAN_RUNS == "chunk" else ""
    return f" The page check runs the same checks{skip}; these numbers were measured on the runtime's bench, not through the page check."

def _checks_tables():
    fx, rc, cl, pub, co = C["fixtures"], C["recall"], C["clean"], C["public"], C["cost"]
    res = src_link("results", "the runtime results, sections 8 and 9", bare=True)
    recall = "".join(f'<tr><td><code>{esc(r["kind"])}</code></td><td class="n">{count(r["planted"])}</td><td class="n">{count(r["found"])}</td>'
                     f'<td class="n">{dec2(r["recall"])}</td></tr>' for r in rc["rows"])
    clean = "".join(f'<tr><td>{esc(r["pages"])}</td><td class="n">{count(r["page_views"])}</td><td class="n">{count(r["findings"])}</td>'
                    f'<td class="n">{count(r["confirmed_real"])}</td><td class="n">{count(r["false_reports"])}</td><td class="n">{count(r["fixes_applied"])}</td></tr>'
                    for r in cl["rows"])
    def opt(v): return "not looked at" if v is None else count(v)
    HL = ' class="hl"'
    public = "".join(f'<tr{HL if r["run"] == pub["run"] else ""}><td class="n">{count(r["run"])}</td><td class="n">{count(r["sites"])}</td><td class="n">{count(r["loads"])}</td>'
                     f'<td class="n">{count(r["findings"])}</td><td class="n">{fixed(r["per_load"])}</td><td class="n">{opt(r.get("confirmed_real"))}</td>'
                     f'<td class="n">{opt(r.get("check_errors"))}</td><td class="n">{count(r["unconfirmed"])}</td></tr>' for r in pub["runs"])
    passes = "".join(f'<tr><td>{esc(p["on"])}</td><td class="n">{count(p["loads"])}</td><td class="n">{fixed(p["p50_ms"])} / {fixed(p["p95_ms"])} / {fixed(p["max_ms"])}</td>'
                     f'<td class="n">{pct(p["within_budget"])}</td><td class="n">{fixed(p["slice_p50_ms"])} / {fixed(p["slice_p95_ms"])} / {fixed(p["slice_max_ms"])}</td></tr>'
                     for p in co["passes"])
    r = _public_run()
    return f'''<div class="sh"><span class="no">Results</span><h2>What was measured, and on what.</h2></div>
    <p class="intro">Every number below is for {esc(C["name"])} {esc(C["version"])} (branch <code>{esc(C["branch"])}</code>), measured on {esc(C["measured_on"])} on {when_html(C["date"])}, and copied with its label from {res}. These are measurements of fixed checks with documented thresholds, not of a model.{_scan_numbers_note()}</p>
    <ul class="vlim vkey">
      <li><b>{count(fx["found"])} of {count(fx["planted"])} planted faults found on fixture pages</b>, each on its element, {count(fx["kinds"])} kinds, {count(fx["tests_passed"])} tests passed. These are {esc(fx["on"])}, so this shows the checks work as designed.</li>
      <li><b>{count(cl["false_reports"])} false reports and {count(cl["fixes_applied"])} fixes applied in {count(cl["page_views"])} page views</b> of unmodified pages (Table 2).</li>
      <li><b>{count(r["findings"])} findings in {count(r["loads"])} loads of public home pages, {count(r["confirmed_real"])} confirmed real</b> by a person from the element's crop, {count(r["unconfirmed"])} unconfirmed, {count(r["check_errors"])} check errors (Table 3, run {count(r["run"])}).</li>
    </ul>
    <figure class="vtfig"><figcaption><b>Table 1</b> Recall on planted faults, per kind. Bench run {count(rc["run"])}: {esc(rc["on"])}. Planted counts only faults that took effect. The planted forms are the author's, so this is recall on those forms in real app layouts, not on every way such a bug appears.{STAMP}</figcaption>
    <div class="tbl-wrap"><table class="vtbl">
      <thead><tr><th>Kind</th><th>Planted</th><th>Found</th><th>Recall</th></tr></thead>
      <tbody>{recall}</tbody></table></div>
    <p class="note">{esc(rc["misses"])}</p></figure>
    <figure class="vtfig"><figcaption><b>Table 2</b> Findings on unmodified pages, bench runs {esc(cl["runs"])} (the same in both). {esc(cl["loads"])}. Pages run in guard mode with fixes on, so a fix on a page that is not broken would count as a false fix. An unlabelled finding counts as false.{STAMP}</figcaption>
    <div class="tbl-wrap"><table class="vtbl">
      <thead><tr><th>Pages</th><th>Page views</th><th>Findings</th><th>Confirmed real</th><th>False reports</th><th>Fixes applied</th></tr></thead>
      <tbody>{clean}</tbody></table></div>
    <p class="note">{esc(cl["real"])}</p></figure>
    <figure class="vtfig"><figcaption><b>Table 3</b> Findings on public home pages, per bench run. {esc(pub["on"])} Each of runs 2 to 4 followed changes made because of what the previous run found, so these sites are not held out. Run 5 followed a review of the checks; its findings were not looked at, so all count as unconfirmed. Sites are not named.{STAMP}</figcaption>
    <div class="tbl-wrap"><table class="vtbl">
      <thead><tr><th>Run</th><th>Sites measured</th><th>Loads</th><th>Findings</th><th>Per load</th><th>Confirmed real</th><th>Check errors</th><th>Unconfirmed</th></tr></thead>
      <tbody>{public}</tbody></table></div>
    <p class="note">{esc(pub["real"])}</p></figure>
    <figure class="vtfig"><figcaption><b>Table 4</b> Cost, bench run {count(co["run"])}. Time for the first automatic pass and its longest slice, p50 / p95 / max, in ms; the budget is {fixed(co["slice_budget_ms"])} ms per slice and {fixed(co["pass_budget_ms"])} ms per pass. The checks load as a separate chunk of about {fixed(co["chunk_kb_gzip"])} KB gzip ({fixed(co["chunk_kb_min"])} KB minified), and add {count(co["first_load_bytes"])} B gzip to the first load of <code>{esc(co["first_load_entry"])}</code>.{STAMP}</figcaption>
    <div class="tbl-wrap"><table class="vtbl">
      <thead><tr><th>Loads</th><th>Count</th><th>Pass time</th><th>Pass within budget</th><th>Longest slice</th></tr></thead>
      <tbody>{passes}</tbody></table></div>
    <p class="note">{esc(co["note"])}</p></figure>'''

def _model_tables():
    m, ev = D["model"], D["model"]["eval"]
    per = esc(ev["false_reports_per"])
    rows = "".join(
        f'<tr><td>{esc(f["name"])}</td><td class="n">{pct(f["recall_at_fp_0_1"])}</td><td class="n">{pct(f["recall_at_fp_1"])}</td><td class="n">{count(f["examples"])}</td></tr>'
        for f in m["families"])
    label = f'{esc(m["name"])} {esc(m["version"])}; {esc(ev["data"])}; {esc(ev["split"])}'
    return f'''<div class="sh vsh2"><span class="no">The learned model</span><h2>Recall and false reports of {esc(m["name"])} {esc(m["version"])}.</h2></div>
    <p class="intro">From the results linked under Sources, as of {when_html(D["updated"])}. Recall is the share of injected faults the model reported, at the false-report rate in the column head.</p>
    <figure class="vtfig"><figcaption><b>Table 5</b> Recall per bug family. {label}. False reports are counted per {per}.{STAMP}</figcaption>
    <div class="tbl-wrap"><table class="vtbl">
      <thead><tr><th>Family</th><th>Recall at 0.1% false reports</th><th>Recall at 1% false reports</th><th>Test examples</th></tr></thead>
      <tbody>{rows}</tbody></table></div></figure>
    <figure class="vtfig"><figcaption><b>Table 6</b> Precision on ordinary pages, size and cost. {esc(m["name"])} {esc(m["version"])}.{STAMP}</figcaption>
    <div class="tbl-wrap"><table class="vtbl vspec-t">
      <tbody>
        <tr><td>Precision on pages with no injected faults</td><td class="n">{pct(m["natural_precision"])}</td><td>{count(m["natural_pages"])} pages; {esc(ev["split"])}</td></tr>
        <tr><td>Model download</td><td class="n">{count(m["size_kb"])} KB</td><td>{esc(m["cost_measured_on"])}</td></tr>
        <tr><td>Time per element</td><td class="n">{fixed(m["ms_per_element"])} ms</td><td>{esc(m["cost_measured_on"])}</td></tr>
      </tbody></table></div></figure>'''

def numbers():
    if not LIVE:
        h2 = f"Results due by {when_html(READY_BY)}." if READY_BY else "No numbers yet."
        stage = "The model is in training" if STAGE == "training" else "The model is planned"
        return f'''<div class="sh"><span class="no">Results</span><h2>{h2}</h2></div>
    <p class="intro">{stage} and nothing about it has been measured, so this section is empty on purpose. When the results are in, it shows:</p>
    <ul class="vlim">
      <li><b>Recall per bug family</b> at two false-report rates, 0.1% and 1%, with the number of test examples behind each.</li>
      <li><b>Precision on pages with no injected faults</b>, the share of reports on ordinary pages that are real bugs.</li>
      <li><b>Size and cost</b>: the download, and the time per element on a named device.</li>
      <li><b>Where each number comes from</b>: the crawl, the data, how it was kept apart from training, and a link to the results.</li>
    </ul>'''
    if MODEL_LIVE: return _checks_tables() + _model_tables()
    due = f" Its results are due by {when_html(READY_BY)}." if READY_BY else ""
    stage = ("is still being trained and evaluated" if STAGE == "training" else "is planned")
    return _checks_tables() + f'''
    <div class="vmodel vmodel-none"><p><b>The learned model {stage}.</b> It has no published numbers, and none of the numbers above come from it. If it meets its bar, this section adds its recall per bug family at two false-report rates, its precision on pages with no injected faults, its size and its cost, with the data and the split behind each.{due}</p></div>'''

def model_limit():
    if MODEL_LIVE:
        return "<li><b>The model's numbers hold for the data in Tables 5 and 6.</b> On kinds of sites the crawl did not cover, recall and precision may be lower.</li>"
    s = "<li><b>The learned model has no numbers yet.</b> Nothing on this page claims a detection rate for it until one is measured and published.</li>"
    if LIVE:
        sites = [x["sites"] for x in C["public"]["runs"]]
        lo, hi = min(sites), max(sites)
        per = f"{count(lo)} to {count(hi)}" if lo != hi else count(lo)
        s += (f"<li><b>Measured on GenClass's own apps and {per} of {count(C['public']['sites'])} public home pages per run.</b> "
              "Recall is on faults planted in the author's own forms, and the public sites were also used to tune the checks "
              "between runs, so they are not held out.</li>")
    return s

def vision_share(a, b):
    """kept_real / kept as a whole percentage, as RESULTS.md rounds it (33 / 69 -> 48%)."""
    return f"{round(100 * a / b)}%"

def vision_home():
    """The homepage's one line on GenClass Vision."""
    if not VISION_LIVE: return ""
    v = D["vision"]; t = v["test"]
    return (f'<p class="note vnote"><b>New: {esc(v["name"])} ({esc(v["stage"])}).</b> A {fixed(v["size_mb"])} MB model now gives '
            f'each visual finding in the page check a second opinion, not scored. On our test it ranks bugs level with '
            f'Cloudflare\'s {esc(v["clef_params"])} Clef. <a href="/visual#vision">Results →</a></p>')

def vision_block():
    """/visual#vision: what GenClass Vision is, its numbers from RESULTS.md, and that it is a beta and not scored."""
    if not VISION_LIVE: return ""
    v = D["vision"]; t = v["test"]; b = v["behind_rules"]
    res = src_link("vision", "its results", bare=True)
    clef = src_link("clef", f"{esc(v['clef_params'])} parameters", bare=True)
    return f'''<div class="sh"><span class="no">{esc(v["name"])}</span><h2>A {fixed(v["size_mb"])} MB model that looks at the crop.</h2></div>
    <p class="intro">In the page check, {esc(v["name"])} {esc(v["version"])} ({esc(v["stage"])}) looks at the screenshot crop of each measured visual finding and gives it a score from 0 to 1. It never changes a finding or the score. Every number here is from {res}.{STAMP}</p>
    <ul class="vlim vkey">
      <li><b>Level with Clef on ranking.</b> Average precision {fixed(t["ap"])} on {count(t["crops"])} held-out crops ({count(t["real"])} real), against {fixed(t["ap_clef"])} for Cloudflare\'s Clef ({clef}) and {fixed(t["ap_openai"])} for {esc(v["teacher"])}, which taught it.</li>
      <li><b>Behind the measured rules, {vision_share(b["kept_real"], b["kept"])} real.</b> Of {count(b["flags"])} test crops the rules flagged ({vision_share(b["flags_real"], b["flags"])} real), it kept {count(b["kept"])}; {count(b["kept_real"])} were real.</li>
      <li><b>Small and fast.</b> {fixed(v["size_mb"])} MB, {fixed(v["params_m"])} M parameters, {fixed(v["ms_per_crop"])} ms a crop on {esc(v["ms_measured_on"])}.</li>
      <li><b>A beta.</b> The labels come from {esc(v["labels"])}. No bug family reached the {pct(v["ship_bar"])} precision bar, so nothing it says is scored.</li>
    </ul>'''

def sources():
    items = []
    for s in D.get("sources") or []:
        href, title = _src_href(s), esc(s.get("title") or s.get("id") or "")
        if not title or not href: continue  # a source nobody can open is not listed
        what = f' <span>{esc(s["used_for"])}</span>' if s.get("used_for") else ""
        items.append(f'<li><a href="{esc(href)}">{title}</a>{what}</li>')
    return f'<div class="vsrc"><b>Sources</b><ul>{"".join(items)}</ul></div>' if items else ""

def src_link(sid, text, bare=True):
    """A link to a source by id. Without an href: the plain text (bare) or None, so the caller can drop the sentence."""
    s = next((s for s in D.get("sources") or [] if s.get("id") == sid), None)
    href = _src_href(s) if s else None
    if href: return f'<a href="{esc(href)}">{text}</a>'
    return text if bare else None

def scan_section():
    if not SCAN_LIVE: return ""
    return f'''<section id="scan">
  <div class="wrap">
    <div class="sh"><span class="no">Page check</span><h2>Scan a page.</h2></div>
    <p class="intro">Paste the address of a public page. A cloud browser loads it, runs {"the measured checks" if SCAN_RUNS == "all" else f"the measured checks (all but <code>{SCAN_SKIP}</code>, {SCAN_SKIP_WHY})" if SCAN_RUNS == "chunk" else "a built-in subset of the measured checks (" + SCAN_SUBSET + ")"}, and shows each problem on a screenshot with what was measured and a suggested fix.</p>
    <!--@scanform visual-->
  </div>
</section>'''

BLOCKS = {"visual-specimens": specimens, "visual-home-live": home_live, "visual-state": state, "visual-status": status_notice,
          "visual-families": families, "visual-model-step": model_step, "visual-numbers": numbers,
          "visual-model-limit": model_limit, "visual-sources": sources, "visual-scan": scan_section,
          "visual-checks-nums": checks_nums, "visual-home-specimens": home_specimens, "visual-home-proof": home_proof,
          "visual-home-vision": vision_home, "visual-vision": vision_block}

def markers(s):
    for name, fn in BLOCKS.items():
        if f"<!--@{name}-->" in s: s = s.replace(f"<!--@{name}-->", fn())
    s = re.sub(r"<!--@vt ([\w-]+)-->", lambda m: vt(m.group(1)), s)
    s = re.sub(r"<!--@vsrc (\w+) ([^>]+?)-->", lambda m: src_link(m.group(1), m.group(2)), s)
    # the scan box only while scan_live: its routes (/scan, /scan/about, genclass.dev/<address>) come with the page check
    s, n = re.subn(r"<!--@scanform (\w+)-->", lambda m: scanform(m.group(1)) if SCAN_LIVE else "", s)
    if n and SCAN_LIVE:
        v = hashlib.sha1(SCAN_JS.read_bytes()).hexdigest()[:8]
        s += f'\n<script src="/scan-box.js?v={v}" defer></script>'
    return s
