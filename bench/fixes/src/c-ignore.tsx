// (c) The ignore flag from react.dev: the effect's cleanup marks the previous request as ignored, so only the
// response for the current term is written. Every request still completes.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchView, getJson, searchUrl, type SearchData } from "./shared/search-view.js";

function App() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<SearchData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!q) return;
    let ignore = false;
    setLoading(true);
    getJson<SearchData>(searchUrl(q))
      .then((d) => {
        if (ignore) return;
        setData(d);
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (ignore) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [q]);

  return <SearchView q={q} onChange={setQ} data={data} error={error} loading={loading} />;
}

createRoot(document.getElementById("app")!).render(<App />);
