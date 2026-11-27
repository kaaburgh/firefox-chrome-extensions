/* Virtual Page Find — no external dependencies. */
(function installEngine(core) {
  "use strict";
  if (globalThis.__virtualPageFindV1) return;
  const LIMIT = { steps: 1200, ms: 180000, hits: 1000, nodes: 80000, chars: 2000000 };
  let candidates = [], job = null;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rootElement = () => document.scrollingElement || document.documentElement;
  const isDocument = el => el === rootElement();
  const top = el => el.scrollTop;
  const max = el => Math.max(0, el.scrollHeight - el.clientHeight);
  const move = (el, y) => el.scrollTo({ top: y, left: el.scrollLeft, behavior: "instant" });
  const intersect = (a,b) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  function viewport(el) {
    let r = { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
    if (!isDocument(el)) {
      const b = el.getBoundingClientRect();
      r = { top: Math.max(0,b.top+el.clientTop), left: Math.max(0,b.left+el.clientLeft),
        right: Math.min(innerWidth,b.left+el.clientLeft+el.clientWidth),
        bottom: Math.min(innerHeight,b.top+el.clientTop+el.clientHeight) };
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const s = getComputedStyle(p), b = p.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(s.overflowY)) {
          r.top = Math.max(r.top,b.top+p.clientTop);
          r.bottom = Math.min(r.bottom,b.top+p.clientTop+p.clientHeight);
        }
        if (/auto|scroll|hidden|clip/.test(s.overflowX)) {
          r.left = Math.max(r.left,b.left+p.clientLeft);
          r.right = Math.min(r.right,b.left+p.clientLeft+p.clientWidth);
        }
      }
    }
    return {...r, height: Math.max(0,r.bottom-r.top), width: Math.max(0,r.right-r.left)};
  }
  function discover() {
    const root = rootElement(), list = [root];
    for (const el of document.querySelectorAll("body *")) {
      if (el === root || el.clientHeight < 60 || el.clientWidth < 60 || max(el) < 8) continue;
      if (!/auto|scroll|overlay/.test(getComputedStyle(el).overflowY)) continue;
      const v = viewport(el);
      if (v.height > 40 && v.width > 40) list.push(el);
    }
    candidates = list.sort((a,b) => {
      const score = el => { const r = viewport(el); return r.height*r.width*(max(el)>8 ? 1 : 0.01); };
      return score(b)-score(a);
    }).slice(0,30);
    return candidates.map((el,i) => ({ id:i, label:isDocument(el) ? "Whole document" :
      el.tagName.toLowerCase() + (el.id ? "#"+el.id.slice(0,60) : "") +
      (el.getAttribute("role") ? " ["+el.getAttribute("role").slice(0,40)+"]" : ""),
      height: Math.round(viewport(el).height), range: Math.round(max(el)) }));
  }
  function collect(el, query, sensitive, onHit) {
    const v = viewport(el);
    if (v.height < 1 || v.width < 1) return { problem:"Selected container is no longer visible." };
    const base = isDocument(el) ? document.body || el : el;
    const originY = isDocument(el) ? 0 : el.getBoundingClientRect().top + el.clientTop;
    const originX = isDocument(el) ? 0 : el.getBoundingClientRect().left + el.clientLeft;
    const scrollY = top(el), scrollX = el.scrollLeft;
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
    const styles = new WeakMap();
    function style(e) {
      if (!styles.has(e)) styles.set(e,getComputedStyle(e));
      return styles.get(e);
    }
    function block(e) {
      while (e !== base && e.parentElement &&
        /^(inline|inline-block|inline-flex|inline-grid|contents|ruby)/.test(style(e).display)) e = e.parentElement;
      return e;
    }
    let group = [], groupBlock = null, count = 0, chars = 0, limited = false;
    const range = document.createRange();
    function flush() {
      if (!group.length) return true;
      const parts = group; group = [];
      let offset = 0;
      const offsets = parts.map(node => { const start = offset; offset += node.length; return {node,start,end:offset}; });
      const text = parts.map(n=>n.data).join("");
      for (const m of core.matches(text,query,sensitive)) {
        const first = offsets.find(p=>p.end>m.start), last = offsets.find(p=>p.end>=m.end);
        if (!first || !last) continue;
        range.setStart(first.node,m.start-first.start); range.setEnd(last.node,m.end-last.start);
        const rect = Array.from(range.getClientRects()).find(r=>r.width>0 && r.height>0 && intersect(r,v));
        if (!rect) continue;
        const before = text.slice(Math.max(0,m.start-60),m.start);
        const after = text.slice(m.end,m.end+60);
        const hit = { match:text.slice(m.start,m.end), context:(before+"["+text.slice(m.start,m.end)+"]"+after).replace(/\s+/g," "),
          y:Math.round(scrollY+rect.top-originY), x:Math.round(scrollX+rect.left-originX) };
        if (onHit(hit) === false) return false;
      }
      return true;
    }
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++count > LIMIT.nodes || (chars += node.length)>LIMIT.chars) { limited = true; break; }
      const p = node.parentElement;
      if (!p || !node.length || p.closest("script,style,noscript,template,textarea,select,option")) {
        if (!flush()) return {problem:"Result limit reached."}; groupBlock=null; continue;
      }
      // Keep whitespace and inline nodes together, even if their own box is empty.
      const b = block(p);
      const visible = style(p).visibility === "visible" &&
        style(p).display !== "none" && intersect(b.getBoundingClientRect(),v);
      if (!visible || b !== groupBlock) {
        if (!flush()) return {problem:"Result limit reached."};
        groupBlock = visible ? b : null;
      }
      if (visible) group.push(node);
    }
    if (!flush()) return {problem:"Result limit reached."};
    return limited ? {problem:"DOM inspection limit reached."} : {};
  }
  function snapshot() {
    if (!job) return {status:"idle", hits:[], notes:[]};
    const {status, notes, steps, phase, query, sensitive, original, root, idx, started} = job;
    return {status, notes:[...notes], steps, phase, query, sensitive, original,
      elapsed: Math.round((job.finished || performance.now())-started),
      position:Math.round(top(root)), range:Math.round(max(root)),
      hits:[...idx.items].sort((a,b)=>a.y-b.y || a.x-b.x)};
  }
  function note(j, message) { if (!j.notes.includes(message)) j.notes.push(message); }
  async function run(j) {
    const el = j.root;
    let lastMutation = performance.now(), observer;
    const inputEvents = ["wheel","touchstart","pointerdown","keydown"];
    const interrupt = e => {
      if (e.isTrusted && (e.type !== "keydown" || ["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(e.key))) {
        j.cancel = true; j.manual = true;
      }
    };
    const alive = () => !j.cancel && el.isConnected && performance.now()-j.started < LIMIT.ms && j.steps < LIMIT.steps;
    async function settle(minimum=220) {
      const start = performance.now();
      let lastChange = start, prev = [top(el),max(el)];
      while (alive()) {
        await pause(50);
        const now = performance.now(), current = [top(el),max(el)];
        if (current[0]!==prev[0] || current[1]!==prev[1]) { lastChange=now; prev=current; }
        if (now-start>=minimum && now-Math.max(lastMutation,lastChange)>=160) return;
        if (now-start>=1500) { note(j,"Some views did not settle; asynchronous content may have been missed."); return; }
      }
    }
    try {
      observer = new MutationObserver(()=>{lastMutation=performance.now();});
      observer.observe(isDocument(el) ? document.documentElement : el,{childList:true,subtree:true,characterData:true});
      for (const type of inputEvents) window.addEventListener(type,interrupt,{capture:true,passive:true});
      j.phase="Finding top";
      let stable=0;
      for (let attempt=0; attempt<10 && alive() && stable<2; attempt++) {
        const oldMax=max(el);
        move(el,0); await settle(500);
        stable = top(el)<=2 && Math.abs(max(el)-oldMax)<=2 ? stable+1 : 0;
      }
      if (stable<2 && alive()) note(j,"Could not establish a stable top; earlier content may be missing.");
      j.phase="Scanning";
      let bottomStable=0, lastRange=max(el), lastPosition=-1;
      while (alive()) {
        const current=top(el), range=max(el);
        if (Math.abs(range-lastRange)>3) note(j,"Scroll range changed during scan; positions and completeness may be affected.");
        if (lastPosition>=0 && current+3<lastPosition) note(j,"Page moved backwards during scan; completeness is uncertain.");
        lastRange=range; lastPosition=current;
        j.steps++;
        const result = collect(el,j.query,j.sensitive,hit=>j.idx.add(hit)!=="limit");
        if (result.problem) { note(j,result.problem); break; }
        const height=viewport(el).height;
        if (height<1) { note(j,"Selected container became invisible."); break; }
        if (current>=range-2) {
          await settle(650);
          if (!alive()) break;
          if (top(el)>=max(el)-2 && Math.abs(max(el)-range)<=2) {
            if (++bottomStable>=2) {
              // Inspect once more after the final quiet period, not before it.
              const final = collect(el,j.query,j.sensitive,hit=>j.idx.add(hit)!=="limit");
              if (final.problem) note(j,final.problem); else j.reachedEnd=true;
              break;
            }
          } else bottomStable=0;
          continue;
        }
        bottomStable=0;
        const target=core.nextTop(current,height,range);
        move(el,target); await settle();
        const actual=top(el);
        if (actual<=current+0.5 && max(el)>=current+3 && alive()) {
          note(j,"Scrolling stalled (possibly scroll snapping or page interference)."); break;
        }
        if (actual-current>height+2) note(j,"A scroll jump exceeded one viewport; some content may have been skipped.");
      }
      if (j.cancel) note(j,j.manual?"Stopped because you interacted with the page.":"Stopped by user.");
      else if (!el.isConnected) note(j,"Selected scroll container was removed.");
      else if (!j.reachedEnd && (j.steps>=LIMIT.steps || performance.now()-j.started>=LIMIT.ms)) note(j,"Scan safety limit reached.");
      j.status = j.reachedEnd && !j.cancel && !j.notes.length ? "traversed" : "partial";
    } catch (error) {
      note(j,"Scan error: "+String(error.message || error).slice(0,300)); j.status="partial";
    } finally {
      observer?.disconnect();
      for (const type of inputEvents) window.removeEventListener(type,interrupt,true);
      if (!j.manual && el.isConnected) {
        try { move(el,j.original); } catch { note(j,"Could not restore original scroll position."); j.status="partial"; }
      }
      j.phase="Finished"; j.finished=performance.now();
    }
  }
  function start(args) {
    if (job?.status==="running") throw new Error("A scan is already running.");
    const root=candidates[args.id], query=String(args.query || "");
    if (!root?.isConnected) throw new Error("Scroll container disappeared. Reopen the popup.");
    if (!query.trim() || query.length>256) throw new Error("Enter 1–256 characters.");
    job={root,query,sensitive:!!args.sensitive,original:top(root),idx:core.index(LIMIT.hits),
      status:"running",phase:"Starting",started:performance.now(),steps:0,notes:[],cancel:false,manual:false,reachedEnd:false};
    void run(job);
    return snapshot();
  }
  async function jump(args) {
    if (!job || job.status==="running") throw new Error("Finish the scan first.");
    const root=job.root, hit=args.hit;
    if (!root.isConnected || !hit || !Number.isFinite(hit.y)) throw new Error("Result is no longer available.");
    move(root,Math.max(0,hit.y-viewport(root).height*0.35));
    await pause(500);
    let found=false;
    collect(root,job.query,job.sensitive,h=>{if(h.context===hit.context && Math.abs(h.y-hit.y)<10 && Math.abs(h.x-hit.x)<10) found=true; return true;});
    return {found};
  }
  globalThis.__virtualPageFindV1 = {
    discover:()=>job?.status==="running"?null:discover(),
    start, snapshot,
    stop:()=>{if(job?.status==="running") job.cancel=true; return snapshot();},
    jump,
    restore:()=>{if(job && job.status!=="running" && job.root.isConnected) move(job.root,job.original); return snapshot();},
    clear:()=>{if(job?.status==="running") throw new Error("Stop scan first."); job=null; return snapshot();}
  };
})(globalThis.__vpfCore);
