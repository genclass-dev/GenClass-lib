// A plain key/value store with subscribers: the page's state in one place (search results, cart count, reviews).
const state = { "search.results": [], "search.query": "", "cart.count": 0, reviews: [] };
const subs = new Map();

export const store = {
  get: (k) => state[k],
  set(k, v) {
    state[k] = v;
    for (const fn of subs.get(k) || []) fn(v);
  },
  subscribe(k, fn) {
    if (!subs.has(k)) subs.set(k, new Set());
    subs.get(k).add(fn);
    return () => subs.get(k).delete(fn);
  },
  keys: () => Object.keys(state),
};
