import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'

export interface Item {
  id: number
  name: string
}

export const api = createApi({
  baseQuery: fetchBaseQuery({ baseUrl: '/api/' }),
  tagTypes: ['Item'],
  endpoints: (build) => ({
    // GET /api/items answers at once.
    getItems: build.query<Item[], void>({
      query: () => 'items',
      providesTags: (result = []) => [
        ...result.map(({ id }) => ({ type: 'Item' as const, id })),
        { type: 'Item' as const, id: 'LIST' },
      ],
    }),
    // PUT /api/items/:id takes about 2000 ms. The optimistic update is the documented recipe
    // (docs/rtk-query/usage/manual-cache-updates.mdx, "Optimistic Updates").
    renameItem: build.mutation<Item, Pick<Item, 'id' | 'name'>>({
      query: ({ id, name }) => ({ url: `items/${id}`, method: 'PUT', body: { name } }),
      async onQueryStarted({ id, name }, { dispatch, queryFulfilled }) {
        const patchResult = dispatch(
          api.util.updateQueryData('getItems', undefined, (draft) => {
            const item = draft.find((i) => i.id === id)
            if (item) item.name = name
          }),
        )
        try {
          await queryFulfilled
        } catch {
          patchResult.undo()
        }
      },
      invalidatesTags: (_result, _error, { id }) => [{ type: 'Item', id }],
    }),
  }),
})

export const { useGetItemsQuery, useRenameItemMutation } = api
