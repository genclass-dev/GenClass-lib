"""The visual-bug feature on genclass.dev: the numbers file (src/data/visual.json), the drawn bug examples, the scan box,
and the blocks of the homepage section (src/partials/visual.html) and of /visual (src/pages/visual.html).

build.py calls markers(body) on every page. A number reaches a page only from visual.json, and only when its status is
"live" and every field the pages use is filled (src/data/README.md); "live" with a field missing stops the build. What
the pages say about the model, the runtime and the scan box follows model.stage, checks_in_runtime and scan_live, and
ready_by is the date shown as when the model's results are due (a date already past stops a draft build).
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
STAGES = ("planned", "training")  # model.stage while draft; each renders the weakest sentence that is true for it
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

def _check(d):
    """(problems, missing): problems are present-but-wrong values (the build stops); missing are fields still null."""
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
            missing.append(name); return
        ok = {"text": isinstance(v, str) and v.strip() != "",
              "date": _moment(v) is not None,
              "count": isinstance(v, int) and not isinstance(v, bool) and v > 0,
              "share": _is_num(v) and 0 <= v <= 1,
              "positive": _is_num(v) and v > 0}[kind]
        if not ok:
            problems.append(f"{name} = {v!r} is not a {kind}" + {"share": " (a fraction from 0 to 1)",
                            "date": ' (an ISO date, "2026-10-14", or a date-time with a zone, "2026-10-14T22:00:00Z")'}.get(kind, ""))
        elif kind == "share" and _places(v) > 5:
            problems.append(f"{name} = {v!r} has more decimals than anything measures: round it to at most 3 decimal places "
                            f"as a percentage (5 as a fraction)")
        elif kind == "positive" and _digits(v) > 4:
            problems.append(f"{name} = {v!r}: round it to at most 4 significant digits")
    for p in ("model.name", "model.version", "model.input", "model.eval.data", "model.eval.split",
              "model.eval.false_reports_per", "model.cost_measured_on", "crawl.measured_by"):
        need(p, "text")
    for p in ("updated", "crawl.date"):
        need(p, "date")
    for p in ("model.trained_on.sites_ai", "model.trained_on.sites_control", "model.trained_on.injected_faults",
              "model.trained_on.elements", "model.natural_pages", "crawl.sites_ai", "crawl.sites_control", "crawl.clean_sites"):
        need(p, "count")
    need("model.natural_precision", "share"); need("crawl.false_site_share", "share")
    need("model.size_kb", "positive"); need("model.ms_per_element", "positive")
    def entries(path, fields):
        rows, seen = get(path) or [], set()
        for i, f in enumerate(rows):
            if not isinstance(f, dict) or f.get("id") not in FAMILY_IDS:
                problems.append(f"{path}[{i}].id must be one of {', '.join(FAMILY_IDS)}"); continue
            if f["id"] in seen: problems.append(f"{path}[{i}].id {f['id']!r} appears twice")
            seen.add(f["id"])
            need("", "text", f.get("name"), f"{path}[{i}].name")
            for k, kind in fields: need("", kind, f.get(k), f"{path}[{i}].{k}")
        return rows
    fams = entries("model.families", [("recall_at_fp_0_1", "share"), ("recall_at_fp_1", "share"), ("examples", "count")])
    if not fams: missing.append("model.families")
    for i, f in enumerate(fams):
        lo, hi = (f.get("recall_at_fp_0_1"), f.get("recall_at_fp_1")) if isinstance(f, dict) else (None, None)
        if _is_num(lo) and _is_num(hi) and hi < lo:
            problems.append(f"model.families[{i}]: recall at 1% false reports ({hi}) is below recall at 0.1% ({lo}); "
                            f"allowing more false reports cannot lower recall")
    prev = entries("crawl.prevalence", [("share_of_ai_sites", "share"), ("share_of_control_sites", "share")])
    if len(prev) < 5: missing.append(f"crawl.prevalence (has {len(prev)} entries, needs 5)")
    if not any(s.get("id") == "results" and _src_href(s) for s in d.get("sources") or []):
        missing.append('sources entry "results" with a url, or a path committed on origin/main')
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
if D.get("checks_in_runtime") is not None and not isinstance(D["checks_in_runtime"], str):
    _fail("checks_in_runtime must be a runtime version string or null")
if D.get("ready_by") is not None and _moment(D["ready_by"]) is None:
    _fail(f'ready_by must be an ISO date ("2026-10-14") or a date-time with a time zone ("2026-10-14T22:00:00Z") or null, '
          f'not {D["ready_by"]!r}')
SCAN_LIVE = D.get("scan_live", False)
if not isinstance(SCAN_LIVE, bool):
    _fail("scan_live must be true or false")
STAGE = (D.get("model") or {}).get("stage") or "planned"
if STAGE not in STAGES:
    _fail(f"model.stage must be one of {', '.join(STAGES)}, not {STAGE!r}")
PROBLEMS, MISSING = _check(D)
if PROBLEMS:
    _fail("fix these values before building:\n  " + "\n  ".join(PROBLEMS))
if STATUS != "draft" and MISSING:
    _fail(f'status is "{STATUS}" but the pages need these fields, which are missing:\n  ' + "\n  ".join(MISSING)
          + '\nFill them, or set status to "draft".')
LIVE = STATUS != "draft"
SHIPPED = bool(D.get("checks_in_runtime"))
READY_BY = None if LIVE else D.get("ready_by")
if READY_BY:
    t = _moment(READY_BY)
    if (t < NOW.date()) if not isinstance(t, datetime.datetime) else (t < NOW):
        _fail(f"ready_by {READY_BY} has passed and status is still \"draft\", so the site would show a date that was "
              f"missed. Publish the numbers (status \"live\"), set a new date and say why, or set ready_by to null.")

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
          else "visual: live" if LIVE else
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

STAMP = '<span class="vsample">Sample data, not measured</span>' if SAMPLE else ""

def model_sentence():
    """What the model is, at its stage: the weakest sentence that is true. What it reads is said only from model.input."""
    if STAGE == "training":
        s = ("A model is being trained on a crawl of AI-built and regular sites, with faults injected from outside each "
             "page so every example has a known label.")
    else:
        s = ("A model is planned, to be trained on a crawl of AI-built and regular sites with faults injected from outside "
             "each page, so every example has a known label.")
    inp = (D.get("model") or {}).get("input")
    return s + (f" It reads {esc(inp)}." if inp else "")

# ---------------------------------------------------------------- copy that depends on the data
def vt(key):
    """Sentences that change with checks_in_runtime, scan_live and the model stage (<!--@vt key--> in the pages)."""
    if key == "home-eyebrow":
        return "Visual bugs" if SHIPPED else "Visual bugs, in testing"
    if key == "home-intro":
        if SCAN_LIVE: return "Paste an address and GenClass checks the page as a visitor's browser renders it."
        if SHIPPED: return "GenClass measures them in the page, as the visitor's browser renders it."
        return "GenClass is testing checks that measure them in the page, as the visitor's browser renders it."
    if key == "lede":
        if SHIPPED: return "GenClass measures them on the page and names the element, what was measured, and a fix."
        return "GenClass is testing checks that measure them on the page and name the element, what was measured, and a fix."
    if key == "ctas":
        if SCAN_LIVE: return '<a class="btn" href="#scan">Scan a page</a><a class="btn ghost" href="#families">What it finds</a>'
        return '<a class="btn" href="#families">What it finds</a><a class="btn ghost" href="#numbers">Results</a>'
    if key == "how-h2":
        model = "a trained model" if LIVE else "a model in training" if STAGE == "training" else "a planned model"
        return f"Measured checks, {model}, and opt-in fixes."
    if key == "fix-step":
        s = ("observe mode reports and never changes the page. With visual fixes turned on in guard or heal mode, three "
             "narrow fixes can run: a readable text colour, a leaked <code>pointer-events: none</code> removed from "
             "<code>body</code>, a stuck scroll lock released. Each is measured again after it runs, and each can be undone.")
        return ("Observe mode " + s[len("observe mode "):]) if SHIPPED else f"In testing: {s}"
    if key == "how-note":
        design = src_link("checks", "the visual checks design", bare=False)
        lead = f"Design and thresholds: {design}. " if design else ""
        return f"{lead}The checks never feed the network model, and they read no pixels."
    if key == "limit-browser":
        s = ("In your app, the checks run in the colour scheme, width and hover state each visitor is using." if SHIPPED else
             "Once they ship in the runtime, the checks run in your app in the colour scheme, width and hover state each "
             "visitor is using.")
        return s + (" The page check adds a phone view and dark mode." if SCAN_LIVE else "")
    if key == "docs-scan":
        return ", and has a box to scan one public page" if SCAN_LIVE else ""
    raise SystemExit(f"visual.py: unknown text key {key!r}")

def llms_head(rt):
    return f"Visual bug checks, from runtime {D['checks_in_runtime']}" if SHIPPED else f"In testing, not in {rt}"

def llms_line():
    kinds = ('unreadable text, broken images, pages that scroll sideways on phones, template leaks such as "undefined", '
             'stylesheets and fonts that fail, covered controls')
    if LIVE:
        m = D["model"]
        return (f"- Visual bug checks ({kinds}): measured checks with documented thresholds, and the model {m['name']} "
                f"{m['version']}, numbers as of {when(D['updated'])}: https://genclass.dev/visual#numbers")
    model = ("A model is being trained" if STAGE == "training" else "A model is planned, to be trained") + \
        " on crawled pages with injected faults; no published numbers yet" + (f", results due by {when(READY_BY)}" if READY_BY else "")
    return f"- Visual bug checks ({kinds}): measured checks with documented thresholds. {model}. https://genclass.dev/visual"

FOOTER_LABEL = "Visual bugs" if SHIPPED else "Visual bugs (in testing)"

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
      <p class="scanbox-help" id="{i}-help">A cloud browser loads that one page as a desktop and as a phone and reports each problem with its element and what was measured. No form or POST request reaches your server. <a href="/scan/about">How the scan works →</a></p>
    </form>'''

def state():
    """The status rows under the homepage intro: when the model's results are due (or the date of the numbers), whether
    the checks are in the runtime, and the model's stage."""
    rows = []
    if LIVE:
        rows.append(("Numbers as of", when_html(D["updated"]) + STAMP, True))
    elif READY_BY:
        rows.append(("Model results due", when_html(READY_BY), True))
    rows.append(("Visual checks", f"In runtime {esc(D['checks_in_runtime'])}." if SHIPPED else "In testing. Not in runtime {{rt}}.", False))
    if LIVE:
        model = f'{esc(D["model"]["name"])} {esc(D["model"]["version"])}. <a href="/visual#numbers">Results →</a>'
    else:
        model = ("In training." if STAGE == "training" else "Planned.") + " No published numbers yet."
    rows.append(("Model", model, False))
    due = ' class="due"'
    cells = "".join(f'<div{due if big else ""}><dt>{k}</dt><dd>{v}</dd></div>' for k, v, big in rows)
    return f'<dl class="vstate">{cells}</dl>'

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
      <figcaption><b>Fig. 1</b> Six of the bugs in the GenClass catalog of visual bugs in AI-built sites, with their catalog ids.{note} Drawn for this page; none is a screenshot of a real site. <a href="/visual#families">Every family →</a></figcaption>
    </figure>'''

def _prevalence_rows():
    return sorted(D["crawl"]["prevalence"], key=lambda r: -r["share_of_ai_sites"])[:5]

def home_live():
    if not LIVE:
        return (f'<p class="note vnote">{model_sentence()} Its results will be published on <a href="/visual#numbers">/visual</a>, '
                f'with the data and the split behind each number.</p>')
    m, c = D["model"], D["crawl"]
    rows = _prevalence_rows()
    def bar(v, cls):
        return f'<div class="vb"><div class="t"><i class="{cls}" style="width: {float(v) * 100:.2f}%"></i></div><b>{pct(v)}</b></div>'
    plot = "".join(f'<div class="vrow"><div class="vn">{esc(r["name"])}</div><div class="vpair">{bar(r["share_of_ai_sites"], "a")}'
                   f'{bar(r["share_of_control_sites"], "c")}</div></div>' for r in rows)
    label = "; ".join(f'{r["name"]}: {pct(r["share_of_ai_sites"])} of AI-built sites, {pct(r["share_of_control_sites"])} of regular sites' for r in rows)
    table = "".join(f'<tr><td>{esc(r["name"])}</td><td class="n">{pct(r["share_of_ai_sites"])}</td><td class="n">{pct(r["share_of_control_sites"])}</td></tr>' for r in rows)
    sub = (f'{when(c["date"])} crawl of {count(c["sites_ai"])} AI-built and {count(c["sites_control"])} regular sites. '
           f'Measured by {esc(c["measured_by"])}. At that setting, {pct(c["false_site_share"])} of {count(c["clean_sites"])} '
           f'sites verified clean were flagged as well.')
    t = m["trained_on"]
    return f'''<div class="vlive">
      <figure>
        <div class="frame">
          <div class="ftitle">Share of sites with at least one bug in the family{STAMP}</div>
          <div class="fsub">{sub}</div>
          <div class="legend"><span><span class="key" style="background: {INK}"></span>AI-built sites</span><span><span class="key" style="background: {REF}"></span>Regular sites</span></div>
          <div class="vbars" role="img" aria-label="Paired bar chart. {esc(label)}.">{plot}</div>
          <details class="tview"><summary>Table view</summary><div class="tbl-wrap"><table class="vtbl"><thead><tr><th>Family</th><th>AI-built sites</th><th>Regular sites</th></tr></thead><tbody>{table}</tbody></table></div></details>
        </div>
        <figcaption><b>Fig. 2</b> The five bug families most common on AI-built sites in the crawl, against regular sites. A site counts once per family, however many bugs of that family it has. A share close to the clean-site rate in the subtitle says little.</figcaption>
      </figure>
      <div class="vmodel">
        <p><b>{esc(m["name"])} {esc(m["version"])}</b> reads {esc(m["input"])}. It was trained on {count(t["sites_ai"])} AI-built and {count(t["sites_control"])} regular sites with {count(t["injected_faults"])} faults injected from outside the page, and measured on {esc(m["eval"]["split"])}.{STAMP}</p>
        <p><a href="/visual#numbers">Recall per family, false reports, size and cost →</a></p>
      </div>
    </div>'''

# the regular-sites series in Fig. 2: a lighter navy that keeps 3:1 against the #E6EBF2 track and against white
# (#AAB4C8, the site's usual reference grey, is 1.7:1 on the track)
REF = "#7A879F"

def status_notice():
    if SHIPPED:
        checks = f"The visual checks ship in runtime {esc(D['checks_in_runtime'])}; earlier versions do not have them."
    else:
        checks = "The visual checks are not in runtime {{rt}}: they are built and in testing for a later release."
    scan = (" The page check runs its own subset of them." if SCAN_LIVE else
            " The page check, which scans one public page, is not open yet.")
    if LIVE:
        model = f" Model numbers as of {when_html(D['updated'])}, from the results linked under Sources."
    else:
        model = (" The model is in training" if STAGE == "training" else " The model is planned") + " and has no published numbers yet."
        if READY_BY: model += f" Its results are due by <b>{when_html(READY_BY)}</b>."
    lead = "" if SHIPPED else "<b>In testing.</b> "
    return f'<p class="notice vstatus">{lead}{checks}{scan}{model}</p>'

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
    if not LIVE:
        return f'<p>{model_sentence()} Its recall and false reports will be published below, with the data and the split.</p>'
    m, t = D["model"], D["model"]["trained_on"]
    return (f'<p>{esc(m["name"])} {esc(m["version"])} was trained on {count(t["sites_ai"])} AI-built and {count(t["sites_control"])} '
            f'regular sites, {count(t["elements"])} labelled elements, with {count(t["injected_faults"])} faults injected from outside '
            f'the page. It reads {esc(m["input"])}. Its recall and false reports are in Table 1.{STAMP}</p>')

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
    m, ev = D["model"], D["model"]["eval"]
    per = esc(ev["false_reports_per"])
    rows = "".join(
        f'<tr><td>{esc(f["name"])}</td><td class="n">{pct(f["recall_at_fp_0_1"])}</td><td class="n">{pct(f["recall_at_fp_1"])}</td><td class="n">{count(f["examples"])}</td></tr>'
        for f in m["families"])
    label = f'{esc(m["name"])} {esc(m["version"])}; {esc(ev["data"])}; {esc(ev["split"])}'
    return f'''<div class="sh"><span class="no">Results</span><h2>What was measured, and on what.</h2></div>
    <p class="intro">Every number below is from the results linked under Sources, as of {when_html(D["updated"])}. Recall is the share of injected faults the model reported, at the false-report rate in the column head.</p>
    <figure class="vtfig"><figcaption><b>Table 1</b> Recall per bug family. {label}. False reports are counted per {per}.{STAMP}</figcaption>
    <div class="tbl-wrap"><table class="vtbl">
      <thead><tr><th>Family</th><th>Recall at 0.1% false reports</th><th>Recall at 1% false reports</th><th>Test examples</th></tr></thead>
      <tbody>{rows}</tbody></table></div></figure>
    <figure class="vtfig"><figcaption><b>Table 2</b> Precision on ordinary pages, size and cost. {esc(m["name"])} {esc(m["version"])}.{STAMP}</figcaption>
    <div class="tbl-wrap"><table class="vtbl vspec-t">
      <tbody>
        <tr><td>Precision on pages with no injected faults</td><td class="n">{pct(m["natural_precision"])}</td><td>{count(m["natural_pages"])} pages; {esc(ev["split"])}</td></tr>
        <tr><td>Model download</td><td class="n">{count(m["size_kb"])} KB</td><td>{esc(m["cost_measured_on"])}</td></tr>
        <tr><td>Time per element</td><td class="n">{fixed(m["ms_per_element"])} ms</td><td>{esc(m["cost_measured_on"])}</td></tr>
      </tbody></table></div></figure>'''

def model_limit():
    if LIVE:
        return "<li><b>The numbers hold for the data in Tables 1 and 2.</b> On kinds of sites the crawl did not cover, recall and precision may be lower.</li>"
    return "<li><b>The model has no numbers yet.</b> Nothing on this page claims a detection rate until one is measured and published.</li>"

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
    return '''<section id="scan">
  <div class="wrap">
    <div class="sh"><span class="no">Page check</span><h2>Scan a page.</h2></div>
    <p class="intro">Paste the address of a public page. A cloud browser loads it, runs the checks, and shows each problem on a screenshot with what was measured and a suggested fix.</p>
    <!--@scanform visual-->
  </div>
</section>'''

BLOCKS = {"visual-specimens": specimens, "visual-home-live": home_live, "visual-state": state, "visual-status": status_notice,
          "visual-families": families, "visual-model-step": model_step, "visual-numbers": numbers,
          "visual-model-limit": model_limit, "visual-sources": sources, "visual-scan": scan_section}

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
