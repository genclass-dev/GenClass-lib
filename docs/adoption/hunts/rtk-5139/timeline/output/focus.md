# focus: merged timeline (ms since the click)

Shown values: Values since the click: Original (+1 ms) → Edited 1 (+4 ms) → Original (+347 ms) → Edited 1 (+2045 ms)

Witnesses: overwrote-newer redux.api.queries.getItems(undefined).status

| +ms | source | event | detail |
|---:|---|---|---|
| 0 | GenClass | act click button "Rename item 1 (optimistic update, PUT t…" |  |
| 1 | Redux | api/executeMutation/pending | renameItem, SZPWn9eibDvUPHLzTLTA_, status fulfilled, item 1 = "Original" |
| 1 | GenClass | write redux: redux.api.mutations, redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.endpointName, redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.requestId, redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.startedTimeStamp, redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.status | by no request, user action #0, redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.requestId: undefined → "SZPWn9eibDvUPHLzTLTA_"; redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.status: undefined → "pending"; redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.endpointName: undefined → "renameItem" |
| 4 | Redux | api/queries/queryResultPatched | getItems, status fulfilled, item 1 = "Edited 1" |
| 4 | GenClass | write redux: redux.api.queries.getItems(undefined).data | by no request, user action #0, redux.api.queries.getItems(undefined).data: 2 items, 1 changed: {id: 1, name: "Original" → "Edited 1"} |
| 13 | GenClass | send PUT /api/items/:id#1 | user action #0 |
| 18 | GenClass | write redux: redux.api.subscriptions, redux.api.subscriptions.getItems(undefined).V4vnXd-pL2kCNtPKIzrpm | by no request, redux.api.subscriptions.getItems(undefined).V4vnXd-pL2kCNtPKIzrpm: undefined → {refetchOnFocus: true, +2}; redux.api.subscriptions: {} → undefined |
| 328 | Redux | __rtkq/focused | status fulfilled, item 1 = "Edited 1" |
| 329 | Redux | api/executeQuery/pending | getItems, cRROXVXBVHeHxXFXXdNwp, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 329 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by no request, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "V9Vq4Bo4jgTgHBU_RDmpt" → "cRROXVXBVHeHxXFXXdNwp"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886649759 → 1792886650588 |
| 338 | GenClass | send GET /api/items#2 |  |
| 344 | GenClass | recv GET /api/items#2 |  |
| 347 | Redux | api/executeQuery/fulfilled | getItems, cRROXVXBVHeHxXFXXdNwp, status fulfilled, item 1 = "Original" |
| 348 | GenClass | write redux: redux.api.queries.getItems(undefined).data, redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#2, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).data: 2 items, 1 changed: {id: 1, name: "Edited 1" → "Original"}; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886649786 → 1792886650606 |
| 2019 | GenClass | recv PUT /api/items/:id#1 |  |
| 2021 | Redux | api/executeMutation/fulfilled | renameItem, SZPWn9eibDvUPHLzTLTA_, status fulfilled, item 1 = "Original" |
| 2021 | GenClass | write redux: redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.data, redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.fulfilledTimeStamp, redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.status | by PUT /api/items/:id#1, user action #0, redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.status: "pending" → "fulfilled"; redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.data: undefined → {id: 1, name: "Edited 1"}; redux.api.mutations.SZPWn9eibDvUPHLzTLTA_.fulfilledTimeStamp: undefined → 1792886652279 |
| 2022 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by PUT /api/items/:id#1, user action #0, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "cRROXVXBVHeHxXFXXdNwp" → "-2Is6nFDIlDGnwKzkGsDY"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886650588 → 1792886652281 |
| 2022 | GenClass witness | overwrote-newer redux.api.queries.getItems(undefined).status | by PUT /api/items/:id#1 over request GET /api/items#2, "fulfilled" → "pending" |
| 2023 | Redux | api/executeQuery/pending | getItems, -2Is6nFDIlDGnwKzkGsDY, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 2035 | GenClass | send GET /api/items#3 | user action #0, via PUT /api/items/:id |
| 2041 | GenClass | recv GET /api/items#3 |  |
| 2044 | GenClass | write redux: redux.api.queries.getItems(undefined).data, redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#3, user action #0, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).data: 2 items, 1 changed: {id: 1, name: "Original" → "Edited 1"}; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886650606 → 1792886652302 |
| 2045 | Redux | api/executeQuery/fulfilled | getItems, -2Is6nFDIlDGnwKzkGsDY, status fulfilled, item 1 = "Edited 1" |
