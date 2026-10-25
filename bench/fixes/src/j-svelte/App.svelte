<!-- (j) Svelte 5: an $effect that reads the term, fetches with an AbortController and aborts in its teardown, so
     the previous request never reaches the component once the term changes. -->
<script>
  let q = $state("");
  let data = $state(null);
  let error = $state(false);
  let loading = $state(false);

  $effect(() => {
    const term = q;
    if (!term) return;
    const controller = new AbortController();
    loading = true;
    fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        data = d;
        error = false;
        loading = false;
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        error = true;
        loading = false;
      });
    return () => controller.abort();
  });
</script>

<main>
  <h1>Package search</h1>
  <input id="q" bind:value={q} placeholder="Search packages" autocomplete="off" />
  <section id="search" aria-busy={loading}>
    {#if error}
      <p id="error" role="alert">Search failed. Try again.</p>
    {:else if data}
      <ul id="results" data-term={data.q}>
        {#each data.items as it (it.id)}
          <li>{it.name} <span class="muted">{it.downloads.toLocaleString("en")} downloads</span></li>
        {/each}
      </ul>
    {/if}
    {#if loading}
      <p class="muted">Searching…</p>
    {/if}
  </section>
</main>
