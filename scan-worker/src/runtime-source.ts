// The @genclass/runtime script-tag build that the race probe injects. Fetched from jsDelivr (unpkg as a fallback),
// pinned to one version and to its sha256, so the scanner never injects code it has not seen. Cached in the isolate
// and in the edge cache.

/** sha256 of dist/genclass.global.min.js per published version (from the npm tarball's file). */
export const RUNTIME_SHA256: Record<string, string> = {
  "0.2.1": "1eec30fbf9fac551390fbb947b3b50f6b34af167fc7e12a53329593b86f51209",
  "0.2.2": "0096ad0bbc15a9d288be3b7ebbc4e2c3b391f10aee0d4fbf2dd2e21a5a25516b",
  "0.3.0-beta.0": "8595f916dda9782c941c716837ba29ce9d0ecbb587a536d69c6dc0217c6d3ea1",
};

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function sha256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function runtimeSourceLoader(version: string, fetcher: Fetch, cache?: Cache | null): () => Promise<string | null> {
  let memo: Promise<string | null> | null = null;
  const want = RUNTIME_SHA256[version];
  const urls = [
    `https://cdn.jsdelivr.net/npm/@genclass/runtime@${version}/dist/genclass.global.min.js`,
    `https://unpkg.com/@genclass/runtime@${version}/dist/genclass.global.min.js`,
  ];
  const edge = (): Cache | null => {
    if (cache !== undefined) return cache;
    try {
      return (globalThis as unknown as { caches?: { default: Cache } }).caches?.default ?? null;
    } catch {
      return null;
    }
  };
  const load = async (): Promise<string | null> => {
    if (!want) return null;
    const c = edge();
    for (const u of urls) {
      try {
        const hit = c ? await c.match(u) : undefined;
        const res = hit ?? (await fetcher(u, { signal: AbortSignal.timeout(5000) }));
        if (!res.ok) continue;
        const text = await res.text();
        if ((await sha256(text)) !== want) continue;
        if (c && !hit) await c.put(u, new Response(text, { headers: { "content-type": "text/javascript", "cache-control": "public, max-age=86400" } })).catch(() => undefined);
        return text;
      } catch {
        /* try the next mirror */
      }
    }
    return null;
  };
  return () => {
    if (!memo) {
      memo = load().then((s) => {
        if (!s) memo = null; // retry on the next scan
        return s;
      });
    }
    return memo;
  };
}
