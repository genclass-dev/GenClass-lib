// Terminal screenshots for the evidence: the real command and its captured output, rendered in a terminal window
// (dark, monospace, a prompt line) with Chromium and saved as PNG. The text is verbatim apart from ANSI colour codes
// (stripped) and this app's private dashboard link and token (redacted). Rendered, not photographed: the macOS
// Terminal cannot be driven by this session, and a rendering keeps every character readable.
import { writeFileSync } from "node:fs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
export const redact = (s) => String(s).replace(/gc_[A-Za-z0-9]{22}/g, "gc_<redacted>").replace(/\/dashboard\/[A-Za-z0-9]{20,}/g, "/dashboard/<redacted>").replace(/GENCLASS_DASHBOARD=\S+/g, "GENCLASS_DASHBOARD=<redacted>").replace(/\/api\/projects\/[A-Za-z0-9]{20,}/g, "/api/projects/<redacted>");

/** The HTML of one terminal window: `title` in the bar, `cwd` and `cmd` on the prompt line, `out` under it. */
export function terminalHtml({ title, cwd, cmd, out, kind = "shell" }) {
  const prompt = kind === "shell" ? `<span class="p">${esc(cwd)} %</span> <span class="c">${esc(cmd)}</span>` : `<span class="p">${esc(kind)}</span> <span class="c">${esc(cmd)}</span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#d9dde3;font-family:"SF Mono",Menlo,Consolas,monospace}
.win{width:980px;background:#1e1f24;border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.35);overflow:hidden}
.bar{height:34px;background:#2b2d33;display:flex;align-items:center;padding:0 12px;gap:8px;color:#aab;font:12.5px -apple-system,system-ui,sans-serif}
.dot{width:12px;height:12px;border-radius:50%}
.t{margin:0 auto;transform:translateX(-30px)}
pre{margin:0;padding:16px 18px 20px;color:#e6e6e6;font:13px/1.45 "SF Mono",Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.p{color:#7fd1a8}.c{color:#fff;font-weight:600}.o{color:#d6d8de}
</style></head><body><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">${esc(title)}</span></div><pre>${prompt}\n<span class="o">${esc(out)}</span></pre></div></body></html>`;
}

/** Render one terminal window to `png` with an open Playwright browser. */
export async function renderTerminal(browser, png, o) {
  const page = await browser.newPage({ viewport: { width: 1028, height: 600 }, deviceScaleFactor: 2 });
  await page.setContent(terminalHtml(o));
  await page.locator(".win").screenshot({ path: png });
  await page.close();
}

/** Save the transcript as text too (same redaction). */
export function saveTranscript(file, { cwd, cmd, out }) {
  writeFileSync(file, `${cwd} % ${cmd}\n${out}\n`);
}
