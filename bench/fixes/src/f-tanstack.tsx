// (f) TanStack Query with the term in the query key: each term is its own cache entry, and the component shows the
// entry for the current key, so a late response fills an old entry that is no longer on screen. Library defaults
// (three retries on failure, no placeholder data).

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchView, getJson, searchUrl, type SearchData } from "./shared/search-view.js";

const queryClient = new QueryClient();

function App() {
  const [q, setQ] = useState("");
  const { data, isError, isFetching } = useQuery({
    queryKey: ["search", q],
    queryFn: () => getJson<SearchData>(searchUrl(q)),
    enabled: q.length > 0,
  });
  return <SearchView q={q} onChange={setQ} data={data} error={isError} loading={isFetching} />;
}

createRoot(document.getElementById("app")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
