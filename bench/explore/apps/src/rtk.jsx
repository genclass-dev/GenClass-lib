// Search page on Redux Toolkit Query (bench/explore/README.md). The user types; every keystroke asks the API through
// RTK Query (keyed by the query, providing a list tag, as RTK's docs show). The correct variant renders the cache entry
// for the current query, which RTK keeps right whatever order the responses arrive in. The planted stale race (?bug)
// is a pattern real apps add on top: a slice that copies every fulfilled search result, so the response that arrives
// last wins. A normal GenClass integration: the script-tag build and connectAgent in the page; nothing here is tuned
// for explore.
import { configureStore, createSlice } from "@reduxjs/toolkit";
import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Provider, useSelector } from "react-redux";

const BUG = new URLSearchParams(location.search).has("bug");

const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Result"],
  endpoints: (b) => ({
    search: b.query({ query: (q) => `search?q=${encodeURIComponent(q)}`, providesTags: [{ type: "Result", id: "LIST" }] }),
  }),
});

// the planted bug: the latest search result to arrive, whichever query it answers
const latest = createSlice({
  name: "latest",
  initialState: { items: [] },
  reducers: {},
  extraReducers: (b) => b.addMatcher(api.endpoints.search.matchFulfilled, (s, a) => void (s.items = a.payload.items)),
});

const store = configureStore({ reducer: { [api.reducerPath]: api.reducer, latest: latest.reducer }, middleware: (g) => g().concat(api.middleware) });

function Search() {
  const [q, setQ] = useState("");
  const { data } = api.useSearchQuery(q, { skip: !q });
  const copied = useSelector((s) => s.latest.items);
  const items = BUG ? copied : (data?.items ?? []);
  return (
    <>
      <input aria-label="Search" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
      <h2 id="for">{items.length ? `Results for ${items[0].split(" ")[0]}` : ""}</h2>
      <ul id="results">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <Provider store={store}>
    <Search />
  </Provider>,
);
