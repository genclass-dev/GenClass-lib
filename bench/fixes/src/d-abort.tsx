// (d) AbortController: the effect's cleanup aborts the previous request, so its response never reaches the app.

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
    const controller = new AbortController();
    setLoading(true);
    getJson<SearchData>(searchUrl(q), { signal: controller.signal })
      .then((d) => {
        setData(d);
        setError(false);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [q]);

  return <SearchView q={q} onChange={setQ} data={data} error={error} loading={loading} />;
}

createRoot(document.getElementById("app")!).render(<App />);
