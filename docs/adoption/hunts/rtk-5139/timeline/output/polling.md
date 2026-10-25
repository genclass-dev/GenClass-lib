# polling: merged timeline (ms since the click)

Shown values: Values since the click: Original (+1 ms) → Edited 1 (+4 ms) → Original (+76 ms) → Edited 1 (+2059 ms)

Witnesses: none

| +ms | source | event | detail |
|---:|---|---|---|
| -170 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#3, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "qPMUOprK41WF28q85V8ql" → "fQ6blyYWT59rt8lo1C308"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886605197 → 1792886605312 |
| -162 | GenClass | send GET /api/items#4 | via timer 100ms |
| -156 | GenClass | recv GET /api/items#4 |  |
| -154 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#4, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886605210 → 1792886605327 |
| -53 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#4, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "fQ6blyYWT59rt8lo1C308" → "nAJv5M_PK3mKV5atrFai6"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886605312 → 1792886605429 |
| -45 | GenClass | send GET /api/items#5 | via timer 100ms |
| -41 | GenClass | write redux: redux.api.subscriptions, redux.api.subscriptions.getItems(undefined).J9sgZJl7Fz4R-PkL7woOI | by no request, redux.api.subscriptions.getItems(undefined).J9sgZJl7Fz4R-PkL7woOI: undefined → {pollingInterval: 100, +1}; redux.api.subscriptions: {} → undefined |
| -41 | GenClass | recv GET /api/items#5 |  |
| -38 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#5, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886605327 → 1792886605443 |
| 0 | GenClass | act click button "Rename item 1 (optimistic update, PUT t…" |  |
| 1 | Redux | api/executeMutation/pending | renameItem, fGc0EW3vHOZMUrrwjBXi8, status fulfilled, item 1 = "Original" |
| 1 | GenClass | write redux: redux.api.mutations, redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.endpointName, redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.requestId, redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.startedTimeStamp, redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.status | by no request, user action #0, redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.requestId: undefined → "fGc0EW3vHOZMUrrwjBXi8"; redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.status: undefined → "pending"; redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.endpointName: undefined → "renameItem" |
| 4 | Redux | api/queries/queryResultPatched | getItems, status fulfilled, item 1 = "Edited 1" |
| 4 | GenClass | write redux: redux.api.queries.getItems(undefined).data | by no request, user action #0, redux.api.queries.getItems(undefined).data: 2 items, 1 changed: {id: 1, name: "Original" → "Edited 1"} |
| 16 | GenClass | send PUT /api/items/:id#1 | user action #0 |
| 63 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#5, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "nAJv5M_PK3mKV5atrFai6" → "EtVduLHUZvdEFBzFPdO7b"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886605429 → 1792886605545 |
| 64 | Redux | api/executeQuery/pending | getItems, EtVduLHUZvdEFBzFPdO7b, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 69 | GenClass | send GET /api/items#6 | via timer 100ms |
| 73 | GenClass | recv GET /api/items#6 |  |
| 76 | Redux | api/executeQuery/fulfilled | getItems, EtVduLHUZvdEFBzFPdO7b, status fulfilled, item 1 = "Original" |
| 76 | GenClass | write redux: redux.api.queries.getItems(undefined).data, redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#6, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).data: 2 items, 1 changed: {id: 1, name: "Edited 1" → "Original"}; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886605443 → 1792886605557 |
| 178 | Redux | api/executeQuery/pending | getItems, AFK1wKdTpHISUGXva-jqb, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 178 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#6, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "EtVduLHUZvdEFBzFPdO7b" → "AFK1wKdTpHISUGXva-jqb"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886605545 → 1792886605660 |
| 186 | GenClass | send GET /api/items#7 | via timer 100ms |
| 190 | GenClass | recv GET /api/items#7 |  |
| 191 | Redux | api/executeQuery/fulfilled | getItems, AFK1wKdTpHISUGXva-jqb, status fulfilled, item 1 = "Original" |
| 191 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#7, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886605557 → 1792886605673 |
| 293 | Redux | api/executeQuery/pending | getItems, JJEZaFiEpxr-EgPkwxcGq, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 293 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#7, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "AFK1wKdTpHISUGXva-jqb" → "JJEZaFiEpxr-EgPkwxcGq"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886605660 → 1792886605775 |
| 299 | GenClass | send GET /api/items#8 | via timer 100ms |
| 304 | GenClass | recv GET /api/items#8 |  |
| 306 | Redux | api/executeQuery/fulfilled | getItems, JJEZaFiEpxr-EgPkwxcGq, status fulfilled, item 1 = "Original" |
| 306 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#8, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886605673 → 1792886605788 |
| 408 | Redux | api/executeQuery/pending | getItems, _V1GRpFI9s-m-UdkkZXwz, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 408 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#8, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "JJEZaFiEpxr-EgPkwxcGq" → "_V1GRpFI9s-m-UdkkZXwz"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886605775 → 1792886605889 |
| 422 | GenClass | send GET /api/items#9 | via timer 100ms |
| 427 | GenClass | recv GET /api/items#9 |  |
| 429 | Redux | api/executeQuery/fulfilled | getItems, _V1GRpFI9s-m-UdkkZXwz, status fulfilled, item 1 = "Original" |
| 429 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#9, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886605788 → 1792886605910 |
| 531 | Redux | api/executeQuery/pending | getItems, mI0qnU3Kmbv4PtX4vtsm-, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 531 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#9, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "_V1GRpFI9s-m-UdkkZXwz" → "mI0qnU3Kmbv4PtX4vtsm-"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886605889 → 1792886606013 |
| 546 | GenClass | send GET /api/items#10 | via timer 100ms |
| 550 | GenClass | recv GET /api/items#10 |  |
| 553 | Redux | api/executeQuery/fulfilled | getItems, mI0qnU3Kmbv4PtX4vtsm-, status fulfilled, item 1 = "Original" |
| 553 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#10, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886605910 → 1792886606034 |
| 655 | Redux | api/executeQuery/pending | getItems, vOJgkquBYVdRU-Xrb7JDf, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 655 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#10, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "mI0qnU3Kmbv4PtX4vtsm-" → "vOJgkquBYVdRU-Xrb7JDf"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886606013 → 1792886606136 |
| 666 | GenClass | send GET /api/items#11 | via timer 100ms |
| 671 | GenClass | recv GET /api/items#11 |  |
| 673 | Redux | api/executeQuery/fulfilled | getItems, vOJgkquBYVdRU-Xrb7JDf, status fulfilled, item 1 = "Original" |
| 673 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#11, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886606034 → 1792886606155 |
| 774 | Redux | api/executeQuery/pending | getItems, IuP-0qVlSpTQUgIwRnClR, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 774 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#11, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "vOJgkquBYVdRU-Xrb7JDf" → "IuP-0qVlSpTQUgIwRnClR"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886606136 → 1792886606256 |
| 784 | GenClass | send GET /api/items#12 | via timer 100ms |
| 793 | GenClass | recv GET /api/items#12 |  |
| 795 | Redux | api/executeQuery/fulfilled | getItems, IuP-0qVlSpTQUgIwRnClR, status fulfilled, item 1 = "Original" |
| 795 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#12, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886606155 → 1792886606277 |
| 897 | Redux | api/executeQuery/pending | getItems, JYCxh_1ge2npFjbwiMKxU, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 897 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#12, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "IuP-0qVlSpTQUgIwRnClR" → "JYCxh_1ge2npFjbwiMKxU"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886606256 → 1792886606379 |
| 915 | GenClass | send GET /api/items#13 | via timer 100ms |
| 919 | GenClass | recv GET /api/items#13 |  |
| 922 | Redux | api/executeQuery/fulfilled | getItems, JYCxh_1ge2npFjbwiMKxU, status fulfilled, item 1 = "Original" |
| 922 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#13, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886606277 → 1792886606403 |
| 1023 | Redux | api/executeQuery/pending | getItems, zJKq-E7HtzLKTKg6-bJzz, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1023 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#13, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "JYCxh_1ge2npFjbwiMKxU" → "zJKq-E7HtzLKTKg6-bJzz"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886606379 → 1792886606505 |
| 1033 | GenClass | send GET /api/items#14 | via timer 100ms |
| 1037 | GenClass | recv GET /api/items#14 |  |
| 1040 | Redux | api/executeQuery/fulfilled | getItems, zJKq-E7HtzLKTKg6-bJzz, status fulfilled, item 1 = "Original" |
| 1040 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#14, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886606403 → 1792886606521 |
| 1141 | Redux | api/executeQuery/pending | getItems, mLxOZ-dXRpNKdaC9ijvJt, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1141 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#14, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "zJKq-E7HtzLKTKg6-bJzz" → "mLxOZ-dXRpNKdaC9ijvJt"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886606505 → 1792886606623 |
| 1151 | GenClass | send GET /api/items#15 | via timer 100ms |
| 1156 | GenClass | recv GET /api/items#15 |  |
| 1158 | Redux | api/executeQuery/fulfilled | getItems, mLxOZ-dXRpNKdaC9ijvJt, status fulfilled, item 1 = "Original" |
| 1158 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#15, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886606521 → 1792886606640 |
| 1259 | Redux | api/executeQuery/pending | getItems, LCJOBIVHuv04liQP7rvmJ, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1259 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#15, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "mLxOZ-dXRpNKdaC9ijvJt" → "LCJOBIVHuv04liQP7rvmJ"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886606623 → 1792886606741 |
| 1273 | GenClass | send GET /api/items#16 | via timer 100ms |
| 1276 | GenClass | recv GET /api/items#16 |  |
| 1278 | Redux | api/executeQuery/fulfilled | getItems, LCJOBIVHuv04liQP7rvmJ, status fulfilled, item 1 = "Original" |
| 1278 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#16, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886606640 → 1792886606760 |
| 1380 | Redux | api/executeQuery/pending | getItems, 2PPVVVoQwba2v4saShouL, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1380 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#16, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "LCJOBIVHuv04liQP7rvmJ" → "2PPVVVoQwba2v4saShouL"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886606741 → 1792886606862 |
| 1395 | GenClass | send GET /api/items#17 | via timer 100ms |
| 1399 | GenClass | recv GET /api/items#17 |  |
| 1405 | Redux | api/executeQuery/fulfilled | getItems, 2PPVVVoQwba2v4saShouL, status fulfilled, item 1 = "Original" |
| 1405 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#17, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886606760 → 1792886606886 |
| 1506 | Redux | api/executeQuery/pending | getItems, XhfcUEN0jSLsUdBCQb9ct, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1506 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#17, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "2PPVVVoQwba2v4saShouL" → "XhfcUEN0jSLsUdBCQb9ct"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886606862 → 1792886606988 |
| 1522 | GenClass | send GET /api/items#18 | via timer 100ms |
| 1526 | GenClass | recv GET /api/items#18 |  |
| 1528 | Redux | api/executeQuery/fulfilled | getItems, XhfcUEN0jSLsUdBCQb9ct, status fulfilled, item 1 = "Original" |
| 1528 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#18, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886606886 → 1792886607010 |
| 1629 | Redux | api/executeQuery/pending | getItems, bVKNCMktHxf4cH1ARbdPF, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1629 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#18, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "XhfcUEN0jSLsUdBCQb9ct" → "bVKNCMktHxf4cH1ARbdPF"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886606988 → 1792886607111 |
| 1643 | GenClass | send GET /api/items#19 | via timer 100ms |
| 1648 | GenClass | recv GET /api/items#19 |  |
| 1650 | Redux | api/executeQuery/fulfilled | getItems, bVKNCMktHxf4cH1ARbdPF, status fulfilled, item 1 = "Original" |
| 1651 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#19, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886607010 → 1792886607132 |
| 1752 | Redux | api/executeQuery/pending | getItems, m51Py8845AlxCADJF9SsN, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1752 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#19, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "bVKNCMktHxf4cH1ARbdPF" → "m51Py8845AlxCADJF9SsN"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886607111 → 1792886607234 |
| 1766 | GenClass | send GET /api/items#20 | via timer 100ms |
| 1773 | GenClass | recv GET /api/items#20 |  |
| 1776 | Redux | api/executeQuery/fulfilled | getItems, m51Py8845AlxCADJF9SsN, status fulfilled, item 1 = "Original" |
| 1776 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#20, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886607132 → 1792886607257 |
| 1877 | Redux | api/executeQuery/pending | getItems, C7j-uMqsLDe0LgsV_8r7O, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 1877 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#20, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "m51Py8845AlxCADJF9SsN" → "C7j-uMqsLDe0LgsV_8r7O"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886607234 → 1792886607359 |
| 1902 | GenClass | send GET /api/items#21 | via timer 100ms |
| 1908 | GenClass | recv GET /api/items#21 |  |
| 1910 | Redux | api/executeQuery/fulfilled | getItems, C7j-uMqsLDe0LgsV_8r7O, status fulfilled, item 1 = "Original" |
| 1910 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#21, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886607257 → 1792886607391 |
| 2012 | Redux | api/executeQuery/pending | getItems, eGrY7SxgWV2pPwTu-VqBH, forceRefetch=true subscribe=false, status pending, item 1 = "Original" |
| 2012 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#21, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "C7j-uMqsLDe0LgsV_8r7O" → "eGrY7SxgWV2pPwTu-VqBH"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886607359 → 1792886607493 |
| 2032 | GenClass | send GET /api/items#22 | via timer 100ms |
| 2036 | GenClass | recv PUT /api/items/:id#1 |  |
| 2036 | GenClass | recv GET /api/items#22 |  |
| 2038 | Redux | api/executeMutation/fulfilled | renameItem, fGc0EW3vHOZMUrrwjBXi8, status pending, item 1 = "Original" |
| 2038 | GenClass | write redux: redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.data, redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.fulfilledTimeStamp, redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.status | by PUT /api/items/:id#1, user action #0, redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.status: "pending" → "fulfilled"; redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.data: undefined → {id: 1, name: "Edited 1"}; redux.api.mutations.fGc0EW3vHOZMUrrwjBXi8.fulfilledTimeStamp: undefined → 1792886607520 |
| 2059 | Redux | api/executeQuery/fulfilled | getItems, eGrY7SxgWV2pPwTu-VqBH, status fulfilled, item 1 = "Edited 1" |
| 2059 | GenClass | write redux: redux.api.queries.getItems(undefined).data, redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#22, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).data: 2 items, 1 changed: {id: 1, name: "Original" → "Edited 1"}; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886607391 → 1792886607541 |
| 2060 | Redux | api/executeQuery/pending | getItems, Mblo8KEu7CbvKRpj72e9t, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 2060 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#22, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "eGrY7SxgWV2pPwTu-VqBH" → "Mblo8KEu7CbvKRpj72e9t"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886607493 → 1792886607542 |
| 2079 | GenClass | send GET /api/items#22~hedge | via GET /api/items |
| 2085 | GenClass | recv GET /api/items#22~hedge |  |
| 2086 | Redux | api/executeQuery/fulfilled | getItems, Mblo8KEu7CbvKRpj72e9t, status fulfilled, item 1 = "Edited 1" |
| 2086 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#22~hedge, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886607541 → 1792886607568 |
| 2188 | Redux | api/executeQuery/pending | getItems, ueugLx4Z16J-2R_Vnh33C, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 2188 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#22~hedge, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "Mblo8KEu7CbvKRpj72e9t" → "ueugLx4Z16J-2R_Vnh33C"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886607542 → 1792886607669 |
| 2206 | GenClass | send GET /api/items#23 | via timer 100ms |
| 2210 | GenClass | recv GET /api/items#23 |  |
| 2212 | Redux | api/executeQuery/fulfilled | getItems, ueugLx4Z16J-2R_Vnh33C, status fulfilled, item 1 = "Edited 1" |
| 2212 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#23, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886607568 → 1792886607694 |
| 2313 | Redux | api/executeQuery/pending | getItems, 8jAysb_hfNj-eML5LR-sB, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 2313 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#23, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "ueugLx4Z16J-2R_Vnh33C" → "8jAysb_hfNj-eML5LR-sB"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886607669 → 1792886607795 |
| 2332 | GenClass | send GET /api/items#24 | via timer 100ms |
| 2337 | GenClass | recv GET /api/items#24 |  |
| 2339 | Redux | api/executeQuery/fulfilled | getItems, 8jAysb_hfNj-eML5LR-sB, status fulfilled, item 1 = "Edited 1" |
| 2339 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#24, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886607694 → 1792886607821 |
| 2440 | Redux | api/executeQuery/pending | getItems, 6eCCNj9ooUtLqjPchq6sH, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 2440 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#24, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "8jAysb_hfNj-eML5LR-sB" → "6eCCNj9ooUtLqjPchq6sH"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886607795 → 1792886607922 |
| 2445 | GenClass | send GET /api/items#25 | via timer 100ms |
| 2451 | GenClass | recv GET /api/items#25 |  |
| 2453 | Redux | api/executeQuery/fulfilled | getItems, 6eCCNj9ooUtLqjPchq6sH, status fulfilled, item 1 = "Edited 1" |
| 2453 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#25, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886607821 → 1792886607935 |
| 2555 | Redux | api/executeQuery/pending | getItems, 2YV0q7TdcdSEdsDjRrmwk, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 2555 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#25, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "6eCCNj9ooUtLqjPchq6sH" → "2YV0q7TdcdSEdsDjRrmwk"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886607922 → 1792886608036 |
| 2589 | GenClass | send GET /api/items#26 | via timer 100ms |
| 2595 | GenClass | recv GET /api/items#26 |  |
| 2597 | Redux | api/executeQuery/fulfilled | getItems, 2YV0q7TdcdSEdsDjRrmwk, status fulfilled, item 1 = "Edited 1" |
| 2597 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#26, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886607935 → 1792886608079 |
| 2699 | Redux | api/executeQuery/pending | getItems, O3crI4ZnLWx2631lRVeZ8, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 2699 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#26, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "2YV0q7TdcdSEdsDjRrmwk" → "O3crI4ZnLWx2631lRVeZ8"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886608036 → 1792886608181 |
| 2742 | GenClass | send GET /api/items#27 | via timer 100ms |
| 2748 | GenClass | recv GET /api/items#27 |  |
| 2751 | Redux | api/executeQuery/fulfilled | getItems, O3crI4ZnLWx2631lRVeZ8, status fulfilled, item 1 = "Edited 1" |
| 2751 | GenClass | write redux: redux.api.queries.getItems(undefined).fulfilledTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#27, redux.api.queries.getItems(undefined).status: "pending" → "fulfilled"; redux.api.queries.getItems(undefined).fulfilledTimeStamp: 1792886608079 → 1792886608232 |
| 2852 | Redux | api/executeQuery/pending | getItems, 3ggYo-OAuORHzKmYUEh-2, forceRefetch=true subscribe=false, status pending, item 1 = "Edited 1" |
| 2852 | GenClass | write redux: redux.api.queries.getItems(undefined).requestId, redux.api.queries.getItems(undefined).startedTimeStamp, redux.api.queries.getItems(undefined).status | by GET /api/items#27, redux.api.queries.getItems(undefined).status: "fulfilled" → "pending"; redux.api.queries.getItems(undefined).requestId: "O3crI4ZnLWx2631lRVeZ8" → "3ggYo-OAuORHzKmYUEh-2"; redux.api.queries.getItems(undefined).startedTimeStamp: 1792886608181 → 1792886608334 |
| 2880 | GenClass | send GET /api/items#28 | via timer 100ms |
