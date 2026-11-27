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
    const items = [], buckets = new Map(), pinned = new Set(), anchored = new Map();
    return {
      items,
      add(hit) {
        const key = JSON.stringify([hit.match, hit.context]);
        const group = buckets.get(key) || [];
        if (hit.anchorKey) {
          const previous=anchored.get(hit.anchorKey);
          if (previous) {
            // Keep the latest measured coordinates for the same logical occurrence.
            Object.assign(previous,hit);
            return "duplicate";
          }
          if (items.length>=limit) return "limit";
          anchored.set(hit.anchorKey,hit);items.push(hit);return "added";
        }
        if (hit.pinnedKey ? pinned.has(hit.pinnedKey) :
          group.some(old => !old.pinnedKey && Math.abs(old.y - hit.y) < 3 && Math.abs(old.x - hit.x) < 3)) return "duplicate";
        if (items.length >= limit) return "limit";
        if (hit.pinnedKey) pinned.add(hit.pinnedKey);
        else {
          group.push(hit);
          buckets.set(key, group);
        }
        items.push(hit);
        return "added";
      }
    };
  }
  return { matches, nextTop, index };
})(); })();
