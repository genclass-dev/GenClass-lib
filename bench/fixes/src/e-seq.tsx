// (e) Request id: each request takes the next number from a counter; a response is written only if its number is
// still the latest.

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchView, getJson, searchUrl, type SearchData } from "./shared/search-view.js";

function App() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<SearchData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (!q) return;
    const id = ++latest.current;
    setLoading(true);
    getJson<SearchData>(searchUrl(q))
      .then((d) => {
        if (id !== latest.current) return;
        setData(d);
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (id !== latest.current) return;
        setError(true);
        setLoading(false);
      });
  }, [q]);

  return <SearchView q={q} onChange={setQ} data={data} error={error} loading={loading} />;
}

createRoot(document.getElementById("app")!).render(<App />);
