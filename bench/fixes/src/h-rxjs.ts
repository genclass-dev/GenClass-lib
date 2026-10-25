// (h) RxJS switchMap: each new query unsubscribes from the previous request (fromFetch aborts it), so only the
// latest query's response reaches the view. No framework: RxJS renders into the DOM.

import { catchError, filter, fromEvent, map, of, switchMap, tap } from "rxjs";
import { fromFetch } from "rxjs/fetch";

interface SearchData {
  q: string;
  items: { id: string; name: string; downloads: number }[];
}

const app = document.getElementById("app")!;
app.innerHTML = `<main>
  <h1>Package search</h1>
  <input id="q" placeholder="Search packages" autocomplete="off">
  <section id="search" aria-busy="false"></section>
</main>`;
const input = app.querySelector<HTMLInputElement>("#q")!;
const section = app.querySelector<HTMLElement>("#search")!;

function render(result: SearchData | { error: true }): void {
  section.setAttribute("aria-busy", "false");
  section.textContent = "";
  if ("error" in result) {
    const p = document.createElement("p");
    p.id = "error";
    p.setAttribute("role", "alert");
    p.textContent = "Search failed. Try again.";
    section.append(p);
    return;
  }
  const ul = document.createElement("ul");
  ul.id = "results";
  ul.dataset.term = result.q;
  for (const it of result.items) {
    const li = document.createElement("li");
    li.textContent = `${it.name} `;
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = `${it.downloads.toLocaleString("en")} downloads`;
    li.append(span);
    ul.append(li);
  }
  section.append(ul);
}

fromEvent(input, "input")
  .pipe(
    map(() => input.value),
    filter((q) => q.length > 0),
    tap(() => section.setAttribute("aria-busy", "true")),
    switchMap((q) =>
      fromFetch(`/api/search?q=${encodeURIComponent(q)}`, {
        selector: (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<SearchData>;
        },
      }).pipe(catchError(() => of({ error: true as const }))),
    ),
  )
  .subscribe(render);
