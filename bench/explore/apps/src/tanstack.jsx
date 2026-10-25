// Search page on TanStack Query (bench/explore/README.md). The user types; every keystroke asks the API. The correct
// variant is useQuery keyed by the query (with keepPreviousData, as TanStack's docs show for search): the page renders
// the current key's data whatever order the responses arrive in. The planted stale race (?bug) is a pattern real apps
// write instead: an effect that fetches through the query client and puts each answer into component state when it
// arrives, so the response that arrives last wins. A normal GenClass integration: the script-tag build and
// connectAgent in the page; nothing here is tuned for explore.
import { QueryClient, QueryClientProvider, keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const BUG = new URLSearchParams(location.search).has("bug");
const search = (q) => fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());

function Search() {
  const [q, setQ] = useState("");
  const { data } = useQuery({ queryKey: ["search", q], queryFn: () => search(q), enabled: !!q && !BUG, placeholderData: keepPreviousData });
  const client = useQueryClient();
  const [last, setLast] = useState([]);
  useEffect(() => {
    if (!BUG || !q) return;
    // the planted bug: no cancellation, no check that this answer is still for the current query
    void client.fetchQuery({ queryKey: ["search", q], queryFn: () => search(q) }).then((d) => setLast(d.items));
  }, [q, client]);
  const items = BUG ? last : (data?.items ?? []);
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
  <QueryClientProvider client={new QueryClient()}>
    <Search />
  </QueryClientProvider>,
);
