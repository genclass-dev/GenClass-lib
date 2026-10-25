# polling-inflight: merged timeline (ms since the click)

Shown values: Values since the click: Original (+1 ms) → Edited 1 (+4 ms) → Original (+118 ms) → Edited 1 (+2233 ms)

Witnesses: overwrote-newer redux.api.queries.getItems(undefined).data

| +ms | source | event | detail |
|---:|---|---|---|
| -166 | GenClass | recv GET /api/items#4 |  |
| -163 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#4, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886692907 → 1792886693178 |
| -62 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#4, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "qcu-xVYd7K_O3nMQSIISK" → "v5Y1F5ReozGRb49xyckSs"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886693009 → 1792886693280 |
| -47 | GenClass | send GET /api/items#5 | via timer 100ms |
| 0 | GenClass | act click button "Rename item 1 (optimistic update, PUT t…" |  |
| 1 | Redux | api/executeMutation/pending | renameItem, zGzPOdox9QnZ9AkfguyP7, status pending, item 1 = "Original" |
| 2 | GenClass | write redux: redux.api.mutations, redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.endpointName, redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.requestId, redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.startedTimeStamp, redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.status | by no request, user action #0, redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.requestId: undefined → "zGzPOdox9QnZ9AkfguyP7"; redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.status: undefined → "pending"; redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.endpointName: undefined → "renameItem" |
| 4 | Redux | api/queries/queryResultPatched | getItems, status pending, item 1 = "Edited 1" |
| 5 | GenClass | write redux: redux.api.queries.getItems(undefined).data | by no request, user action #0, redux.api.queries.getItems(undefined).data: 2 items, 1 changed: {id: 1, name: "Original" → "Edited 1"} |
| 16 | GenClass | send PUT /api/items/:id#1 | user action #0 |
| 39 | Redux | api/executeQuery/rejected | getItems, 63eXUlMx9BEULFhjqzOSF, condition: skipped, a fetch was in flight, status pending, item 1 = "Edited 1" |
| 114 | GenClass | recv GET /api/items#5 |  |
| 118 | Redux | api/executeQuery/fulfilled | getItems, v5Y1F5ReozGRb49xyckSs, status fulfilled, item 1 = "Original" |
| 118 | GenClass | write redux: redux.api.queries.getItems(undefined).data, redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#5, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).data: 2 items, 1 changed: {id: 1, name: "Edited 1" → "Original"}; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886693178 → 1792886693459 |
| 118 | GenClass witness | overwrote-newer redux.api.queries.getItems(undefined).data | by GET /api/items#5 over user click button "Rename item 1 (optimistic update, PUT t…", 2 items [{id: 1, name: "Edited 1"}, {id: 2, name: "Untouched"}] → 2 items [{id: 1, name: "Original"}, {id: 2, name: "Untouched"}] |
| 220 | Redux | api/executeQuery/pending | getItems, g5M8Yv6IBGSefycI9FagI, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 220 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#5, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "v5Y1F5ReozGRb49xyckSs" → "g5M8Yv6IBGSefycI9FagI"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886693280 → 1792886693562 |
| 226 | GenClass | send GET /api/items#6 | via timer 100ms |
| 321 | Redux | api/executeQuery/rejected | getItems, OR9V5wDfoataRQgNiQGPi, condition: skipped, a fetch was in flight, status pending, item 1 = "Original" |
| 385 | GenClass | recv GET /api/items#6 |  |
| 387 | Redux | api/executeQuery/fulfilled | getItems, g5M8Yv6IBGSefycI9FagI, status fulfilled, item 1 = "Original" |
| 387 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#6, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886693459 → 1792886693729 |
| 488 | Redux | api/executeQuery/pending | getItems, PKisGFX1KsoL1s6CzoOli, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 489 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#6, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "g5M8Yv6IBGSefycI9FagI" → "PKisGFX1KsoL1s6CzoOli"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886693562 → 1792886693831 |
| 497 | GenClass | send GET /api/items#7 | via timer 100ms |
| 589 | Redux | api/executeQuery/rejected | getItems, rYNVcbprXtqUp63EMRb7T, condition: skipped, a fetch was in flight, status pending, item 1 = "Original" |
| 658 | GenClass | recv GET /api/items#7 |  |
| 660 | Redux | api/executeQuery/fulfilled | getItems, PKisGFX1KsoL1s6CzoOli, status fulfilled, item 1 = "Original" |
| 660 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#7, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886693729 → 1792886694002 |
| 762 | Redux | api/executeQuery/pending | getItems, wksQ6N17rKUv_OvYVr_ZH, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 762 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#7, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "PKisGFX1KsoL1s6CzoOli" → "wksQ6N17rKUv_OvYVr_ZH"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886693831 → 1792886694104 |
| 772 | GenClass | send GET /api/items#8 | via timer 100ms |
| 863 | Redux | api/executeQuery/rejected | getItems, 72_iq6ZaK3mjcKZajZ6uh, condition: skipped, a fetch was in flight, status pending, item 1 = "Original" |
| 936 | GenClass | recv GET /api/items#8 |  |
| 937 | Redux | api/executeQuery/fulfilled | getItems, wksQ6N17rKUv_OvYVr_ZH, status fulfilled, item 1 = "Original" |
| 938 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#8, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886694002 → 1792886694279 |
| 1039 | Redux | api/executeQuery/pending | getItems, R199TcX-M93qe_FP-iKBM, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1039 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#8, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "wksQ6N17rKUv_OvYVr_ZH" → "R199TcX-M93qe_FP-iKBM"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886694104 → 1792886694381 |
| 1049 | GenClass | send GET /api/items#9 | via timer 100ms |
| 1140 | Redux | api/executeQuery/rejected | getItems, 5PSmqq4QSwgZKBfQmkJuF, condition: skipped, a fetch was in flight, status pending, item 1 = "Original" |
| 1212 | GenClass | recv GET /api/items#9 |  |
| 1215 | Redux | api/executeQuery/fulfilled | getItems, R199TcX-M93qe_FP-iKBM, status fulfilled, item 1 = "Original" |
| 1215 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#9, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886694279 → 1792886694556 |
| 1317 | Redux | api/executeQuery/pending | getItems, F9u4NkKMu9pP4ZGs-N6xR, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1317 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#9, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "R199TcX-M93qe_FP-iKBM" → "F9u4NkKMu9pP4ZGs-N6xR"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886694381 → 1792886694659 |
| 1335 | GenClass | send GET /api/items#10 | via timer 100ms |
| 1418 | Redux | api/executeQuery/rejected | getItems, cCfRZg5HJq06ZOxsCOur1, condition: skipped, a fetch was in flight, status pending, item 1 = "Original" |
| 1496 | GenClass | recv GET /api/items#10 |  |
| 1498 | Redux | api/executeQuery/fulfilled | getItems, F9u4NkKMu9pP4ZGs-N6xR, status fulfilled, item 1 = "Original" |
| 1498 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#10, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886694556 → 1792886694840 |
| 1600 | Redux | api/executeQuery/pending | getItems, 7G1xVBcpGqHLD1NOwPoEj, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1600 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#10, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "F9u4NkKMu9pP4ZGs-N6xR" → "7G1xVBcpGqHLD1NOwPoEj"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886694659 → 1792886694942 |
| 1619 | GenClass | send GET /api/items#11 | via timer 100ms |
| 1701 | Redux | api/executeQuery/rejected | getItems, 1hqzgDI4CF1zEJ4GQLBcJ, condition: skipped, a fetch was in flight, status pending, item 1 = "Original" |
| 1779 | GenClass | recv GET /api/items#11 |  |
| 1780 | Redux | api/executeQuery/fulfilled | getItems, 7G1xVBcpGqHLD1NOwPoEj, status fulfilled, item 1 = "Original" |
| 1781 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#11, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886694840 → 1792886695122 |
| 1881 | Redux | api/executeQuery/pending | getItems, p9cQMRnqiUdnNiD0vyptV, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1882 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#11, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "7G1xVBcpGqHLD1NOwPoEj" → "p9cQMRnqiUdnNiD0vyptV"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886694942 → 1792886695224 |
| 1897 | GenClass | send GET /api/items#12 | via timer 100ms |
| 1983 | Redux | api/executeQuery/rejected | getItems, 6VvBz1H9d3pfoV687T_3u, condition: skipped, a fetch was in flight, status pending, item 1 = "Original" |
| 2027 | GenClass | recv PUT /api/items/:id#1 |  |
| 2029 | Redux | api/executeMutation/fulfilled | renameItem, zGzPOdox9QnZ9AkfguyP7, status pending, item 1 = "Original" |
| 2029 | GenClass | write redux: redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.data, redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.fulfilledTimeStamp, redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.status | by PUT /api/items/:id#1, user action #0, redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.status: "pending" → "fulfilled"; redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.data: undefined → {id: 1, name: "Edited 1"}; redux.api.mutations.zGzPOdox9QnZ9AkfguyP7.fulfilledTimeStamp: undefined → 1792886695371 |
| 2056 | GenClass | recv GET /api/items#12 |  |
| 2057 | Redux | api/executeQuery/fulfilled | getItems, p9cQMRnqiUdnNiD0vyptV, status fulfilled, item 1 = "Original" |
| 2058 | Redux | api/executeQuery/pending | getItems, 6uuv_lqOiFJVBsWfMoULr, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 2058 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#12, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886695122 → 1792886695400 |
| 2059 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#12, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "p9cQMRnqiUdnNiD0vyptV" → "6uuv_lqOiFJVBsWfMoULr"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886695224 → 1792886695401 |
| 2072 | GenClass | send GET /api/items#12~hedge | via GET /api/items |
| 2159 | Redux | api/executeQuery/rejected | getItems, gnjPeXZKl0C9J5UNOm4qS, condition: skipped, a fetch was in flight, status pending, item 1 = "Original" |
| 2231 | GenClass | recv GET /api/items#12~hedge |  |
| 2233 | Redux | api/executeQuery/fulfilled | getItems, 6uuv_lqOiFJVBsWfMoULr, status fulfilled, item 1 = "Edited 1" |
| 2234 | GenClass | write redux: redux.api.queries.getItems(undefined).data, redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#12~hedge, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).data: 2 items, 1 changed: {id: 1, name: "Original" → "Edited 1"}; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886695400 → 1792886695575 |
| 2335 | Redux | api/executeQuery/pending | getItems, HS1hkJyyHL1N73i_CxCbI, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 2335 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#12~hedge, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "6uuv_lqOiFJVBsWfMoULr" → "HS1hkJyyHL1N73i_CxCbI"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886695401 → 1792886695677 |
| 2351 | GenClass | send GET /api/items#13 | via timer 100ms |
| 2436 | Redux | api/executeQuery/rejected | getItems, UUj-8vnh1CCVgLUYH6nVU, condition: skipped, a fetch was in flight, status pending, item 1 = "Edited 1" |
| 2512 | GenClass | recv GET /api/items#13 |  |
| 2514 | Redux | api/executeQuery/fulfilled | getItems, HS1hkJyyHL1N73i_CxCbI, status fulfilled, item 1 = "Edited 1" |
| 2514 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#13, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886695575 → 1792886695856 |
| 2615 | Redux | api/executeQuery/pending | getItems, i7bmMkBeMMcVscm3eZZGg, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 2616 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#13, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "HS1hkJyyHL1N73i_CxCbI" → "i7bmMkBeMMcVscm3eZZGg"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886695677 → 1792886695958 |
| 2632 | GenClass | send GET /api/items#14 | via timer 100ms |
| 2716 | Redux | api/executeQuery/rejected | getItems, FS20GWXH9EHpMmpjrxXtP, condition: skipped, a fetch was in flight, status pending, item 1 = "Edited 1" |
| 2789 | GenClass | recv GET /api/items#14 |  |
| 2791 | Redux | api/executeQuery/fulfilled | getItems, i7bmMkBeMMcVscm3eZZGg, status fulfilled, item 1 = "Edited 1" |
| 2791 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#14, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886695856 → 1792886696133 |
