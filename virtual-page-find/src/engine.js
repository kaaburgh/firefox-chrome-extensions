/* Virtual Page Find — no external dependencies. */
(function installEngine(core) {
  "use strict";
  if (globalThis.__virtualPageFindV1) return;
  const LIMIT = { steps: 1200, ms: 180000, hits: 1000, nodes: 80000, chars: 2000000 };
  let candidates = [], job = null;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rootElement = () => document.scrollingElement || document.documentElement;
  const isDocument = el => el === rootElement();
  const max = el => Math.max(0, el.scrollHeight - el.clientHeight);
  const reversed = el => {
    const s = getComputedStyle(el);
    return !isDocument(el) && /^(inline-)?flex$/.test(s.display) && s.flexDirection === "column-reverse" && s.writingMode === "horizontal-tb";
  };
  // Use a physical top-to-bottom coordinate even for negative scrollTop.
  const top = el => Math.max(0, Math.min(max(el), el.scrollTop + (reversed(el) ? max(el) : 0)));
  const moveRaw = (el, y) => el.scrollTo({ top: y, left: el.scrollLeft, behavior: "instant" });
  const move = (el, y) => moveRaw(el, Math.max(0, Math.min(max(el), y)) - (reversed(el) ? max(el) : 0));
  const waits = { fast: 250, normal: 550, slow: 1000 };
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
  // Existing application-owned identifiers, not extension-injected markers.
  // Deliberately exclude data-index, data-testid and DOM paths without an ID.
  const anchorAttrs=["data-message-id","data-turn-id","data-item-id","id"];
  function anchorElement(root,attr,value) {
    const nodes=root.querySelectorAll("["+attr+"=\""+CSS.escape(value)+"\"]");
    return nodes.length===1 ? nodes[0] : null;
  }
  function pathTo(root,node) {
    const path=[];
    while(node!==root) {
      const parent=node.parentNode;
      if(!parent || path.length>=40) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes,node));
      node=parent;
    }
    return path;
  }
  function atPath(root,path) {
    let node=root;
    for(const index of path) {node=node?.childNodes[index];if(!node)return null;}
    return node;
  }
  function makeAnchor(root,first,last,start,end,cache) {
    for(let p=first.parentElement;p && p!==root;p=p.parentElement) {
      if(!p.contains(last)) continue;
      for(const attr of anchorAttrs) {
        const value=p.getAttribute(attr);
        if(!value || value.length>256) continue;
        const key=JSON.stringify([attr,value]);
        if(!cache.has(key)) cache.set(key,anchorElement(root,attr,value));
        if(cache.get(key)!==p)continue;
        const a=pathTo(p,first), b=pathTo(p,last);
        if(a && b) return {attr,value,a,b,start,end};
      }
    }
    return null;
  }
  function collect(el, query, sensitive, onHit, identities) {
    const v = viewport(el);
    if (v.height < 1 || v.width < 1) return { problem:"Selected container is no longer visible." };
    const base = isDocument(el) ? document.body || el : el;
    const originY = isDocument(el) ? 0 : el.getBoundingClientRect().top + el.clientTop;
    const originX = isDocument(el) ? 0 : el.getBoundingClientRect().left + el.clientLeft;
    const scrollY = top(el), scrollX = el.scrollLeft;
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
    const styles = new WeakMap(), anchorCache=new Map();
    function style(e) {
      if (!styles.has(e)) styles.set(e,getComputedStyle(e));
      return styles.get(e);
    }
    // Only inspect clipping ancestors for actual matches, not every text node.
    function visibleBounds(node) {
      const bounds = {...v};
      for (let p=node.parentElement; p && p!==el; p=p.parentElement) {
        const s=style(p);
        const clipX=/^(auto|scroll|hidden|clip|overlay)$/.test(s.overflowX);
        const clipY=/^(auto|scroll|hidden|clip|overlay)$/.test(s.overflowY);
        if (!clipX && !clipY) continue;
        const b=p.getBoundingClientRect();
        if (clipX) {
          bounds.left=Math.max(bounds.left,b.left+p.clientLeft);
          bounds.right=Math.min(bounds.right,b.left+p.clientLeft+p.clientWidth);
        }
        if (clipY) {
          bounds.top=Math.max(bounds.top,b.top+p.clientTop);
          bounds.bottom=Math.min(bounds.bottom,b.top+p.clientTop+p.clientHeight);
        }
      }
      return bounds;
    }
    function pinned(node) {
      for (let p=node.parentElement; p && p!==el; p=p.parentElement) {
        if (/^(sticky|fixed)$/.test(style(p).position)) return true;
      }
      return false;
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
        const first = offsets.findIndex(p=>p.end>m.start);
        if (first<0) continue;
        let rect=null, clipped=false, pinnedPart=false;
        for (let i=first; i<offsets.length && offsets[i].start<m.end; i++) {
          const part=offsets[i];
          const bounds=visibleBounds(part.node);
          if (bounds.right<=bounds.left || bounds.bottom<=bounds.top) { clipped=true; break; }
          range.setStart(part.node,Math.max(0,m.start-part.start));
          range.setEnd(part.node,Math.min(part.node.length,m.end-part.start));
          const boxes=Array.from(range.getClientRects()).filter(r=>r.width>0 && r.height>0);
          const visible=boxes.find(r=>intersect(r,bounds));
          // A split match must not include a wholly clipped non-whitespace part.
          if (!visible && part.node.data.slice(Math.max(0,m.start-part.start),Math.min(part.node.length,m.end-part.start)).trim()) { clipped=true; break; }
          if (!rect && visible) rect=visible;
          if (pinned(part.node)) pinnedPart=true;
        }
        if (clipped || !rect) continue;
        const before = text.slice(Math.max(0,m.start-60),m.start);
        const after = text.slice(m.end,m.end+60);
        const hit = { match:text.slice(m.start,m.end), context:(before+"["+text.slice(m.start,m.end)+"]"+after).replace(/\s+/g," "),
          y:Math.round(scrollY+rect.top-originY), x:Math.round(scrollX+rect.left-originX) };
        const last=offsets.find(p=>p.end>=m.end);
        const anchor=makeAnchor(base,offsets[first].node,last.node,m.start-offsets[first].start,m.end-last.start,anchorCache);
        if(anchor) {
          hit.anchor=anchor;
          hit.anchorKey=JSON.stringify([anchor.attr,anchor.value,anchor.a,anchor.b,anchor.start,anchor.end,hit.match]);
        }
        if (pinnedPart) {
          // Persistent sticky/fixed labels have changing coordinates but stable
          // text-node identities. Include the offset to keep separate matches.
          const part=offsets[first];
          if (!identities.nodes.has(part.node)) identities.nodes.set(part.node,++identities.next);
          hit.pinnedKey=JSON.stringify([identities.nodes.get(part.node),m.start-part.start,hit.match]);
        }
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
    const {status, notes, layoutChanges, steps, phase, query, sensitive, pace, original, root, idx, started} = job;
    return {status, notes:[...notes], layoutChanges, steps, phase, query, sensitive, pace, original,
      logCount:job.log.length,pass:job.pass,rescan:job.rescan,finalLayoutChanges:job.finalLayoutChanges,
      verification:job.verification ? {...job.verification,results:undefined} : null,
      elapsed: Math.round((job.finished || performance.now())-started),
      position:Math.round(top(root)), range:Math.round(max(root)),
      hits:[...idx.items].sort((a,b)=>a.y-b.y || a.x-b.x)};
  }
  // Diagnostic records contain only fixed event names and explicitly selected
  // numeric/boolean metadata. Never include page text, query, URL, DOM IDs or raw exceptions.
  function log(j, event, fields={}) {
    if (j.log.length>=4096) { j.log.shift(); j.droppedLogs++; }
    j.log.push({ms:Math.round(performance.now()-j.started),event,...fields});
  }
  function diagnostics() {
    if (!job) return "";
    return [
      "Virtual Page Find diagnostic log v1",
      "Started UTC: "+job.startedUTC,
      "Status: "+job.status+"; pace: "+job.pace+"; matches: "+job.idx.items.length,
      ...(job.droppedLogs ? ["Earlier records discarded: "+job.droppedLogs] : []),
      ...job.log.map(({ms,event,...fields})=>ms+"ms "+event+" "+Object.entries(fields).map(([k,v])=>k+"="+v).join(" "))
    ].join("\n");
  }
  function note(j, message, diagnostic=message) {
    if (!j.notes.includes(message)) j.notes.push(message);
    log(j,"warning",{reason:diagnostic});
  }
  async function run(j) {
    const el = j.root;
    let lastMutation = performance.now(), observer, mutations=0;
    log(j,"start",{pace:j.pace,minimumWait:waits[j.pace],rawTop:Math.round(el.scrollTop),top:Math.round(top(el)),range:Math.round(max(el)),viewHeight:Math.round(viewport(el).height),reverse:reversed(el)});
    const inputEvents = ["wheel","touchstart","pointerdown","keydown"];
    const interrupt = e => {
      if (e.isTrusted && (e.type !== "keydown" || ["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(e.key))) {
        if (!j.cancel) log(j,"user-interaction",{type:e.type});
        j.cancel = true; j.manual = true;
      }
    };
    const alive = () => !j.cancel && el.isConnected && performance.now()-j.started < LIMIT.ms && j.steps < LIMIT.steps;
    async function settle(minimum=waits[j.pace]) {
      const start = performance.now();
      const initialMutations=mutations;
      let lastChange = start, prev = [top(el),max(el)];
      const record=reason=>log(j,"settle",{reason,waitMs:Math.round(performance.now()-start),mutations:mutations-initialMutations,top:Math.round(top(el)),range:Math.round(max(el))});
      while (alive()) {
        await pause(50);
        const now = performance.now(), current = [top(el),max(el)];
        if (current[0]!==prev[0] || current[1]!==prev[1]) { lastChange=now; prev=current; }
        if (now-start>=minimum && now-Math.max(lastMutation,lastChange)>=160) { record("quiet"); return; }
        if (now-start>=Math.max(1500,minimum+500)) { record("timeout"); note(j,"Some views did not settle; asynchronous content may have been missed."); return; }
      }
      record("interrupted");
    }
    try {
      observer = new MutationObserver(records=>{lastMutation=performance.now(); mutations+=records.length;});
      observer.observe(isDocument(el) ? document.documentElement : el,{childList:true,subtree:true,characterData:true});
      for (const type of inputEvents) window.addEventListener(type,interrupt,{capture:true,passive:true});
      async function scanPass() {
      const changesBefore=j.layoutChanges;
      j.reachedEnd=false;
      j.phase=j.pass===2?"Rechecking top":"Finding top"; log(j,"finding-top",{pass:j.pass});
      let stable=0;
      for (let attempt=0; attempt<10 && alive() && stable<2; attempt++) {
        const oldMax=max(el);
        move(el,0); await settle(Math.max(500,waits[j.pace]));
        stable = top(el)<=2 && Math.abs(max(el)-oldMax)<=2 ? stable+1 : 0;
        log(j,"top-check",{attempt:attempt+1,stable,oldRange:Math.round(oldMax),range:Math.round(max(el))});
      }
      if (stable<2 && alive()) note(j,"Could not establish a stable top; earlier content may be missing.");
      j.phase=j.pass===2?"Second pass":"Scanning"; log(j,"scanning",{pass:j.pass});
      let bottomStable=0, lastRange=max(el), lastPosition=-1;
      while (alive()) {
        const current=top(el), range=max(el);
        // Lazy rendering may resize the scroll area without user input.
        // Reaching both ends does not establish coverage after reflow.
        if (Math.abs(range-lastRange)>3) {
          j.layoutChanges++;
          log(j,"range-change",{step:j.steps+1,from:Math.round(lastRange),to:Math.round(range),top:Math.round(current)});
          lastRange=range;
        }
        if (lastPosition>=0 && current+3<lastPosition) note(j,"Page moved backwards during scan; completeness is uncertain.");
        lastPosition=current;
        j.steps++;
        const before=j.idx.items.length, collectStarted=performance.now();
        const result = collect(el,j.query,j.sensitive,hit=>j.idx.add(hit)!=="limit",j.identities);
        const height=viewport(el).height;
        log(j,"view",{step:j.steps,top:Math.round(current),range:Math.round(range),height:Math.round(height),newHits:j.idx.items.length-before,totalHits:j.idx.items.length,collectMs:Math.round(performance.now()-collectStarted)});
        if (result.problem) { note(j,result.problem); break; }
        if (height<1) { note(j,"Selected container became invisible."); break; }
        if (current>=range-2) {
          await settle(Math.max(650,waits[j.pace]));
          if (!alive()) break;
          log(j,"bottom-check",{stable:bottomStable,top:Math.round(top(el)),range:Math.round(max(el))});
          if (Math.abs(max(el)-lastRange)>3) {
            j.layoutChanges++;
            log(j,"range-change",{step:j.steps,from:Math.round(lastRange),to:Math.round(max(el)),top:Math.round(top(el))});
            lastRange=max(el);
          }
          if (top(el)>=max(el)-2 && Math.abs(max(el)-range)<=2) {
            if (++bottomStable>=2) {
              // Inspect once more after the final quiet period, not before it.
              const before=j.idx.items.length;
              const final = collect(el,j.query,j.sensitive,hit=>j.idx.add(hit)!=="limit",j.identities);
              log(j,"final-view",{newHits:j.idx.items.length-before,totalHits:j.idx.items.length});
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
        log(j,"scroll",{from:Math.round(current),target:Math.round(target),actual:Math.round(actual)});
        if (actual<=current+0.5 && max(el)>=current+3 && alive()) {
          note(j,"Scrolling stalled (possibly scroll snapping or page interference)."); break;
        }
        if (actual-current>height+2) note(j,"A scroll jump exceeded one viewport; some content may have been skipped.");
      }
      j.finalLayoutChanges=j.layoutChanges-changesBefore;
      }
      await scanPass();
      if(j.rescan && j.reachedEnd && j.finalLayoutChanges && !j.notes.length && alive()) {
        const first={idx:j.idx,identities:j.identities,changes:j.finalLayoutChanges};
        j.pass=2;
        j.idx=core.index(LIMIT.hits);j.identities={nodes:new WeakMap(),next:0};
        log(j,"rescan-start",{firstHits:first.idx.items.length});
        await scanPass();
        if(!j.reachedEnd || j.notes.length || j.cancel) {
          j.idx=first.idx;j.identities=first.identities;
          j.finalLayoutChanges=first.changes;
          note(j,"Second pass incomplete; showing first-pass results.");
        } else log(j,"rescan-finished",{hits:j.idx.items.length,changes:j.finalLayoutChanges});
      }
      if (j.cancel) note(j,j.manual?"Stopped because you interacted with the page.":"Stopped by user.");
      else if (!el.isConnected) note(j,"Selected scroll container was removed.");
      else if (!j.reachedEnd && (j.steps>=LIMIT.steps || performance.now()-j.started>=LIMIT.ms)) note(j,"Scan safety limit reached.");
      j.status = j.reachedEnd && !j.cancel && !j.notes.length ? (j.finalLayoutChanges ? "layout-uncertain" : "traversed") : "partial";
    } catch (error) {
      note(j,"Scan error: "+String(error.message || error).slice(0,300),"Scan error (details omitted)"); j.status="partial";
    } finally {
      observer?.disconnect();
      for (const type of inputEvents) window.removeEventListener(type,interrupt,true);
      if (!j.manual && el.isConnected) {
        try { moveRaw(el,j.original); log(j,"restore",{requested:Math.round(j.original),actual:Math.round(el.scrollTop)}); } catch { note(j,"Could not restore original scroll position."); j.status="partial"; }
      }
      j.phase="Finished"; j.finished=performance.now();
      log(j,"finished",{status:j.status,steps:j.steps,hits:j.idx.items.length,layoutChanges:j.layoutChanges,reachedEnd:j.reachedEnd,manual:j.manual});
    }
  }
  function start(args) {
    if (job?.status==="running" || job?.navBusy || job?.verification?.running) throw new Error("A scan or navigation is already running.");
    const root=candidates[args.id], query=String(args.query || "");
    if (!root?.isConnected) throw new Error("Scroll container disappeared. Reopen the popup.");
    if (!query.trim() || query.length>256) throw new Error("Enter 1–256 characters.");
    const pace=Object.hasOwn(waits,args.pace) ? args.pace : "normal";
    job={root,query,sensitive:!!args.sensitive,pace,original:root.scrollTop,idx:core.index(LIMIT.hits),
      identities:{nodes:new WeakMap(),next:0},log:[],droppedLogs:0,startedUTC:new Date().toISOString(),
      status:"running",phase:"Starting",started:performance.now(),steps:0,notes:[],layoutChanges:0,finalLayoutChanges:0,pass:1,rescan:args.rescan!==false,cancel:false,manual:false,reachedEnd:false,navBusy:false,verification:null};
    void run(job);
    return snapshot();
  }
  function ordered(j) {return [...j.idx.items].sort((a,b)=>a.y-b.y || a.x-b.x);}
  function locateMounted(j,hit) {
    if(!hit.anchor)return null;
    const root=j.root, base=isDocument(root)?document.body||root:root;
    const {attr,value,a,b,start,end}=hit.anchor;
    const element=anchorElement(base,attr,value);
    if(!element)return null;
    const first=atPath(element,a), last=atPath(element,b);
    if(first?.nodeType!==Node.TEXT_NODE || last?.nodeType!==Node.TEXT_NODE ||
       start>first.length || end>last.length)return null;
    const range=document.createRange();
    range.setStart(first,start);range.setEnd(last,end);
    if(range.toString()!==hit.match)return null;
    const rect=Array.from(range.getClientRects()).find(r=>r.width>0 && r.height>0);
    if(!rect)return null;
    const origin=isDocument(root)?0:root.getBoundingClientRect().top+root.clientTop;
    return top(root)+rect.top-origin;
  }
  async function navigate(j,hit,index) {
    const root=j.root;
    if(!root.isConnected || !hit || !Number.isFinite(hit.y))return {found:false,outcome:"not-found"};
    const mounted=locateMounted(j,hit);
    const target=Math.max(0,(mounted ?? hit.y)-viewport(root).height*0.35);
    move(root,target);
    await pause(Math.max(500,waits[j.pace])+160);
    let exact=null, approximate=false;
    if(root.isConnected) collect(root,j.query,j.sensitive,h=>{
      if(hit.anchorKey && h.anchorKey===hit.anchorKey && h.context===hit.context) exact=h;
      if(h.context===hit.context && (hit.pinnedKey ? h.pinnedKey===hit.pinnedKey : Math.abs(h.y-hit.y)<10 && Math.abs(h.x-hit.x)<10))approximate=true;
      return !exact;
    },j.identities);
    const outcome=exact?"verified":approximate?"approximate":"not-found";
    log(j,"jump",{index:index+1,savedY:hit.y,target:Math.round(target),actual:Math.round(top(root)),range:Math.round(max(root)),anchored:!!hit.anchorKey,mounted:mounted!==null,outcome});
    return {found:outcome==="verified",outcome};
  }
  async function jump(args) {
    const j=job;
    if(!j || j.status==="running" || j.navBusy || j.verification?.running)throw new Error("Finish the current operation first.");
    const hits=ordered(j),index=args.index;
    // The popup supplies an index only; never navigate using arbitrary page-supplied coordinates.
    const hit=hits[index];
    if(!Number.isInteger(index)||!hit)throw new Error("Result is no longer available.");
    j.navBusy=true;
    try{return await navigate(j,hit,index);}finally{j.navBusy=false;}
  }
  function verifyAll() {
    const j=job;
    if(!j || j.status==="running" || j.navBusy || j.verification?.running)throw new Error("Finish the current operation first.");
    const hits=ordered(j), limit=Math.min(hits.length,100), original=j.root.scrollTop;
    const v=j.verification={running:true,cancel:false,manual:false,total:hits.length,limit,checked:0,verified:0,approximate:0,notFound:0,results:[]};
    const events=["wheel","touchstart","pointerdown","keydown"];
    const interrupt=e=>{if(e.isTrusted && (e.type!=="keydown" || ["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(e.key))){v.cancel=true;v.manual=true;}};
    async function runVerification(){
      log(j,"verify-start",{total:hits.length,limit});
      for(const type of events)window.addEventListener(type,interrupt,{capture:true,passive:true});
      try {
        for(let i=0;i<limit && !v.cancel && j.root.isConnected;i++){
          const result=await navigate(j,hits[i],i);
          if(v.cancel)break;
          v.checked++;v.results.push(result.outcome);
          if(result.outcome==="verified")v.verified++;
          else if(result.outcome==="approximate")v.approximate++;
          else v.notFound++;
        }
      }catch{v.cancel=true;log(j,"verify-error");}
      finally{
        for(const type of events)window.removeEventListener(type,interrupt,true);
        if(!v.manual && j.root.isConnected)try{moveRaw(j.root,original);}catch{log(j,"verify-restore-error");}
        v.running=false;
        log(j,"verify-finished",{checked:v.checked,verified:v.verified,approximate:v.approximate,notFound:v.notFound,cancelled:v.cancel});
      }
    }
    void runVerification();
    return snapshot();
  }
  globalThis.__virtualPageFindV1 = {
    discover:()=>job?.status==="running"||job?.verification?.running||job?.navBusy?null:discover(),
    start, snapshot, diagnostics,
    stop:()=>{if(job?.status==="running"){log(job,"stop-request");job.cancel=true;} if(job?.verification?.running)job.verification.cancel=true; return snapshot();},
    jump, verifyAll,
    restore:()=>{if(job && job.status!=="running" && !job.navBusy && !job.verification?.running && job.root.isConnected) moveRaw(job.root,job.original); return snapshot();},
    clear:()=>{if(job?.status==="running"||job?.navBusy||job?.verification?.running) throw new Error("Stop the current operation first."); job=null; return snapshot();}
  };
})(globalThis.__vpfCore);
