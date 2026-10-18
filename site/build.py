#!/usr/bin/env python3
"""Builds genclass.dev: src/pages/*.html (meta header + body) -> public/<slug>.html, plus sitemap, styles."""
import json, re, html, hashlib, pathlib, datetime
import visual as V  # site/visual.py: the visual-bug section, /visual and the scan box, from src/data/visual.json

ROOT = pathlib.Path(__file__).parent
SRC, PUB = ROOT / "src", ROOT / "public"
if V.SAMPLE:  # made-up numbers never reach public/, which is committed and deployed: the sample preview builds in .preview/
    import shutil
    shutil.copytree(PUB, ROOT / ".preview", dirs_exist_ok=True)
    PUB = ROOT / ".preview"
SITE = "https://genclass.dev"
TODAY = datetime.date.today().isoformat()
GH = "https://github.com/genclass-dev/GenClass-lib"
NPM = "https://www.npmjs.com/package/@genclass/runtime"
RT = "0.2.2"  # the pinned @genclass/runtime version shown on the site; "{{rt}}" in src/ renders as this
MODEL = "0.2.0"  # the model package the pinned runtime loads
CONTACT = "mehar@daybot.ca"  # the contact in SECURITY.md; GitHub issues and discussions are not enabled on the repo
HEADLINE = "Catch the bugs that never throw. Then stop them."  # the one line: H1, og.png, og:image:alt

# The plans: billing/plans.json at the repo root is the one source (the telemetry worker imports the same file).
# In src/, "{{plan.<id>.price|apps|history|name}}", "{{plans.apps_cap}}", "{{plans.contact}}" and "{{plans.trial_days}}"
# render from it.
PLANS = json.loads((ROOT.parent / "billing/plans.json").read_text())
PLAN = {p["id"]: p for p in PLANS["plans"]}
# How long Pro's trial lasts, the only source of the number in public copy ("a {TRIAL_DAYS}-day free trial"). The telemetry worker
# reads TRIAL_DAYS in telemetry-worker/wrangler.toml, and a telemetry-worker test checks that the two agree.
TRIAL_DAYS = PLANS.get("trial_days")
if type(TRIAL_DAYS) is not int or not 1 <= TRIAL_DAYS <= 60:
    raise SystemExit(f"billing/plans.json: trial_days must be a whole number of days from 1 to 60, not {TRIAL_DAYS!r}")
APPS_CAP = 200  # the abuse cap on apps per account, whatever the plan (MAX_APPS_PER_ACCOUNT in telemetry-worker/src/auth.ts)
SOON = "(coming next)"  # shown after a feature line whose "available" is false
# Paid plans go on sale on this site only when the pinned runtime sends to the dashboard: DASH_RT is the first version
# that sends app tokens (earlier ones ignore them, so a paid dashboard, its export and its forwarding would stay empty).
# build.sh refuses an RT the CDN does not have, so raising RT to DASH_RT or later is what opens them. Until then the
# paid plans show their prices with an inactive button, and the Product JSON-LD and llms.txt offer only Free.
# Deploy order for paid plans: (1) the telemetry worker with billing deployed, migration 0004 applied and
# scripts/stripe-setup.mjs run, so genclass.dev/account/billing sells; (2) runtime DASH_RT published to npm;
# (3) RT raised above, then ./build.sh and deploy the site.
DASH_RT = "0.3.0"

def semver(v):
    core, _, pre = v.partition("-")
    return tuple(int(x) for x in core.split(".")) + ((0,) if pre else (1,))

PAID_OPEN = semver(RT) >= semver(DASH_RT)
BILLING_URL = "https://genclass.dev/account/billing"  # served by the telemetry worker; it asks the visitor to sign in
# Pro's trial (telemetry-worker src/billing.ts): sign in (or up), then start the trial on the account page, which opens
# Stripe Checkout: a card is required and first charged when the trial ends. The worker decides whether Stripe sells
# (its key), so the button is live whatever PAID_OPEN says. Public copy states its length only from TRIAL_DAYS.
TRIAL_URL = "https://genclass.dev/account/trial"
# Said wherever the trial is offered (the worker's pages say the same: telemetry-worker src/plans.ts trialTerms).
TRIAL_TERMS = f"Card required. Nothing is charged for {TRIAL_DAYS} days; when they end, your card is charged ${PLAN['pro']['price_usd_cents']['monthly'] // 100:,} a month unless you cancel before."
# The buttons under each plan: label, link (None: an inactive button), button style, the line under it.
CTA = {"free": ("Install", "/docs", "btn ghost", "No account needed. No dashboard."),
       "pro": (f"Start your {TRIAL_DAYS}-day free trial", TRIAL_URL, "btn green", TRIAL_TERMS)}

def cta(p):
    if p["id"] == "pro": return CTA["pro"]
    if p["id"] != "free" and not PAID_OPEN:
        return (f"Opens with runtime {DASH_RT}", None, "btn ghost off", f"On sale when runtime {DASH_RT}, the first version that sends to the dashboard, is on npm.")
    return CTA.get(p["id"], (f'Start {p["name"]}', BILLING_URL, "btn", "Sign in first, then pay on Stripe."))

def usd(cents):
    return f"${cents // 100:,}" if cents % 100 == 0 else f"${cents / 100:,.2f}"

def apps(n):
    return "Unlimited" if n is None else str(n)

def history(days):
    return (f"{days // 365} year" + ("s" if days >= 730 else "")) if days % 365 == 0 else f"{days} days"

def plan_tokens(s):
    s = s.replace("{{plans.apps_cap}}", str(APPS_CAP)).replace("{{plans.trial_days}}", str(TRIAL_DAYS))
    s = s.replace("{{plans.contact}}", PLANS["contact"]).replace("{{dash_rt}}", DASH_RT)
    pick = {"name": lambda p: p["name"], "price": lambda p: usd(p["price_usd_cents"]["monthly"]),
            "apps": lambda p: apps(p["limits"]["apps"]), "history": lambda p: history(p["limits"]["history_days"])}
    return re.sub(r"\{\{plan\.(\w+)\.(\w+)\}\}", lambda m: pick[m.group(2)](PLAN[m.group(1)]), s)

css = (SRC / "css/base.css").read_text() + "\n" + (SRC / "css/components.css").read_text()
(PUB / "styles.css").write_text(css)
CSSV = hashlib.sha1(css.encode()).hexdigest()[:8]
JSV = hashlib.sha1((PUB / "app.js").read_bytes()).hexdigest()[:8]

# /login, /signup and /account (with /account/billing, where Pro and Custom are bought) are served by the telemetry
# worker, not built here; the header only links to /login. /cloud redirects to /pricing (src/worker.js).
NAV = [("Docs", "/docs", "docs"), ("How it works", "/how-it-works", "how"), ("Benchmarks", "/benchmarks", "benchmarks"), ("Guides", "/guides", "guides"), ("Pricing", "/pricing", "pricing")]

LOGO = '<a class="logo" href="/"><img src="/brand/mark-64.png?v=2" alt="" width="24" height="24">GenClass</a>'

def nav(active):
    links = "".join(f'<a href="{h}"{" class=\"on\" aria-current=\"page\"" if k == active else ""}>{t}</a>' for t, h, k in NAV)
    # Sign in: the optional accounts and their dashboards (genclass.dev/login, served by telemetry-worker/)
    mlinks = "".join(f'<a href="{h}">{t}</a>' for t, h, k in NAV) + f'<a href="{NPM}">npm</a><a href="{GH}">GitHub</a><a href="/login">Sign in</a><a href="/docs">Get started</a>'
    return f'''<header class="nav">
  <div class="wrap">
    {LOGO}
    <nav aria-label="Main">{links}</nav>
    <div class="right">
      <a class="gh" href="{NPM}">npm</a>
      <a class="gh" href="{GH}">GitHub</a>
      <a class="gh signin" href="/login">Sign in</a>
      <a class="btn" href="/docs">Get started</a>
      <details class="mnav"><summary aria-label="Open menu">Menu</summary><div class="panel">{mlinks}</div></details>
    </div>
  </div>
</header>'''

FOOTER = f'''<footer class="foot-wrap">
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">{LOGO}<p>Catch the bugs that never throw, with a model that runs in the browser.</p></div>
      <div><b>Product</b><a href="/">Runtime</a><a href="/visual">{V.FOOTER_LABEL}</a><a href="/docs/compatibility">Where it has been run</a><a href="/benchmarks">Benchmarks</a><a href="/pricing">Pricing</a><a href="/enterprise">Self-hosting, SSO, invoices</a></div>
      <div><b>Developers</b><a href="/docs">Docs</a><a href="/docs/api">API reference</a><a href="/docs/options">Options</a><a href="/how-it-works">How it works</a><a href="/docs/interception">Interception surface</a><a href="{GH}">GitHub</a><a href="{NPM}">npm</a><a href="https://discord.gg/kN9kRnFtZm">Discord</a></div>
      <div><b>Guides</b><a href="/guides/race-conditions-react">Race conditions in React</a><a href="/guides/prevent-duplicate-submissions">Duplicate submissions</a><a href="/guides/stale-responses-out-of-order">Out-of-order responses</a></div>
      <div><b>Company</b><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security</a><a href="{GH}/issues/new?title=False%20detection%3A%20">Report a false detection</a><a href="{GH}/blob/main/LICENSE">License (Apache-2.0)</a><a href="{GH}/blob/main/packages/runtime-model/MODEL_CARD.md">Model card</a></div>
    </div>
    <div class="foot">
      <span>© 2026 Daybot Solutions Inc. GenClass runtime is open source under Apache-2.0.</span>
      <span>Made for developers who read the console.</span>
    </div>
  </div>
</footer>'''

ORG = {"@type": "Organization", "@id": f"{SITE}/#org", "name": "GenClass", "url": f"{SITE}/",
       "logo": f"{SITE}/icon-512.png", "sameAs": [GH, NPM]}
WEBSITE = {"@type": "WebSite", "@id": f"{SITE}/#site", "url": f"{SITE}/", "name": "GenClass", "publisher": {"@id": f"{SITE}/#org"}}

def page(meta, body):
    path = meta["path"]; url = SITE + (path if path != "/" else "/")
    title, desc = meta["title"], meta["description"]
    graph = [ORG, WEBSITE]
    crumbs = meta.get("crumbs")
    if crumbs:
        items = [{"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE}/"}]
        items += [{"@type": "ListItem", "position": i + 2, "name": n, "item": SITE + h} for i, (n, h) in enumerate(crumbs)]
        graph.append({"@type": "BreadcrumbList", "itemListElement": items})
        trail = '<a href="/">Home</a>' + "".join(f'<span aria-hidden="true">/</span>{"<a href=" + chr(34) + h + chr(34) + ">" + n + "</a>" if i < len(crumbs) - 1 else "<span>" + n + "</span>"}' for i, (n, h) in enumerate(crumbs))
        body = body.replace("<!--@crumbs-->", f'<nav class="crumbs" aria-label="Breadcrumb">{trail}</nav>')
    graph += meta.get("jsonld", [])
    if meta.get("offers_from_plans"): graph.append(offers_jsonld())
    if meta.get("faq_from_body"): graph.append(faq_jsonld(body))
    robots = "noindex, follow" if meta.get("noindex") else "index, follow, max-image-preview:large, max-snippet:-1"
    og_type = meta.get("og_type", "website")
    extra = ""
    if og_type == "article":
        extra = f'<meta property="article:published_time" content="{meta.get("published", TODAY)}">\n<meta property="article:modified_time" content="{TODAY}">\n'
    head = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{url}">
<meta name="robots" content="{robots}">
<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark">
<meta name="author" content="GenClass">
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="GenClass">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{meta.get("og_title", title)}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{SITE}/og.png?v=6">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="GenClass: {HEADLINE}">
<meta property="og:locale" content="en_US">
{extra}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{meta.get("og_title", title)}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{SITE}/og.png?v=6">
<link rel="icon" href="/brand/mark-32.png?v=2" sizes="32x32" type="image/png">
<link rel="icon" href="/brand/mark-64.png?v=2" sizes="64x64" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="sitemap" type="application/xml" href="/sitemap.xml">
<link rel="preconnect" href="https://cdn.fontshare.com" crossorigin>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@1&amp;display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet">
<script>document.documentElement.classList.add("js")</script>
<link rel="stylesheet" href="/styles.css?v={CSSV}">
<script type="application/ld+json">{json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False)}</script>
{meta.get("head_extra", "")}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
'''
    out = (head + nav(meta.get("nav")) + f'\n<main id="main">\n{body}\n</main>\n' + FOOTER + f'\n<script src="/app.js?v={JSV}" defer></script>\n{meta.get("body_extra", "")}</body>\n</html>\n').replace("{{rt}}", RT)
    return plan_tokens(out)

# ---------- shared blocks ----------
def plans_block():
    """The plans as one ruled comparison, every line from billing/plans.json. Desktop: three columns whose rows line
    up (CSS subgrid); phone: the plans stacked."""
    def line(f):
        t = f["text"]
        if t.startswith("Everything in "): return f'<li class="inc">{t}</li>'
        if f["available"]: return f'<li><span>{t}</span></li>'
        return f'<li class="soon"><span>{t.replace(SOON, "").strip()} <em>{SOON}</em></span></li>'
    cols = []
    for i, p in enumerate(PLANS["plans"]):
        cents = p["price_usd_cents"]["monthly"]
        label, href, btn, note = cta(p)
        cols.append(f'''<article class="plan" aria-labelledby="plan-{p["id"]}">
      <p class="plan-k">{i + 1:02d}</p>
      <h3 id="plan-{p["id"]}">{p["name"]}</h3>
      <p class="plan-price"><b>{usd(cents)}</b><span>{"per month" if cents else "no card needed"}</span></p>
      <p class="plan-sum">{p["summary"]}</p>
      <div class="plan-cta">{f'<a class="{btn}" href="{href}">{label}</a>' if href else f'<span class="{btn}" aria-disabled="true">{label}</span>'}<p>{note}</p></div>
      <ul class="plan-feat">{"".join(line(f) for f in p["features"])}</ul>
    </article>''')
    c = PLANS["contact"]
    more = PLANS["footer"].replace(c, f'<a href="mailto:{c}?subject=GenClass%20self-hosting%2C%20SSO%20or%20invoices">{c}</a>')
    return '<div class="plans">\n    ' + "\n    ".join(cols) + f'\n    </div>\n    <p class="plans-more">{more}</p>'

def faq_jsonld(body):
    """FAQPage JSON-LD from the page's own <details> questions, so the structured data cannot drift from the text."""
    qa = []
    for q, a in re.findall(r"<details><summary>(.*?)</summary>\s*<p>(.*?)</p></details>", body, re.S):
        clean = lambda t: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", t))).strip()
        qa.append({"@type": "Question", "name": clean(q), "acceptedAnswer": {"@type": "Answer", "text": clean(a)}})
    return {"@type": "FAQPage", "mainEntity": qa}

def offers_jsonld():
    """Product JSON-LD with one Offer per plan in billing/plans.json."""
    offers = []
    for p in PLANS["plans"]:
        cents = p["price_usd_cents"]["monthly"]; price = f"{cents / 100:g}"
        if cents and not PAID_OPEN: continue  # not on sale on this site yet (DASH_RT)
        o = {"@type": "Offer", "name": p["name"], "price": price, "priceCurrency": "USD", "url": f"{SITE}/pricing",
             "availability": "https://schema.org/InStock", "description": p["summary"]}
        if cents:
            o["priceSpecification"] = {"@type": "UnitPriceSpecification", "price": price, "priceCurrency": "USD", "unitText": "MONTH", "billingDuration": "P1M"}
        offers.append(o)
    return {"@type": "Product", "name": "GenClass", "brand": {"@type": "Brand", "name": "GenClass"}, "image": f"{SITE}/icon-512.png", "url": f"{SITE}/pricing",
            "description": "An open-source runtime that reports, and can prevent, the web app bugs that never throw, with a dashboard at genclass.dev.", "offers": offers}

def blocks(s):
    s = s.replace("<!--@plans-->", plans_block())
    for name in ("trace", "demo", "figs", "data", "status", "how", "lab", "visual", "before-after"):
        p = SRC / "partials" / f"{name}.html"
        if p.exists(): s = s.replace(f"<!--@{name}-->", p.read_text())
    return V.markers(s)

# ---------- build ----------
urls = []
for f in sorted((SRC / "pages").glob("**/*.html")):
    txt = f.read_text()
    m = re.match(r"<!--meta\s*(\{.*?\})\s*-->\n", txt, re.S)
    meta = json.loads(m.group(1)); body = blocks(txt[m.end():])
    out = PUB / ("index.html" if meta["path"] == "/" else meta["path"].strip("/") + ".html")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page(meta, body))
    if not meta.get("noindex"): urls.append((meta["path"], meta.get("priority", "0.7")))

# ---------- reference docs rendered from the repo's markdown (source of truth stays in the repo) ----------
REPO = ROOT.parent
MD_DOCS = [
    ("docs/runtime/API.md", "/docs/api", "API Reference", "GenClass Runtime API Reference",
     "Complete API reference for @genclass/runtime: init and modes, options, state, operations, asking the model, events, policy, explain, undo, plugins and adapters."),
    ("docs/runtime/OPTIONS-SPEC.md", "/docs/options", "Options Reference", "GenClass Options Reference",
     "Every GenClass init option: activation, route scopes, protected endpoints, breaker, shadow mode, veto, action limits, hold budgets and sinks."),
    ("docs/runtime/ARCHITECTURE.md", "/docs/architecture", "Architecture", "GenClass Runtime Architecture",
     "How the GenClass runtime is built: observers, causality, stores, facts, triage, the policy gate, actions and the on-device model host."),
    ("packages/runtime/TELEMETRY.md", "/docs/telemetry", "Telemetry", "GenClass Telemetry and Privacy",
     "What anonymous diagnostics the GenClass runtime sends by default, what it never sends, and every way to turn it off."),
    ("packages/runtime/INTERCEPTION.md", "/docs/interception", "Interception surface", "GenClass Interception Surface",
     "Every browser API GenClass wraps or observes, what each mode may change, what it never does, and how it restores the originals."),
    ("docs/runtime/THREAT-MODEL.md", "/docs/threat-model", "Threat model", "GenClass Threat Model",
     "The GenClass security threat model: model supply chain, crafted responses, page scripts, telemetry and denial of service, with mitigations."),
    ("SECURITY.md", "/security", "Security", "GenClass Security Policy",
     "How to report a vulnerability in GenClass, supported versions and the security design of the runtime."),
    ("bench/perf/RESULTS.md", "/benchmarks/performance", "Performance", "GenClass Browser Performance Benchmarks",
     "Reproducible browser performance results for GenClass: bytes, model load, inference latency, main-thread cost, memory and emulated mobile."),
    ("compat/RESULTS.md", "/docs/compatibility", "Compatibility", "GenClass Framework Compatibility Matrix",
     "GenClass tested across React, Next.js, Vue, SvelteKit, Angular and Solid with TanStack Query, SWR, Redux, Zustand, Apollo and more."),
]
try:
    import markdown as _md
except ImportError:
    raise SystemExit("build.py needs the 'markdown' package for the reference docs (pip install markdown==3.7)")

def gh_link(src_dir, target):
    if re.match(r"^(https?:|mailto:|#)", target): return target
    path, _, frag = target.partition("#")
    full = (pathlib.PurePosixPath(src_dir) / path).as_posix()
    parts = []
    for seg in full.split("/"):
        if seg == "..": parts and parts.pop()
        elif seg not in (".", ""): parts.append(seg)
    full = "/".join(parts)
    for s_, p_, *_ in MD_DOCS:
        if full == s_ and (REPO / s_).exists(): return p_ + (("#" + frag) if frag else "")
    return f"{GH}/blob/main/{full}" + (("#" + frag) if frag else "")

doc_links = [(p_, nav_t) for s_, p_, nav_t, *_ in MD_DOCS if (REPO / s_).exists()]
for src, path, nav_t, title, desc in MD_DOCS:
    f = REPO / src
    if not f.exists() or _md is None: continue
    text = f.read_text()
    h1 = re.search(r"^# (.+)$", text, re.M)
    heading = h1.group(1).strip() if h1 else nav_t
    if h1: text = text[:h1.start()] + text[h1.end():]
    src_dir = str(pathlib.PurePosixPath(src).parent)
    text = re.sub(r"\]\(([^)\s]+)\)", lambda m: "](" + gh_link(src_dir, m.group(1)) + ")", text)
    md = _md.Markdown(extensions=["tables", "fenced_code", "toc", "sane_lists"], extension_configs={"toc": {"toc_depth": "2"}})
    html_body = md.convert(text)
    toc = "".join(f'<a href="#{t["id"]}">{t["name"]}</a>' for t in md.toc_tokens[:24] if t["level"] <= 2) if hasattr(md, "toc_tokens") else ""
    if not toc:
        toc = "".join(f'<a href="#{i}">{n}</a>' for i, n in re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', html_body))
    side = "<b>Reference</b>" + "".join(f'<a href="{p_}">{t_}</a>' for p_, t_ in doc_links) + (f"<b>On this page</b>{toc}" if toc else "")
    crumbs = [("Docs", "/docs"), (nav_t, path)] if path.startswith("/docs/") else ([("Benchmarks", "/benchmarks"), (nav_t, path)] if path.startswith("/benchmarks/") else [(nav_t, path)])
    meta = {"path": path, "nav": "docs" if path.startswith("/docs") else ("benchmarks" if path.startswith("/benchmarks") else ""), "priority": "0.6",
            "crumbs": crumbs, "title": title, "description": desc,
            "jsonld": [{"@type": "TechArticle", "headline": heading, "author": {"@id": f"{SITE}/#org"}, "publisher": {"@id": f"{SITE}/#org"},
                        "dateModified": TODAY, "isBasedOn": f"{GH}/blob/main/{src}"}]}
    body = f"""<div class="page-hero"><div class="wrap"><!--@crumbs--><h1>{heading}</h1>
<p class="lede">Rendered from <a href="{GH}/blob/main/{src}"><code>{src}</code></a> in the GenClass repository.</p></div></div>
<section style="padding-top: 24px"><div class="wrap doc"><nav class="toc" aria-label="Reference">{side}</nav><article class="prose">{html_body}</article></div></section>"""
    out = PUB / (path.strip("/") + ".html"); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page(meta, body)); urls.append((path, "0.6"))

sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
for p, pr in sorted(urls, key=lambda x: -float(x[1])):
    sm.append(f"  <url><loc>{SITE}{p}</loc><lastmod>{TODAY}</lastmod><priority>{pr}</priority></url>")
sm.append("</urlset>")
(PUB / "sitemap.xml").write_text("\n".join(sm) + "\n")

# ---------- llms.txt: generated here so the version and the numbers cannot drift from the pages ----------
# Sources: docs/runtime/RESULTS.md (model numbers), compat/RESULTS.md (matrix), packages/runtime/README.md (costs, telemetry).
def llms_plans():
    out = []
    for p in PLANS["plans"]:
        cents = p["price_usd_cents"]["monthly"]
        sale = f"billed monthly through Stripe Checkout; sign in, then {BILLING_URL}" if PAID_OPEN else f"not on sale yet: it opens with runtime {DASH_RT}, the first version that sends to the dashboard"
        if p["id"] == "pro": sale = f"get a {TRIAL_DAYS}-day free trial for analytics at {TRIAL_URL}, with a card that is first charged when the trial ends; " + sale
        head = f'- {p["name"]}, ' + (f"US{usd(cents)} per month ({sale})" if cents else "US$0")
        feats = "; ".join(f["text"] if f["available"] or SOON in f["text"] else f'{f["text"]} {SOON}' for f in p["features"])
        out.append(f"{head}: {feats}.")
    out.append(f"- Unlimited apps means no plan limit; one account holds at most {APPS_CAP} apps as an abuse limit. The runtime is free in every plan.")
    out.append(f'- {PLANS["footer"]} https://genclass.dev/enterprise')
    return "\n".join(out)

LLMS = f"""# GenClass

> GenClass Runtime (`@genclass/runtime`, Apache-2.0, free) is a browser library that runs a 10 MB model on the user's device and reports, with evidence, the timing bugs that never throw: duplicate submits, stale responses landing over newer data, write races, broken relations between fields and failure storms. Observe mode, the default, reports and never changes what the app does. Guard mode (opt-in) can act at the network boundary; heal is experimental. No server, no API key. The runtime and its on-device model are free; the genclass.dev dashboard comes with Pro (get a {TRIAL_DAYS}-day free trial for analytics), with history, data export and forwarding, and Custom adds a model trained on the customer's app.

## Shipped
- `@genclass/runtime` {RT} with `@genclass/runtime-model` {MODEL} (training run r17-v2dT). Default mode observe, default aggressiveness "balanced", report threshold 0.90.
- Install: `npm install @genclass/runtime`, then `import "@genclass/runtime/auto"` as the first line of the entry file. CLI: `npx @genclass/runtime init`. Script tag, first in <head>: `<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@{RT}"></script>` (pin the version: the unversioned URL may serve an older release from the CDN cache).
- Modes: observe (default; changes nothing), guard (opt-in: discard, defer, coalesce, delay), heal (experimental: retry, serve_cached, hedge, rollback, resync).
- Cost: +98 KB of JavaScript on first load; about 13 MB downloaded once at idle on WASM (18 MB on WebGPU), then cached; 190 to 280 MB of memory in a Web Worker while the model is loaded; no device floor by default (`model.loadIf` sets one; `model: false` installs no model and then detects nothing).
- Telemetry: anonymous diagnostics are on by default on public hosts; from runtime 0.2.2 they are off on localhost and private hosts (0.2.1 sent from those too, by mistake); they contain no page text. Opt out: `GenClass.init({{ telemetry: false }})`, `npx @genclass/runtime init --no-telemetry`, `?genclass=no-telemetry`, localStorage `genclass.telemetry=off`, or Global Privacy Control. https://genclass.dev/docs/telemetry
- Reports are console lines in the end user's browser; the `sinks` option forwards each report to the app's own logging or to an endpoint it owns (from runtime 0.3.0: ready-made `console-json` and `webhook` sinks; the runtime has no Sentry, PostHog or Datadog adapter). Forwarding detections from the genclass.dev collector to Sentry, PostHog, Datadog, Slack or a signed webhook is part of the Pro plan.

## Measured (https://genclass.dev/benchmarks; raw tables in docs/runtime/RESULTS.md and compat/RESULTS.md)
- Model {MODEL} at the shipped setting (balanced), held-out real apps: detects 75% of duplicate submits, 30% of stale overwrites and 6% of broken state; guard acts on 7.5% of the cases where acting would help.
- False interventions, model {MODEL}, held-out simulated apps: guard 0.005% / 0.13% / 0.54% and heal 0.26% / 0.59% / 1.84% for cautious / balanced / eager (targets 0.1% guard, 0.5% heal: cautious meets both, balanced is slightly over). 0.00% on held-out real apps at every profile.
- Compatibility matrix (runtime 0.1.0-beta.4, the code shipped as 0.2.1; model {MODEL}, balanced; run 2026-10-10): 7 frameworks, 15 data layers, 8 scenarios, 10 seeds, every mode. 350 of 351 cells pass; 0 bugs introduced in 3,510 runs; 0 non-passive actions on correct apps in 1,760 guard and heal runs; guard left 249 of 250 latent-bug runs buggy; observe mode produced 49 false findings in 880 runs on correct apps. https://genclass.dev/docs/compatibility
- Never-worse check: 0 of 396 clean real-app runs changed (66 apps × 6 seeds, always-passive model, v2 runtime as of 0.1.0-alpha.1; not re-run on {RT}).
- Six demo apps under network chaos, model {MODEL}, balanced: bug rate 72% with GenClass off, 70% observe, 72% guard, 73% heal. Nothing is healed at the shipped gates.
- Previous model 0.1.0 (r17-v2b), observe mode at report threshold 0.70: 96% detection precision on 16,600 held-out real-app situations, 0.62% false detections on clean traffic. Not re-measured for {MODEL}.
- Model: 8.8M parameters, 10.2 MB q8, about 180 ms per decision on one WASM thread (182 ms for the shipped export), faster on WebGPU.
- Training data: about 17.6M labelled runtime situations, including 837,623 real-browser rows from 158 apps.

## Plans (https://genclass.dev/pricing; source: billing/plans.json)
{llms_plans()}

## {V.llms_head(RT)}
{V.llms_line()}

## Guides
- How to fix race conditions in React data fetching: https://genclass.dev/guides/race-conditions-react
- Out-of-order responses and stale search results: https://genclass.dev/guides/stale-responses-out-of-order
- How to prevent duplicate form submissions: https://genclass.dev/guides/prevent-duplicate-submissions

## Links
- Docs: https://genclass.dev/docs
- How it works: https://genclass.dev/how-it-works
- GitHub: {GH}
- npm: {NPM}
- Contact (GitHub issues are not enabled): {CONTACT}
"""
(PUB / "llms.txt").write_text(LLMS)
print("built", len(urls), "indexable pages:", ", ".join(p for p, _ in urls), "into", PUB)
print(V.REPORT)
