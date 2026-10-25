// (g) SWR with the term in the key: the hook returns the data for the current key only. Library defaults (error
// retry with back-off, no keepPreviousData).

import { useState } from "react";
import { createRoot } from "react-dom/client";
import useSWR from "swr";
import { SearchView, getJson, searchUrl, type SearchData } from "./shared/search-view.js";

const fetcher = (url: string) => getJson<SearchData>(url);

function App() {
  const [q, setQ] = useState("");
  const { data, error, isLoading } = useSWR(q ? searchUrl(q) : null, fetcher);
  return <SearchView q={q} onChange={setQ} data={data} error={Boolean(error)} loading={isLoading} />;
}

createRoot(document.getElementById("app")!).render(<App />);
