// Redux-only tests (no React, no DOM) for reduxjs/redux-toolkit#5139, in the shape of
// packages/toolkit/src/query/tests/optimisticUpdates.test.tsx: the same `post` / `updatePost` endpoints, the same
// `baseQuery` mock and a `storeRef` like that file's `setupApiStore(api, { ...actionsReducer })`. The tests in the
// last `describe` use `api`, `baseQuery`, `storeRef`, `vi` and `setupListeners`, so they can be pasted into that file
// once it also has `import { setupListeners } from '@reduxjs/toolkit/query'`.
//
// They assert what the reporter expects and the docs' stated purpose of an optimistic update: while the mutation is
// in flight, the cache keeps the optimistic value, even when a polling or refetch-on-focus fetch of the same entry
// fulfills meanwhile. On @reduxjs/toolkit 2.13.0 the control passes and the polling and focus tests fail: that
// fetch's fulfilled write replaces the patch.

import { configureStore, type UnknownAction } from '@reduxjs/toolkit'
import { createApi, setupListeners } from '@reduxjs/toolkit/query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface Post {
  id: string
  title: string
  contents: string
}

// ---------------------------------------------------------------- as in optimisticUpdates.test.tsx

const baseQuery = vi.fn()
beforeEach(() => {
  baseQuery.mockReset()
})

const api = createApi({
  baseQuery: (...args: any[]) => {
    const result = baseQuery(...args)
    if (typeof result === 'object' && 'then' in result)
      return result
        .then((data: any) => ({ data, meta: 'meta' }))
        .catch((e: any) => ({ error: e }))
    return { data: result, meta: 'meta' }
  },
  tagTypes: ['Post'],
  endpoints: (build) => ({
    post: build.query<Post, string>({
      query: (id) => `post/${id}`,
      providesTags: ['Post'],
    }),
    updatePost: build.mutation<void, Pick<Post, 'id'> & Partial<Post>>({
      query: ({ id, ...patch }) => ({
        url: `post/${id}`,
        method: 'PATCH',
        body: patch,
      }),
      async onQueryStarted({ id, ...patch }, { dispatch, queryFulfilled }) {
        const { undo } = dispatch(
          api.util.updateQueryData('post', id, (draft) => {
            Object.assign(draft, patch)
          }),
        )
        queryFulfilled.catch(undo)
      },
      invalidatesTags: (result) => (result ? ['Post'] : []),
    }),
  }),
})

// setupApiStore(api, { ...actionsReducer }) from src/tests/utils/helpers.tsx, reduced to what these tests use
const actionsReducer = {
  actions: (state: UnknownAction[] = [], action: UnknownAction) =>
    action.type.includes('subscriptionsUpdated') ? state : [...state, action],
}
const getStore = () =>
  configureStore({
    reducer: { api: api.reducer, ...actionsReducer },
    middleware: (gdm) => gdm({ serializableCheck: false, immutableCheck: false }).concat(api.middleware),
    enhancers: (gde) => gde({ autoBatch: false }),
  })
const storeRef = { store: getStore() }
beforeEach(() => {
  storeRef.store = getStore()
})
afterEach(() => {
  storeRef.store.dispatch(api.util.resetApiState()) // also clears the polling timers
})

// ---------------------------------------------------------------- new

describe('updateQueryData while the mutation is pending (#5139)', () => {
  /** The server: GET post/3 answers at once with the current post; the PATCH waits until `release()`. */
  function server() {
    let post: Post = { id: '3', title: 'All about cheese.', contents: 'TODO' }
    let releasePatch: (() => void) | undefined
    baseQuery.mockImplementation((arg: string | { body: Partial<Post> }) => {
      if (typeof arg === 'string') return { ...post }
      return new Promise<Post>((resolve) => {
        releasePatch = () => {
          post = { ...post, ...arg.body }
          resolve({ ...post })
        }
      })
    })
    return { release: () => releasePatch?.() }
  }
  const selectPost = () => api.endpoints.post.select('3')(storeRef.store.getState() as any)
  /** The actions since `from` (an index into state.actions), with the cached contents after the run. */
  const sequence = (from: number) =>
    (storeRef.store.getState() as any).actions
      .slice(from)
      .map((a: { type: string }) => a.type)
      .join(', ') + ` | contents now: ${JSON.stringify(selectPost().data?.contents)}`
  /** Waits until a fetch other than `requestId` has fulfilled for post 3. */
  const laterFetchFulfilled = (requestId: string | undefined) =>
    vi.waitFor(() => {
      expect(selectPost().requestId).not.toBe(requestId)
      expect(selectPost().status).toBe('fulfilled')
    })

  test('(control) with no fetch in between, the optimistic update stays until the mutation settles', async () => {
    const srv = server()
    const sub = storeRef.store.dispatch(api.endpoints.post.initiate('3'))
    await sub

    const mutation = storeRef.store.dispatch(api.endpoints.updatePost.initiate({ id: '3', contents: 'I love cheese!' }))
    expect(selectPost().data?.contents).toBe('I love cheese!')
    await new Promise((r) => setTimeout(r, 50))
    expect(selectPost().data?.contents).toBe('I love cheese!')

    srv.release()
    await mutation
    await vi.waitFor(() => expect(selectPost().data?.contents).toBe('I love cheese!'))
    sub.unsubscribe()
  })

  test('a polling refetch that fulfills while the mutation is pending keeps the optimistic update', async () => {
    const srv = server()
    const sub = storeRef.store.dispatch(
      api.endpoints.post.initiate('3', { subscriptionOptions: { pollingInterval: 10 } }),
    )
    await sub
    expect(selectPost().data?.contents).toBe('TODO')

    const from = (storeRef.store.getState() as any).actions.length
    const mutation = storeRef.store.dispatch(api.endpoints.updatePost.initiate({ id: '3', contents: 'I love cheese!' }))
    // the optimistic update, at once
    expect(selectPost().data?.contents).toBe('I love cheese!')
    const { requestId } = selectPost()

    // the next poll (startNextPoll -> refetchQuery -> initiate(arg, { subscribe: false, forceRefetch: true }))
    // fetches and fulfills while the PATCH is still pending
    await laterFetchFulfilled(requestId)
    expect(selectPost().data?.contents, sequence(from)).toBe('I love cheese!') // 2.13.0: 'TODO'

    srv.release()
    await mutation
    await vi.waitFor(() => expect(selectPost().data?.contents).toBe('I love cheese!'))
    sub.unsubscribe()
  })

  test('a refetchOnFocus refetch that fulfills while the mutation is pending keeps the optimistic update', async () => {
    const srv = server()
    let refocus = () => {}
    const unlisten = setupListeners(storeRef.store.dispatch, (dispatch, { onFocus }) => {
      refocus = () => dispatch(onFocus())
      return () => {}
    })
    const sub = storeRef.store.dispatch(
      api.endpoints.post.initiate('3', { subscriptionOptions: { refetchOnFocus: true } }),
    )
    await sub

    const from = (storeRef.store.getState() as any).actions.length
    const mutation = storeRef.store.dispatch(api.endpoints.updatePost.initiate({ id: '3', contents: 'I love cheese!' }))
    expect(selectPost().data?.contents).toBe('I love cheese!')
    const { requestId } = selectPost()

    // the window gets focus back while the PATCH is pending (refetchValidQueries -> refetchQuery)
    refocus()
    await laterFetchFulfilled(requestId)
    expect(selectPost().data?.contents, sequence(from)).toBe('I love cheese!') // 2.13.0: 'TODO'

    srv.release()
    await mutation
    await vi.waitFor(() => expect(selectPost().data?.contents).toBe('I love cheese!'))
    sub.unsubscribe()
    unlisten()
  })
})
