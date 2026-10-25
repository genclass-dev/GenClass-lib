// (b) Debounce 300 ms, no other guard: a request goes out once the user stops typing for 300 ms, and every
// response is written. Fewer requests, but two requests can still be in flight when the user pauses mid-query.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchView, getJson, searchUrl, type SearchData } from "./shared/search-view.js";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function App() {
  const [q, setQ] = useState("");
  const term = useDebounced(q, 300);
  const [data, setData] = useState<SearchData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!term) return;
    setLoading(true);
    getJson<SearchData>(searchUrl(term))
      .then((d) => {
        setData(d);
        setError(false);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [term]);

  return <SearchView q={q} onChange={setQ} data={data} error={error} loading={loading} />;
}

createRoot(document.getElementById("app")!).render(<App />);
