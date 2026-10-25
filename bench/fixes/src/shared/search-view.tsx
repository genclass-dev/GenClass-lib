// The search page's markup for the React strategies. Every framework renders the same ids: #q (the input),
// #results with data-term (the query the shown results are for, as the API echoes it), #error, and aria-busy on
// #search while the page itself says it is loading.

import type { ReactNode } from "react";

export interface SearchData {
  q: string;
  items: { id: string; name: string; downloads: number }[];
}

/** fetch() that throws on an HTTP error, as most apps write it. */
export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const searchUrl = (q: string): string => `/api/search?q=${encodeURIComponent(q)}`;

export function SearchView(props: { q: string; onChange(q: string): void; data: SearchData | null | undefined; error: boolean; loading: boolean; children?: ReactNode }) {
  const { q, onChange, data, error, loading } = props;
  return (
    <main>
      <h1>Package search</h1>
      <input id="q" value={q} placeholder="Search packages" autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      <section id="search" aria-busy={loading}>
        {error ? (
          <p id="error" role="alert">Search failed. Try again.</p>
        ) : data ? (
          <ul id="results" data-term={data.q}>
            {data.items.map((it) => (
              <li key={it.id}>
                {it.name} <span className="muted">{it.downloads.toLocaleString("en")} downloads</span>
              </li>
            ))}
          </ul>
        ) : null}
        {loading ? <p className="muted">Searching…</p> : null}
      </section>
    </main>
  );
}
