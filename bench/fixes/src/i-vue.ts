// (i) Vue watch with onCleanup: the watcher's cleanup marks the previous run as cancelled before the next one starts,
// so only the response for the current term is written.

import { createApp, defineComponent, ref, watch } from "vue";

interface SearchData {
  q: string;
  items: { id: string; name: string; downloads: number }[];
}

const App = defineComponent({
  setup() {
    const q = ref("");
    const data = ref<SearchData | null>(null);
    const error = ref(false);
    const loading = ref(false);

    watch(q, async (term, _previous, onCleanup) => {
      if (!term) return;
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      loading.value = true;
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as SearchData;
        if (cancelled) return;
        data.value = d;
        error.value = false;
        loading.value = false;
      } catch {
        if (cancelled) return;
        error.value = true;
        loading.value = false;
      }
    });

    return { q, data, error, loading };
  },
  template: `<main>
  <h1>Package search</h1>
  <input id="q" v-model="q" placeholder="Search packages" autocomplete="off">
  <section id="search" :aria-busy="loading">
    <p v-if="error" id="error" role="alert">Search failed. Try again.</p>
    <ul v-else-if="data" id="results" :data-term="data.q">
      <li v-for="it in data.items" :key="it.id">{{ it.name }} <span class="muted">{{ it.downloads.toLocaleString("en") }} downloads</span></li>
    </ul>
    <p v-if="loading" class="muted">Searching…</p>
  </section>
</main>`,
});

createApp(App).mount("#app");
