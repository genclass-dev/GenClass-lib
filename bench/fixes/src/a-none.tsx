// (a) No guard: every keystroke fetches and every response is written. Whichever response arrives last wins.

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
    setLoading(true);
    getJson<SearchData>(searchUrl(q))
      .then((d) => {
        setData(d);
        setError(false);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [q]);

  return <SearchView q={q} onChange={setQ} data={data} error={error} loading={loading} />;
}

createRoot(document.getElementById("app")!).render(<App />);
