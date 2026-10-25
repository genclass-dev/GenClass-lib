// Records the causal timeline of redux-toolkit#5139 with GenClass (docs/adoption/hunts/rtk-5139.md, "Timeline").
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp     # from the repository root
//   (cd docs/adoption/hunts/rtk-5139/repro && npm install)
//   node docs/adoption/hunts/rtk-5139/timeline/run.mjs [runs per variant, default 5]
//
// It starts the @genclass/mcp server in-process (its bridge on a free loopback port, no state directory), the repro's
// own Vite dev server with one change (genclass-boot.ts runs before /src/main.tsx: GenClass in observe mode,
// telemetry off, no model, and the agent link with `hold: false`), and drives Chromium through the repro's steps.
// For each run it keeps the repro's Redux action log, GenClass's recorded steps and witnesses, and merges them into one
// table by time since the click. Output: ./output (summary.json, <variant>.json and <variant>.md for the first run of
// each variant, mcp-*.txt for what the MCP tools reported).
//
// Variants:
//   polling           ?variant=polling: the next poll starts after the click (the #5139 report)
//   focus             ?variant=focus: a window focus 300 ms after the click starts the refetch
//   polling-inflight  ?variant=polling, every GET delivered 150 ms late (page.route), and the click lands while a poll
//                     is in flight (the shape of #5103 / discussion #5105: the patch is applied during a fetch)
//   none              ?variant=none: control, no polling, no refetchOnFocus

import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repro = resolve(here, '../repro')
const lib = resolve(here, '../../../../..')
const rtDist = join(lib, 'packages/runtime/dist')
const out = join(here, 'output')
const RUNS = Number(process.argv[2] ?? 5)
const VARIANTS = ['polling', 'focus', 'polling-inflight', 'none']

const { serve } = await import(pathToFileURL(join(lib, 'packages/mcp/dist/index.js')).href)
const { createServer } = await import(pathToFileURL(join(repro, 'node_modules/vite/dist/node/index.js')).href)
const { chromium } = createRequire(join(repro, 'package.json'))('@playwright/test')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ the MCP server, driven as an agent would
const input = new PassThrough()
const output = new PassThrough()
const lines = []
let buf = ''
output.setEncoding('utf8')
output.on('data', (c) => {
  buf += c
  for (let nl; (nl = buf.indexOf('\n')) >= 0; buf = buf.slice(nl + 1)) lines.push(JSON.parse(buf.slice(0, nl)))
})
const served = await serve({ cwd: here, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null })
let id = 0
async function rpc(method, params = {}) {
  const my = ++id
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`)
  for (let i = 0; i < 500; i++) {
    const m = lines.find((x) => x.id === my)
    if (m) return m
    await sleep(10)
  }
  throw new Error(`no reply to ${method}`)
}
const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rtk-5139-timeline', version: '1' } })
input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
const bridgeUrl = `http://127.0.0.1:${served.port}`

// ------------------------------------------------------------------ the repro's dev server, GenClass booted first
const vite = await createServer({
  root: repro,
  configFile: join(repro, 'vite.config.ts'),
  logLevel: 'warn',
  server: { port: 5199, strictPort: true, fs: { allow: [repro, here, rtDist] } },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  resolve: {
    alias: [
      { find: '@genclass/runtime/auto', replacement: join(rtDist, 'auto.js') },
      { find: '@genclass/runtime/agent', replacement: join(rtDist, 'agent.js') },
    ],
  },
  plugins: [
    {
      name: 'genclass-boot',
      apply: 'serve',
      transformIndexHtml: (html) => html.replace('src="/src/main.tsx"', `src="/@fs${join(here, 'genclass-boot.ts')}"`),
    },
  ],
})
await vite.listen()
const APP = 'http://localhost:5199'

// ------------------------------------------------------------------ one run
const browser = await chromium.launch()
async function run(variant) {
  await fetch(`${APP}/api/reset`, { method: 'POST' })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  await page.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridgeUrl)
  const inflight = variant === 'polling-inflight'
  if (inflight)
    await page.route('**/api/items', async (route) => {
      try {
        const response = await route.fetch()
        await sleep(150)
        await route.fulfill({ response })
      } catch {
        // the run ended (context closed) while this response was being delayed
      }
    })
  await page.goto(`${APP}/?variant=${inflight ? 'polling' : variant}`)
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 })
  await page.getByTestId('name').filter({ hasText: 'Original' }).waitFor()
  await sleep(400)
  const button = page.getByRole('button', { name: 'Rename item 1 (optimistic update, PUT takes 2 s)' })
  if (inflight) await page.waitForRequest((r) => r.url().endsWith('/api/items') && r.method() === 'GET')
  await button.click()
  if (variant === 'focus') {
    await page.getByTestId('name').filter({ hasText: 'Edited 1' }).waitFor()
    await sleep(300)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  }
  await page.getByTestId('put-status').filter({ hasText: 'fulfilled' }).waitFor({ timeout: 10_000 })
  await sleep(500)
  const data = await page.evaluate(() => ({
    recorded: window.__GENCLASS_AGENT__.recorded(),
    witnesses: window.__GENCLASS_AGENT__.witnesses(),
    errors: window.__GENCLASS_AGENT__.errors(),
    snapshot: window.__GENCLASS_AGENT__.snapshot(),
    redux: window.__rtk5139.log(),
    values: document.querySelector('[data-testid=values]')?.textContent ?? '',
    lost: document.querySelector('[data-testid=lost]')?.textContent ?? null,
  }))
  // leave the page as a user would: pagehide sends the steps a polling page never sends at a quiet point
  await page.goto('about:blank')
  await sleep(500) // the last event batch reaches the bridge
  await ctx.close()
  return { variant, consoleErrors, ...data }
}

// ------------------------------------------------------------------ merge: Redux actions + GenClass steps, by time since the click
function merge(r) {
  const click = r.recorded.steps.find((s) => s.k === 'act' && /Rename item 1/.test(s.target ?? ''))
  const t0 = click?.t ?? 0
  const rows = []
  for (const s of r.recorded.steps) {
    if (s.t < t0 - 200) continue
    const t = s.t - t0
    if (s.k === 'act') rows.push({ t, src: 'GenClass', what: `act ${s.kind} ${s.target ?? ''}`.trim() })
    else if (s.k === 'send') rows.push({ t, src: 'GenClass', what: `send ${s.key}`, detail: [s.act !== undefined ? `user action #${s.act}` : '', s.via ? `via ${s.via}` : ''].filter(Boolean).join(', ') })
    else if (s.k === 'recv') rows.push({ t, src: 'GenClass', what: `recv ${s.key}` })
    else if (s.k === 'end') rows.push({ t, src: 'GenClass', what: `end ${s.key} ${s.status}` })
    else if (s.k === 'write') rows.push({ t, src: 'GenClass', what: `write ${s.store}: ${s.paths.join(', ')}`, detail: [s.by ? `by ${s.by}` : 'by no request', s.act !== undefined ? `user action #${s.act}` : '', (s.summary ?? []).join('; ')].filter(Boolean).join(', ') })
    else if (s.k === 'error') rows.push({ t, src: 'GenClass', what: `error ${s.message}` })
  }
  for (const w of r.witnesses) rows.push({ t: w.t - t0, src: 'GenClass witness', what: `${w.kind} ${w.subject}`, detail: `by ${w.by} over ${w.overKind} ${w.over}${w.change ? `, ${w.change}` : ''}` })
  for (const a of r.redux) rows.push({ t: a.t, src: 'Redux', what: a.type, detail: [a.endpoint, a.requestId, a.arg, `status ${a.status}`, `item 1 = ${JSON.stringify(a.name)}`].filter(Boolean).join(', ') })
  const rank = { Redux: 0, GenClass: 1, 'GenClass witness': 2 }
  return rows.sort((a, b) => a.t - b.t || rank[a.src] - rank[b.src])
}
const md = (r, rows) =>
  [
    `# ${r.variant}: merged timeline (ms since the click)`,
    '',
    `Shown values: ${r.values}`,
    '',
    `Witnesses: ${r.witnesses.length ? r.witnesses.map((w) => `${w.kind} ${w.subject}`).join('; ') : 'none'}`,
    '',
    '| +ms | source | event | detail |',
    '|---:|---|---|---|',
    ...rows.map((x) => `| ${x.t} | ${x.src} | ${x.what.replace(/\|/g, '\\|')} | ${(x.detail ?? '').replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n')

// ------------------------------------------------------------------ all runs
mkdirSync(out, { recursive: true })
const summary = { runsPerVariant: RUNS, runtime: 'packages/runtime/dist (workspace build)', mcp: 'packages/mcp/dist (workspace build)', variants: {} }
for (const variant of VARIANTS) {
  const s = (summary.variants[variant] = {
    runs: 0,
    patchLost: 0,
    overwriteMs: [],
    // overwrote-newer on the cached data, landing over the click's optimistic update: the bug itself
    runsWithDataWitness: 0,
    // any other witness (RTK's bookkeeping fields: status, requestId, startedTimeStamp)
    otherWitnesses: {},
    consoleErrors: 0,
    overwritingRequest: [],
  })
  for (let i = 0; i < RUNS; i++) {
    const r = await run(variant)
    s.runs++
    if (r.lost) s.patchLost++
    const m = r.lost && /at \+(\d+) ms/.exec(r.lost)
    if (m) s.overwriteMs.push(Number(m[1]))
    const isData = (w) => w.kind === 'overwrote-newer' && /\.queries\.getItems\(undefined\)\.data$/.test(w.subject) && w.overKind === 'user'
    if (r.witnesses.some(isData)) s.runsWithDataWitness++
    for (const w of r.witnesses.filter((w) => !isData(w))) {
      const k = `${w.kind} ${w.subject.replace(/^redux\.api\.queries\.getItems\(undefined\)\./, 'getItems.')}`
      s.otherWitnesses[k] = (s.otherWitnesses[k] ?? 0) + 1
    }
    s.consoleErrors += r.consoleErrors.length
    // the request whose response wrote "Original" over "Edited 1", and when it was sent (ms since the click)
    const steps = r.recorded.steps
    const clickT = steps.find((st) => st.k === 'act' && /Rename item 1/.test(st.target ?? ''))?.t ?? 0
    const over = steps.find((st) => st.k === 'write' && st.by && st.paths.includes('redux.api.queries.getItems(undefined).data') && (st.summary ?? []).some((x) => x.includes('"Edited 1" → "Original"')))
    const sent = over && steps.find((st) => st.k === 'send' && st.key === over.by)
    if (sent) s.overwritingRequest.push({ key: over.by, via: sent.via ?? null, sentMs: sent.t - clickT, wroteMs: over.t - clickT })
    if (i === 0) {
      const rows = merge(r)
      writeFileSync(join(out, `${variant}.json`), JSON.stringify({ ...r, merged: rows }, null, 2))
      writeFileSync(join(out, `${variant}.md`), md(r, rows))
    }
    console.log(`${variant} #${i + 1}: lost=${!!r.lost} witnesses=${r.witnesses.map((w) => w.kind).join(',') || 'none'} ${r.values}`)
  }
}
for (const [name, args] of [['genclass_status', {}], ['genclass_findings', {}], ['genclass_analytics', { source: 'local' }]]) {
  const text = await tool(name, args)
  writeFileSync(join(out, `mcp-${name.replace('genclass_', '')}.txt`), text + '\n')
}
const findings = await tool('genclass_findings', {})
for (const fid of [...new Set(findings.match(/\bf\d+\b/g) ?? [])].slice(0, 3)) writeFileSync(join(out, `mcp-explain-${fid}.txt`), (await tool('genclass_explain', { id: fid })) + '\n')
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))

await browser.close()
await vite.close()
await served.close?.()
process.exit(0)
