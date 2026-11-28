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
  // Some virtualized views keep rendering for longer than the previous 1.5s
  // timeout. Keep a bounded wait; never declare a still-changing view quiet.
  const settleLimit = minimum => Math.max(4000,minimum+500);
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
  function makeAnchor(root,first,last,start,end,cache,matchBlock) {
    // Prefer application record IDs over incidental HTML IDs, even if the
    // latter are closer to the text node.
    for(const attr of anchorAttrs) {
      for(let p=first.parentElement;p && p!==root;p=p.parentElement) {
        // A generic HTML ID identifies the element itself, not the logical
        // items in a changing subtree. Never use a generic ID above the
        // matched text block (e.g. a virtual list's persistent spacer).
        if(attr==="id" && !matchBlock.contains(p)) break;
        if(!p.contains(last)) continue;
        const value=p.getAttribute(attr);
        if(!value || value.length>256) continue;
        const key=JSON.stringify([attr,value]);
        if(!cache.has(key)) cache.set(key,anchorElement(root,attr,value));
        if(cache.get(key)!==p)continue;
        const a=pathTo(p,first), b=pathTo(p,last);
        if(a && b) return {attr,value,a,b,start,end};
      }
    }
    // Some record labels (such as timestamps) live next to, not inside,
    // a turn element. Only accept a tightly scoped sibling association:
    // one record in the wrapper, distinct child branches, and other
    // records in the wrapper's parent (not a single shared list header).
    const wrapper=matchBlock.parentElement, attr="data-turn-id";
    if(!wrapper || wrapper===root || !wrapper.parentElement || !wrapper.contains(last))return null;
    const records=wrapper.querySelectorAll("["+attr+"]");
    if(records.length!==1 || wrapper.parentElement.querySelectorAll("["+attr+"]").length<2)return null;
    const record=records[0], value=record.getAttribute(attr);
    if(!value || value.length>256 || record.contains(first) || record.contains(last))return null;
    const key=JSON.stringify([attr,value]);
    if(!cache.has(key))cache.set(key,anchorElement(root,attr,value));
    if(cache.get(key)!==record)return null;
    const recordPath=pathTo(wrapper,record), a=pathTo(wrapper,first), b=pathTo(wrapper,last);
    if(!recordPath?.length || recordPath.length>3 || !a?.length || !b?.length ||
       a[0]===recordPath[0] || b[0]===recordPath[0])return null;
    return {attr,value,a,b,start,end,up:recordPath.length};
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
        const anchor=makeAnchor(base,offsets[first].node,last.node,m.start-offsets[first].start,m.end-last.start,anchorCache,groupBlock);
        if(anchor) {
          hit.anchor=anchor;
          hit.anchorKey=JSON.stringify([anchor.attr,anchor.value,anchor.up||0,anchor.a,anchor.b,anchor.start,anchor.end,hit.match]);
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
      verification:job.verification ? {...job.verification,results:[...job.verification.results]} : null,
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
        if (now-start>=settleLimit(minimum)) { record("timeout"); note(j,"Some views did not settle; asynchronous content may have been missed."); return; }
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
      // A transient jump, stall or unsettled view on the first pass is
      // another reason to retry, not a reason to forbid a recovery pass.
      const recoverable=new Set([
        "Could not establish a stable top; earlier content may be missing.",
        "Some views did not settle; asynchronous content may have been missed.",
        "Page moved backwards during scan; completeness is uncertain.",
        "Scrolling stalled (possibly scroll snapping or page interference).",
        "A scroll jump exceeded one viewport; some content may have been skipped."
      ]);
      if(j.rescan && alive() && j.notes.every(n=>recoverable.has(n)) &&
         (j.notes.length || (j.reachedEnd && j.finalLayoutChanges))) {
        const first={idx:j.idx,identities:j.identities,changes:j.finalLayoutChanges,notes:j.notes,reachedEnd:j.reachedEnd};
        j.pass=2;
        j.idx=core.index(LIMIT.hits);j.identities={nodes:new WeakMap(),next:0};j.notes=[];
        log(j,"rescan-start",{firstHits:first.idx.items.length,firstWarnings:first.notes.length,firstReachedEnd:first.reachedEnd});
        await scanPass();
        if(!j.reachedEnd || j.notes.length || j.cancel) {
          j.idx=first.idx;j.identities=first.identities;
          j.finalLayoutChanges=first.changes;j.reachedEnd=first.reachedEnd;
          j.notes=first.notes;
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
      log(j,"finished",{status:j.status,steps:j.steps,hits:j.idx.items.length,anchoredHits:j.idx.items.filter(h=>h.anchorKey).length,passes:j.pass,layoutChanges:j.layoutChanges,finalLayoutChanges:j.finalLayoutChanges,reachedEnd:j.reachedEnd,manual:j.manual});
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
    let element=anchorElement(base,attr,value);
    if(!element)return null;
    for(let i=0;i<(hit.anchor.up||0);i++){element=element.parentElement;if(!element || element===base)return null;}
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
  // A large jump can change the virtualizer's estimated geometry. Replay
  // the same forward viewport traversal when the direct jump cannot find
  // the recorded occurrence. A batch reuses its forward traversal cursor.
  function navigationSession(j, cancelled) {
    const root=j.root, started=performance.now();
    let lastMutation=started;
    const observer=new MutationObserver(()=>{lastMutation=performance.now();});
    observer.observe(isDocument(root)?document.documentElement:root,{childList:true,subtree:true,characterData:true});
    const session={replay:false,steps:0,close:()=>observer.disconnect()};
    session.alive=()=>!cancelled() && root.isConnected && session.steps<LIMIT.steps && performance.now()-started<LIMIT.ms;
    session.settle=async(minimum=waits[j.pace])=>{
      const begin=performance.now();
      let lastChange=begin, previous=[top(root),max(root)];
      while(session.alive()){
        await pause(50);
        if(!session.alive())return "interrupted";
        const now=performance.now(), current=[top(root),max(root)];
        if(current[0]!==previous[0] || current[1]!==previous[1]){lastChange=now;previous=current;}
        if(now-begin>=minimum && now-Math.max(lastMutation,lastChange)>=160)return "quiet";
        if(now-begin>=settleLimit(minimum))return now-lastChange>=160?"geometry-quiet":"interrupted";
      }
      return "interrupted";
    };
    return session;
  }
  function inspectPosition(j,hit) {
    let exact=false, approximate=false;
    const result=collect(j.root,j.query,j.sensitive,h=>{
      if(hit.anchorKey && h.anchorKey===hit.anchorKey && h.context===hit.context)exact=true;
      if(h.context===hit.context && (hit.pinnedKey ? h.pinnedKey===hit.pinnedKey : Math.abs(h.y-hit.y)<10 && Math.abs(h.x-hit.x)<10))approximate=true;
      // Collect the entire viewport so a stop caused by an exact match
      // is not mistaken for an inspection limit.
      return true;
    },j.identities);
    if(result.problem)return "not-found";
    return exact?"verified":approximate?"approximate":"not-found";
  }
  async function replayTo(j,hit,index,s) {
    const root=j.root;
    if(!s.replay || top(root)>hit.y+10){
      s.replay=false;
      log(j,"jump-replay-start",{index:index+1,from:Math.round(top(root)),savedY:hit.y});
      let stable=0;
      for(let attempt=0;attempt<10 && stable<2 && s.alive();attempt++){
        const oldRange=max(root);
        move(root,0);s.steps++;
        if(await s.settle(Math.max(500,waits[j.pace]))==="interrupted")return "not-found";
        stable=top(root)<=2 && Math.abs(max(root)-oldRange)<=2?stable+1:0;
      }
      if(stable<2)return "not-found";
      s.replay=true;
    }
    while(s.alive()){
      const current=top(root), range=max(root), height=viewport(root).height;
      const outcome=inspectPosition(j,hit);
      log(j,"jump-replay-view",{index:index+1,top:Math.round(current),range:Math.round(range),outcome});
      if(outcome!=="not-found")return outcome;
      // For unanchored hits, do not substitute a nearby occurrence; only
      // accept the same context and coordinate as during the scan.
      if((!hit.anchorKey && current>hit.y+10) || current>=range-2 || height<1)return "not-found";
      const target=core.nextTop(current,height,range);
      move(root,target);s.steps++;
      const settled=await s.settle();
      if(settled==="interrupted")return "not-found";
      if(settled==="geometry-quiet")log(j,"jump-replay-busy",{index:index+1,top:Math.round(top(root)),range:Math.round(max(root))});
      const actual=top(root);
      log(j,"jump-replay-scroll",{index:index+1,from:Math.round(current),target:Math.round(target),actual:Math.round(actual),range:Math.round(max(root))});
      if(actual<=current+0.5 || actual-current>height+2){
        s.replay=false;
        log(j,"jump-replay-gap",{index:index+1});
        return "not-found";
      }
    }
    return "not-found";
  }
  async function navigate(j,hit,index,s) {
    const root=j.root;
    if(!root.isConnected || !hit || !Number.isFinite(hit.y) || !s.alive())return {found:false,outcome:"not-found"};
    const mounted=locateMounted(j,hit);
    const target=Math.max(0,(mounted ?? hit.y)-viewport(root).height*0.35);
    let outcome="not-found", method="direct";
    if(!s.replay){
      move(root,target);s.steps++;
      const settleState=await s.settle(Math.max(500,waits[j.pace])+160);
      const settled=settleState!=="interrupted";
      if(settled && s.alive())outcome=inspectPosition(j,hit);
      log(j,"jump-direct",{index:index+1,savedY:hit.y,target:Math.round(target),actual:Math.round(top(root)),range:Math.round(max(root)),settled,outcome});
    }
    if(outcome==="not-found" && s.alive()){
      method="replay";
      outcome=await replayTo(j,hit,index,s);
    }
    log(j,"jump",{index:index+1,savedY:hit.y,target:Math.round(target),actual:Math.round(top(root)),range:Math.round(max(root)),anchored:!!hit.anchorKey,mounted:mounted!==null,method,outcome});
    return {found:outcome==="verified",outcome};
  }
  async function jump(args) {
    const j=job;
    if(!j || j.status==="running" || j.navBusy || j.verification?.running)throw new Error("Finish the current operation first.");
    const hits=ordered(j),index=args.index;
    const hit=hits[index];
    if(!Number.isInteger(index)||!hit)throw new Error("Result is no longer available.");
    if(!j.root.isConnected)throw new Error("Scroll container disappeared.");
    j.navBusy=true;
    let cancelled=false, session;
    const events=["wheel","touchstart","pointerdown","keydown"];
    const interrupt=e=>{if(e.isTrusted && (e.type!=="keydown" || ["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(e.key)))cancelled=true;};
    for(const type of events)window.addEventListener(type,interrupt,{capture:true,passive:true});
    try {
      session=navigationSession(j,()=>cancelled);
      return await navigate(j,hit,index,session);
    }finally{
      session?.close();
      for(const type of events)window.removeEventListener(type,interrupt,true);
      j.navBusy=false;
    }
  }
  function verifyAll() {
    const j=job;
    if(!j || j.status==="running" || j.navBusy || j.verification?.running)throw new Error("Finish the current operation first.");
    if(!j.root.isConnected)throw new Error("Scroll container disappeared.");
    const hits=ordered(j), limit=Math.min(hits.length,100), original=j.root.scrollTop;
    const v=j.verification={running:true,cancel:false,manual:false,total:hits.length,limit,checked:0,verified:0,approximate:0,notFound:0,results:[]};
    const events=["wheel","touchstart","pointerdown","keydown"];
    const interrupt=e=>{if(e.isTrusted && (e.type!=="keydown" || ["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(e.key))){v.cancel=true;v.manual=true;}};
    async function runVerification(){
      log(j,"verify-start",{total:hits.length,limit});
      for(const type of events)window.addEventListener(type,interrupt,{capture:true,passive:true});
      let session;
      try {
        session=navigationSession(j,()=>v.cancel);
        for(let i=0;i<limit && session.alive();i++){
          const result=await navigate(j,hits[i],i,session);
          if(v.cancel || !j.root.isConnected)break;
          v.checked++;v.results.push(result.outcome);
          if(result.outcome==="verified")v.verified++;
          else if(result.outcome==="approximate")v.approximate++;
          else v.notFound++;
        }
      }catch{v.cancel=true;log(j,"verify-error");}
      finally{
        session?.close();
        if(!v.cancel && v.checked<limit)log(j,"verify-limit",{checked:v.checked,limit});
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
