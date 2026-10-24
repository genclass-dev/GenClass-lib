import { configureStore, type Middleware } from '@reduxjs/toolkit'
import { setupListeners } from '@reduxjs/toolkit/query'
import { api, type Item } from './api'

// A small action log, the same information Redux DevTools shows, kept on the page so the sequence is visible
// without the extension: every RTK Query action that can change the getItems cache entry, with item 1's cached
// name right after it.
export interface LogRow {
  t: number
  type: string
  endpoint?: string
  requestId?: string
  /** executeQuery/pending: its forceRefetch / subscribe flags; rejected: whether `condition` skipped it. */
  arg?: string
  name?: string
  status?: string
}

const shown = (type: string) =>
  type.startsWith('api/execute') || type === 'api/queries/queryResultPatched' || type.startsWith('__rtkq/')

let t0 = performance.now()
let rows: LogRow[] = []
const listeners = new Set<() => void>()
export const actionLog = {
  rows: () => rows,
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  /** Restart the clock and the list (the Rename button calls this, so t is "ms since the click"). */
  restart() {
    t0 = performance.now()
    rows = []
    listeners.forEach((l) => l())
  },
}

const entry = (state: any) => state.api.queries['getItems(undefined)']
const logger: Middleware = (store) => (next) => (action: any) => {
  const result = next(action)
  if (shown(action.type)) {
    const e = entry(store.getState())
    const meta = action.meta ?? {}
    const row: LogRow = {
      t: Math.round(performance.now() - t0),
      type: action.type,
      endpoint: meta.arg?.endpointName ?? (action.type === 'api/queries/queryResultPatched' ? 'getItems' : undefined),
      requestId: meta.requestId,
      name: (e?.data as Item[] | undefined)?.find((i) => i.id === 1)?.name,
      status: e?.status,
    }
    if (meta.arg?.type === 'query' && action.type.endsWith('/pending'))
      row.arg = `forceRefetch=${String(meta.arg.forceRefetch)} subscribe=${String(meta.arg.subscribe)}`
    if (action.type.endsWith('/rejected') && meta.condition) row.arg = 'condition: skipped, a fetch was in flight'
    rows = [...rows, row].slice(-500)
    listeners.forEach((l) => l())
  }
  return result
}

export const store = configureStore({
  reducer: { [api.reducerPath]: api.reducer },
  middleware: (gDM) => gDM().concat(api.middleware, logger),
})

// Needed for refetchOnFocus (the focus variant). It does nothing for the polling variant, which does not opt in.
setupListeners(store.dispatch)

declare global {
  interface Window {
    __rtk5139?: { store: typeof store; log: () => LogRow[] }
  }
}
window.__rtk5139 = { store, log: actionLog.rows }
