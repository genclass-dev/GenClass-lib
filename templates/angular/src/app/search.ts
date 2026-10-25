// A search box written the way a lot of code is: every keystroke subscribes, and whichever answer arrives last wins
// (no switchMap). The API (src/server.ts) answers in a random 50-900 ms, so type quickly and an older answer can
// overwrite a newer one. GenClass watches this with no code here: open the overlay (bottom right, development only)
// to see what it finds.
import { HttpClient } from "@angular/common/http";
import { Component, inject, signal } from "@angular/core";

@Component({
  selector: "app-search",
  template: `
    <main style="font-family: system-ui, sans-serif; max-width: 520px; margin: 48px auto; padding: 0 16px">
      <h1>GenClass + Angular</h1>
      <p>Type a city quickly, for example “san”, then look at the GenClass overlay.</p>
      <input [value]="q()" (input)="search($any($event.target).value)" placeholder="Search cities" autofocus style="width: 100%; padding: 8px; font-size: 16px" />
      <ul>
        @for (r of results(); track r) {
          <li>{{ r }}</li>
        }
      </ul>
    </main>
  `,
})
export class Search {
  private http = inject(HttpClient);
  q = signal("");
  results = signal<string[]>([]);

  search(v: string) {
    this.q.set(v);
    if (!v) return this.results.set([]);
    this.http.get<{ results: string[] }>("/api/search", { params: { q: v } }).subscribe((r) => this.results.set(r.results));
  }
}
