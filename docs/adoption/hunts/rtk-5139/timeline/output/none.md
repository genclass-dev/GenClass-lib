# none: merged timeline (ms since the click)

Shown values: Values since the click: Original (+1 ms) → Edited 1 (+3 ms)

Witnesses: none

| +ms | source | event | detail |
|---:|---|---|---|
| -10 | GenClass | write redux: redux.api.subscriptions, redux.api.subscriptions.getItems(undefined).P-v-Ujp6lsfHarXlGxXml | by no request, redux.api.subscriptions.getItems(undefined).P-v-Ujp6lsfHarXlGxXml: undefined → {pollingInterval: 0, +1}; redux.api.subscriptions: {} → undefined |
| 0 | GenClass | act click button "Rename item 1 (optimistic update, PUT t…" |  |
| 1 | Redux | api/executeMutation/pending | renameItem, 0FbpW_zSvgDJr9zIKaAht, status fulfilled, item 1 = "Original" |
| 2 | GenClass | write redux: redux.api.mutations, redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.endpointName, redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.requestId, redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.startedTimeStamp, redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.status | by no request, user action #0, redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.requestId: undefined → "0FbpW_zSvgDJr9zIKaAht"; redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.status: undefined → "pending"; redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.endpointName: undefined → "renameItem" |
| 3 | Redux | api/queries/queryResultPatched | getItems, status fulfilled, item 1 = "Edited 1" |
| 4 | GenClass | write redux: redux.api.queries.getItems(undefined).data | by no request, user action #0, redux.api.queries.getItems(undefined).data: 2 items, 1 changed: {id: 1, name: "Original" → "Edited 1"} |
| 13 | GenClass | send PUT /api/items/:id#1 | user action #0 |
| 2019 | GenClass | recv PUT /api/items/:id#1 |  |
| 2021 | Redux | api/executeMutation/fulfilled | renameItem, 0FbpW_zSvgDJr9zIKaAht, status fulfilled, item 1 = "Edited 1" |
| 2021 | GenClass | write redux: redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.data, redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.fulfilledTimeStamp, redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.status | by PUT /api/items/:id#1, user action #0, redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.status: "pending" → "fulfilled"; redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.data: undefined → {id: 1, name: "Edited 1"}; redux.api.mutations.0FbpW_zSvgDJr9zIKaAht.fulfilledTimeStamp: undefined → 1792886745497 |
| 2023 | Redux | api/executeQuery/pending | getItems, XjPbe7_pvGmoVFbXCj-7U, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 2023 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by PUT /api/items/:id#1, user action #0, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "EFxj_2fMjqDlwMceLWSF-" → "XjPbe7_pvGmoVFbXCj-7U"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886742965 → 1792886745500 |
| 2035 | GenClass | send GET /api/items#2 | user action #0, via PUT /api/items/:id |
| 2041 | GenClass | recv GET /api/items#2 |  |
| 2045 | Redux | api/executeQuery/fulfilled | getItems, XjPbe7_pvGmoVFbXCj-7U, status fulfilled, item 1 = "Edited 1" |
| 2046 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#2, user action #0, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886743001 → 1792886745520 |
