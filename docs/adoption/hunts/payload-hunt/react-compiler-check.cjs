// Payload's @payloadcms/ui build, for one file: SWC with packages/ui/.swcrc, then Babel with babel-plugin-react-compiler
// (packages/ui/babel.config.cjs). Prints the compiler's events and whether the component was memoized (`_c(`).
//   PAYLOAD_DIR=<payload checkout> node react-compiler-check.cjs <file.tsx> [<file2.tsx> ...]
const path = require('path')
const fs = require('fs')
const UI = `${process.env.PAYLOAD_DIR ?? process.cwd()}/packages/ui` // PAYLOAD_DIR: a Payload checkout with pnpm install done
const req = (m) => require(require.resolve(m, { paths: [UI] }))
const swc = req('@swc/core')
const babel = req('@babel/core')
const swcrc = JSON.parse(fs.readFileSync(path.join(UI, '.swcrc'), 'utf8'))
delete swcrc.$schema
for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, 'utf8')
  const js = swc.transformSync(src, { ...swcrc, filename: 'index.tsx', sourceMaps: false }).code
  const events = []
  const out = babel.transformSync(js, {
    babelrc: false,
    configFile: false,
    filename: path.join(UI, 'src/elements/Table/RelationshipProvider/index.js'),
    plugins: [[req('babel-plugin-react-compiler'), {
      logger: { logEvent: (_f, e) => events.push(e.kind === 'CompileError' ? `CompileError: ${e.detail?.reason ?? e.detail?.options?.reason ?? JSON.stringify(e.detail).slice(0, 200)}` : e.kind) },
    }]],
  }).code
  const memo = /_c\(\d+\)/.exec(out)?.[0] ?? 'none'
  console.log(`${path.basename(path.dirname(file))}/${path.basename(file)}: memo cache ${memo}; events: ${[...new Set(events)].join(' | ')}`)
}
