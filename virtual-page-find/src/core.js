/* Pure search helpers. */
(function(){ globalThis.__vpfCore = (function createCore() {
  function* matches(text, query, sensitive = false) {
    if (!query) return;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const m of text.matchAll(new RegExp(escaped, sensitive ? "gu" : "giu")))
      yield { start: m.index, end: m.index + m[0].length };
  }
  function nextTop(top, height, max) {
    return Math.min(max, top + Math.max(1, Math.floor(height * 0.65)));
  }
  function index(limit = 1000) {
    const items = [], buckets = new Map();
    return {
      items,
      add(hit) {
        const key = JSON.stringify([hit.match, hit.context]);
        const group = buckets.get(key) || [];
        if (group.some(old => Math.abs(old.y - hit.y) < 3 && Math.abs(old.x - hit.x) < 3)) return "duplicate";
        if (items.length >= limit) return "limit";
        group.push(hit);
        buckets.set(key, group);
        items.push(hit);
        return "added";
      }
    };
  }
  return { matches, nextTop, index };
})(); })();
