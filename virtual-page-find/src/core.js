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
    const items = [], pinned = new Set(), anchored = new Map();
    return {
      items,
      add(hit) {
        const previous=hit.anchorKey && anchored.get(hit.anchorKey);
        if(previous){
          Object.assign(previous,hit);
          return "duplicate";
        }
        if(hit.pinnedKey && pinned.has(hit.pinnedKey))return "duplicate";
        // Reconcile overlapping observations, but not distinct known records.
        const nearby=hit.pinnedKey?[]:items.filter(old=>!old.pinnedKey &&
          old.match===hit.match && old.context===hit.context &&
          Math.abs(old.y-hit.y)<3 && Math.abs(old.x-hit.x)<3 &&
          (!old.anchorKey || !hit.anchorKey ||
            (old.anchor && hit.anchor && old.anchor.attr===hit.anchor.attr && old.anchor.value===hit.anchor.value)));
        if(nearby.length===1){
          const old=nearby[0];
          if(hit.anchorKey){
            if(old.anchorKey)anchored.delete(old.anchorKey);
            Object.assign(old,hit);
            anchored.set(hit.anchorKey,old);
          }
          return "duplicate";
        }
        if(items.length>=limit)return "limit";
        if(hit.anchorKey)anchored.set(hit.anchorKey,hit);
        if(hit.pinnedKey)pinned.add(hit.pinnedKey);
        items.push(hit);
        return "added";
      }
    };
  }
  return { matches, nextTop, index };
})(); })();
