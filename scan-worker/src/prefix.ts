// The scan bucket under a key prefix, for a test copy of the scanner (wrangler env "test", STORE_PREFIX "scan-test/"):
// its reports, screenshots and concurrency leases live under the prefix, so they never mix with the production copy's.
// The owners' opt-out list, scans/blocklist.json, is read from its real key: an opt-out applies to every copy.

import type { Bucket } from "./store.ts";

export const BLOCKLIST_KEY = "scans/blocklist.json";

export function prefixed(bucket: Bucket, prefix: string): Bucket {
  if (!/^[a-z0-9-]{1,40}\/$/.test(prefix)) throw new Error(`STORE_PREFIX must look like "scan-test/", not ${JSON.stringify(prefix)}`);
  const map = (k: string): string => (k === BLOCKLIST_KEY ? k : prefix + k);
  return {
    get: (k) => bucket.get(map(k)),
    put: (k, v, o) => bucket.put(map(k), v, o),
    delete: (keys) => bucket.delete(Array.isArray(keys) ? keys.map(map) : map(keys)),
    list: async (o = {}) => {
      const r = await bucket.list({ ...o, prefix: prefix + (o.prefix ?? "") });
      return { ...r, objects: r.objects.map((x) => ({ ...x, key: x.key.slice(prefix.length) })) };
    },
  };
}
