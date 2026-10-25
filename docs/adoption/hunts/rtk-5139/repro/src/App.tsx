import { useRef, useSyncExternalStore } from 'react'
import { useGetItemsQuery, useRenameItemMutation } from './api'
import { actionLog, type LogRow } from './store'

// ?variant=polling (default): useGetItemsQuery(undefined, { pollingInterval: 100 })
// ?variant=focus:             useGetItemsQuery(undefined, { refetchOnFocus: true }) with setupListeners (store.ts)
// ?variant=none:              control, neither: the optimistic value stays while the PUT is pending
const variants = {
  polling: { label: 'pollingInterval: 100', options: { pollingInterval: 100 } },
  focus: { label: 'refetchOnFocus: true', options: { refetchOnFocus: true } },
  none: { label: 'control (no polling, no refetchOnFocus)', options: {} },
} as const
type Variant = keyof typeof variants
const param = new URLSearchParams(location.search).get('variant')
const variant: Variant = param && param in variants ? (param as Variant) : 'polling'

export function App() {
  const { data, isFetching } = useGetItemsQuery(undefined, variants[variant].options)
  const [rename, mutation] = useRenameItemMutation()
  const edits = useRef(0)
  const rows = useSyncExternalStore(actionLog.subscribe, actionLog.rows)
  const name = data?.find((i) => i.id === 1)?.name

  const onRename = () => {
    actionLog.restart()
    edits.current += 1
    void rename({ id: 1, name: `Edited ${edits.current}` })
  }

  return (
    <main>
      <h1>redux-toolkit#5139: optimistic update replaced while the mutation is pending</h1>
      <p>
        <code>@reduxjs/toolkit</code> {__RTK_VERSION__}. The click dispatches a mutation whose <code>onQueryStarted</code>{' '}
        patches the <code>getItems</code> cache with <code>api.util.updateQueryData</code>. <code>PUT /api/items/1</code>{' '}
        takes 2000 ms; <code>GET /api/items</code> answers at once.
      </p>
      <nav>
        {(Object.keys(variants) as Variant[]).map((v) => (
          <a key={v} href={`?variant=${v}`} aria-current={v === variant ? 'page' : undefined}>
            {variants[v].label}
          </a>
        ))}
      </nav>

      <section className="card">
        <div>
          Item 1 name in the cache: <output data-testid="name">{name ?? '...'}</output>
          {isFetching && <span className="muted"> (fetching)</span>}
        </div>
        <div>
          PUT /api/items/1: <span data-testid="put-status">{mutation.status}</span>
        </div>
        <button onClick={onRename}>Rename item 1 (optimistic update, PUT takes 2 s)</button>
        {variant === 'focus' && (
          <p className="muted">
            While the PUT is pending, switch to another tab or window and back, or press{' '}
            <button onClick={() => window.dispatchEvent(new Event('focus'))}>Simulate refocus</button> (it dispatches the
            window <code>focus</code> event that <code>setupListeners</code> listens to).
          </p>
        )}
      </section>

      <Summary rows={rows} />
      <Log rows={rows} />
    </main>
  )
}

/** The values item 1 had in the cache since the click, and whether the optimistic one was lost while the PUT was pending. */
function Summary({ rows }: { rows: LogRow[] }) {
  if (!rows.length) return null
  const changes: { t: number; name?: string }[] = []
  for (const r of rows) if (changes.at(-1)?.name !== r.name) changes.push({ t: r.t, name: r.name })
  const patched = rows.find((r) => r.type === 'api/queries/queryResultPatched')
  const settled = rows.find((r) => r.type.startsWith('api/executeMutation/') && !r.type.endsWith('/pending'))
  const lost = patched && rows.find((r) => r.t >= patched.t && (!settled || r.t < settled.t) && r.name !== patched.name)
  return (
    <section>
      <p data-testid="values">
        Values since the click:{' '}
        {changes.map((c, i) => (
          <span key={i}>
            {i > 0 && ' → '}
            {c.name} <span className="muted">(+{c.t} ms)</span>
          </span>
        ))}
      </p>
      {lost && (
        <p className="bad" data-testid="lost">
          The optimistic value "{patched.name}" was replaced by "{lost.name}" at +{lost.t} ms ({lost.type}, requestId{' '}
          {lost.requestId}) while the PUT was still pending.
        </p>
      )}
    </section>
  )
}

function Log({ rows }: { rows: LogRow[] }) {
  return (
    <table>
      <caption>RTK Query actions since the click (item 1's cached name after each)</caption>
      <thead>
        <tr>
          <th>+ms</th>
          <th>action</th>
          <th>endpoint</th>
          <th>requestId</th>
          <th>arg</th>
          <th>status</th>
          <th>item 1 name</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={rows[i - 1] && rows[i - 1].name !== r.name ? 'changed' : undefined}>
            <td>{r.t}</td>
            <td>{r.type}</td>
            <td>{r.endpoint}</td>
            <td>{r.requestId}</td>
            <td>{r.arg}</td>
            <td>{r.status}</td>
            <td>{r.name}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
