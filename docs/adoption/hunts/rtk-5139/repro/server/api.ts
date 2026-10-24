// The whole backend: an in-memory Map behind three routes, mounted into the Vite dev server (see vite.config.ts),
// so `npm run dev` is the only process. GET answers at once; PUT takes PUT_DELAY_MS, like a slow write endpoint.
import type { IncomingMessage, ServerResponse } from 'node:http'

export const PUT_DELAY_MS = 2000
const initial = () => new Map([[1, { id: 1, name: 'Original' }], [2, { id: 2, name: 'Untouched' }]])
let items = initial()

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function api(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/api/items') return json(res, 200, [...items.values()])
  if (req.method === 'POST' && url.pathname === '/api/reset') return (items = initial()), json(res, 200, { ok: true })
  const m = /^\/api\/items\/(\d+)$/.exec(url.pathname)
  if (req.method === 'PUT' && m) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      setTimeout(() => {
        const id = Number(m[1])
        const item = items.get(id)
        if (!item) return json(res, 404, { error: 'not found' })
        items.set(id, { ...item, name: String(JSON.parse(body).name) })
        json(res, 200, items.get(id))
      }, PUT_DELAY_MS)
    })
    return
  }
  next()
}
