// Optional live test. No cookies, authentication, screenshots, page text,
// URLs, IDs or raw exception messages are written to CI logs.
import {readFile} from "node:fs/promises";
import {firefox} from "playwright";

const input=process.env.VPF_SHARED_URL;
if(!input){console.log("shared-chat: disabled");process.exit(0);}
let url;
try {
  url=new URL(input);
  if(url.origin!=="https://chatgpt.com" || !/^\/share\/[a-f0-9-]{36}\/?$/i.test(url.pathname) || url.search || url.hash || url.username || url.password)throw new Error();
}catch{console.error("shared-chat: invalid share URL configuration");process.exit(2);}
const expected=process.env.VPF_EXPECTED_COUNT?.trim();
if(expected && !/^\d+$/.test(expected)){console.error("shared-chat: invalid expected count");process.exit(2);}
const query="yesterday";
// Independent, user-supplied oracle for the configured test snapshot.
// Berlin clock minutes for six occurrences, in their original order.
// Only ordinal numbers, never recovered label text or IDs, enter CI output.
const timezone=process.env.VPF_TIMEZONE||"Europe/Berlin";
const oracleMinutes=[46,106,173,225,291,348];
if(!["Europe/Berlin","UTC"].includes(timezone)){console.error("shared-chat: unsupported test timezone");process.exit(2);}
const expectedOrdinals=timezone==="UTC"?[2,3,4,5,6]:[1,2,3,4,5,6];
let browser, stage="browser launch";
try {
  browser=await firefox.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900},timezoneId:timezone,locale:"en-US"});
  // Fixed browser time keeps the relative-date test reproducible; timers
  // continue to run normally. This snapshot was inspected on November 28.
  await page.clock.setFixedTime(new Date("2026-11-28T07:00:00Z"));
  const clock=await page.evaluate(()=>({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,offset:new Date().getTimezoneOffset()}));
  console.log("shared-chat: clock "+JSON.stringify(clock));
  stage="page load";
  const response=await page.goto(url.href,{waitUntil:"domcontentloaded",timeout:45000});
  const status=response?.status()||0;
  console.log("shared-chat: HTTP "+status);
  if(status!==200 || new URL(page.url()).origin!==url.origin || new URL(page.url()).pathname.replace(/\/$/,"")!==url.pathname.replace(/\/$/,"")){
    console.error("shared-chat: access unavailable or redirected");process.exitCode=2;
  }else {
    stage="conversation readiness";
    const marker='[data-message-author-role], [data-testid^="conversation-turn-"], main article';
    await page.locator(marker).first().waitFor({state:"attached",timeout:45000}).catch(()=>{});
    const readiness=await page.evaluate(selector=>{
      const text=document.body?.innerText||"";
      return {conversation:document.querySelectorAll(selector).length,
        challenge:/verify you are human|checking your browser|just a moment|enable javascript and cookies|access denied/i.test(text.slice(0,2000)),
        unavailable:/unable to load conversation|conversation not found|this shared conversation is no longer available/i.test(text.slice(0,2000))};
    },marker);
    console.log("shared-chat: readiness "+JSON.stringify(readiness));
    if(!readiness.conversation||readiness.challenge||readiness.unavailable){
      console.error("shared-chat: no confirmed conversation DOM; no bypass attempted");process.exitCode=2;
    }else{
      stage="inject scanner";
      for(const path of ["../src/core.js","../src/engine.js"]){
        const source=await readFile(new URL(path,import.meta.url),"utf8");
        await page.evaluate(source);
      }
      stage="discover";
      const containers=await page.evaluate(()=>globalThis.__virtualPageFindV1.discover());
      // No labels: they may contain application-specific IDs.
      console.log("shared-chat: candidates "+JSON.stringify(containers.map(({id,height,range})=>({id,height,range}))));
      const candidate=containers.find(c=>c.range>0);
      if(!candidate)throw new Error("no scrolling container");
      stage="scan";
      // Sample only the structural shape around matching text while the
      // virtualizer mounts rows. Never serialize attribute values or text.
      await page.evaluate(({query,oracleMinutes,timezone})=>{
        const shapes=new Set(), observed=new Set(), observedOtherDay=new Set();
        function ordinal(text,requireYesterday=true){
          const s=text.replace(/[\[\]]/g,"");
          const m=s.match(requireYesterday?/yesterday\s*(\d{1,2}):(\d{2})\s*([AP]M)\b/i:/\b(\d{1,2}):(\d{2})\s*([AP]M)\b/i);
          if(!m)return 0;
          const mins=(Number(m[1])%12+(m[3].toUpperCase()==="PM"?12:0))*60+Number(m[2]);
          return oracleMinutes.indexOf((mins+(timezone==="UTC"?60:0))%1440)+1;
        }
        const attrs=["id","data-message-id","data-turn-id","data-item-id","data-testid","data-message-author-role","data-index","data-key","data-turn","role","aria-label","datetime"];
        const tags=new Set(["div","span","time","article","section","main","p","li","button","header","footer"]);
        const inspect=()=>{
          const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
          for(let node=w.nextNode();node;node=w.nextNode()){
            const label=node.parentElement?.closest("[role][aria-label]");
            if(label){
              const t=label.textContent||"";
              if(t.length<=160){
                const y=ordinal(t);
                if(y)observed.add(y);
                else if(!/yesterday/i.test(t)){const o=ordinal(t,false);if(o)observedOtherDay.add(o);}
              }
            }
            if(!node.data.toLowerCase().includes(query))continue;
            const range=document.createRange();range.selectNodeContents(node);
            if(!Array.from(range.getClientRects()).some(r=>r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight))continue;
            const chain=[];
            for(let p=node.parentElement;p&&chain.length<12;p=p.parentElement){
              const present=attrs.filter(a=>p.hasAttribute(a));
              const testId=p.getAttribute("data-testid")||"";
              const kind=/^conversation-turn-\d+$/.test(testId)?"turn-number":/^conversation-turn-/.test(testId)?"turn-other":"";
              const records={};
              if(chain.length>=3 && chain.length<=7){
                for(const attr of ["data-message-id","data-turn-id","data-item-id"]){
                  const n=p.querySelectorAll("["+attr+"]").length;
                  if(n)records[attr]=Math.min(n,20);
                }
                const turns=Array.from(p.querySelectorAll("[data-testid^='conversation-turn-']"));
                if(turns.length)records.turns=Math.min(turns.length,20);
                const numbered=turns.filter(e=>/^conversation-turn-\d+$/.test(e.getAttribute("data-testid")||"")).length;
                if(numbered)records.numberedTurns=Math.min(numbered,20);
                const turn=p.querySelectorAll("[data-turn-id]");
                if(turn.length===1){
                  const node=turn[0],value=node.getAttribute("data-turn-id");
                  let depth=0;for(let q=node;q&&q!==p;q=q.parentElement)depth++;
                  records.turnDepth=depth;
                  records.valuePresent=!!value;
                  records.uniqueValue=!!value&&document.querySelectorAll('[data-turn-id="'+CSS.escape(value)+'"]').length===1;
                  let a=node,b=node;
                  while(a.parentElement && a.parentElement!==p)a=a.parentElement;
                  b=w.currentNode.parentElement;
                  while(b.parentElement && b.parentElement!==p)b=b.parentElement;
                  records.separateBranch=a!==b;
                }
              }
              chain.push({tag:tags.has(p.localName)?p.localName:"other",attrs:present,kind,records});
            }
            if(shapes.size<24)shapes.add(JSON.stringify(chain));
          }
        };
        const buckets=new Map();
        let scroller=document.scrollingElement||document.documentElement;
        const onScroll=e=>{if(e.target instanceof Element)scroller=e.target;};
        document.addEventListener("scroll",onScroll,true);
        const observer=new MutationObserver(records=>{
          const root=scroller;
          const pos=Math.round(root.scrollTop/50)*50;
          if(!buckets.has(pos)&&buckets.size>=200)return;
          const b=buckets.get(pos)||{top:pos,records:0,visible:0,hidden:0,svg:0,characterData:0,childList:0,textChanging:0,emptyChanging:0};
          for(const record of records){
            b.records++;
            const target=record.target.nodeType===1?record.target:record.target.parentElement;
            if(!target)continue;
            const rect=target.getBoundingClientRect();
            if(rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight)b.visible++;else b.hidden++;
            if(target.closest("svg"))b.svg++;
            if(record.type==="characterData"){b.characterData++;b.textChanging++;}
            else{
              b.childList++;
              const nodes=[...record.addedNodes,...record.removedNodes];
              if(nodes.some(n=>(n.textContent||"").trim()))b.textChanging++;else b.emptyChanging++;
            }
          }
          buckets.set(pos,b);
        });
        observer.observe(document.documentElement,{childList:true,characterData:true,subtree:true});
        const timer=setInterval(inspect,200);inspect();
        globalThis.__vpfLiveProbe=()=>{clearInterval(timer);observer.disconnect();document.removeEventListener("scroll",onScroll,true);return {shapes:[...shapes].map(s=>JSON.parse(s)),busyViews:[...buckets.values()].sort((a,b)=>b.records-a.records).slice(0,5),observed:[...observed].sort((a,b)=>a-b),observedOtherDay:[...observedOtherDay].sort((a,b)=>a-b)};};
      },{query,oracleMinutes,timezone});
      await page.evaluate(({id,query})=>globalThis.__virtualPageFindV1.start({id,query,pace:"normal",rescan:true}),{id:candidate.id,query});
      await page.waitForFunction(()=>globalThis.__virtualPageFindV1.snapshot().status!=="running",null,{timeout:190000});
      const scan=await page.evaluate(({oracleMinutes,timezone})=>{
        const s=globalThis.__virtualPageFindV1.snapshot();
        const ordinals=s.hits.map(h=>{
          const m=h.context.replace(/[\[\]]/g,"").match(/yesterday\s*(\d{1,2}):(\d{2})\s*([AP]M)\b/i);
          if(!m)return 0;
          const mins=(Number(m[1])%12+(m[3].toUpperCase()==="PM"?12:0))*60+Number(m[2]);
          return oracleMinutes.indexOf((mins+(timezone==="UTC"?60:0))%1440)+1;
        });
        const attrs={};
        for(const h of s.hits){const attr=h.anchor?.attr?(h.anchor.up?"sibling-":"")+h.anchor.attr:"none";attrs[attr]=(attrs[attr]||0)+1;}
        return {status:s.status,matches:s.hits.length,steps:s.steps,pass:s.pass,layoutChanges:s.layoutChanges,finalLayoutChanges:s.finalLayoutChanges,anchorTypes:attrs,positions:s.hits.map(h=>h.y),ordinals};
      },{oracleMinutes,timezone});
      console.log("shared-chat: scan "+JSON.stringify(scan));
      const shapes=await page.evaluate(()=>globalThis.__vpfLiveProbe());
      console.log("shared-chat: match ancestor shapes "+JSON.stringify(shapes.shapes));
      console.log("shared-chat: mutation summary "+JSON.stringify(shapes.busyViews));
      const oracleOK=JSON.stringify(scan.ordinals)===JSON.stringify(expectedOrdinals);
      console.log("shared-chat: oracle "+JSON.stringify({expected:expectedOrdinals,engine:scan.ordinals,independentMounted:shapes.observed,otherDay:shapes.observedOtherDay,ok:oracleOK}));
      const scanLog=await page.evaluate(()=>globalThis.__virtualPageFindV1.diagnostics());
      const safeReasons=new Map([
        ["Could not establish a stable top; earlier content may be missing.","unstable-top"],
        ["Some views did not settle; asynchronous content may have been missed.","settle-timeout"],
        ["Page moved backwards during scan; completeness is uncertain.","backward-motion"],
        ["Scrolling stalled (possibly scroll snapping or page interference).","stalled"],
        ["A scroll jump exceeded one viewport; some content may have been skipped.","viewport-gap"],
        ["Second pass incomplete; showing first-pass results.","retry-incomplete"],
        ["Scan safety limit reached.","scan-limit"],
        ["Selected container became invisible.","invisible"],
        ["Selected container is no longer visible.","invisible"],
        ["Selected scroll container was removed.","removed"],
        ["DOM inspection limit reached.","dom-limit"],
        ["Result limit reached.","result-limit"],
        ["Scan error (details omitted)","scan-error"]
      ]);
      const scanEvents=/^\d+ms (?:start|finding-top|top-check|scanning|range-change|view|scroll|settle|bottom-check|final-view|rescan-start|rescan-finished|restore|finished) (.*)$/;
      const scanField=/^(?:step|steps|pass|passes|top|rawTop|range|oldRange|height|viewHeight|newHits|totalHits|hits|anchoredHits|layoutChanges|finalLayoutChanges|from|to|target|actual|requested|attempt|stable|mutations|ignoredMutations|waitMs|collectMs|firstHits|firstWarnings|changes|minimumWait)=-?\d+$|^(?:reachedEnd|firstReachedEnd|manual|reverse)=(?:true|false)$|^reason=(?:quiet|timeout|interrupted)$|^status=(?:partial|traversed|layout-uncertain)$|^pace=(?:fast|normal|slow)$/;
      for(const line of scanLog.split("\n")){
        const warning=line.match(/^(\d+ms warning) reason=(.*)$/);
        if(warning){console.log(warning[1]+" code="+(safeReasons.get(warning[2])||"other"));continue;}
        const m=line.match(scanEvents);
        if(m)console.log(line.slice(0,line.length-m[1].length)+m[1].split(" ").filter(token=>scanField.test(token)).join(" "));
      }
      if(!oracleOK || scan.status==="partial" || (timezone==="Europe/Berlin" && expected && scan.matches!==Number(expected)))process.exitCode=1;
      if(scan.matches){
        stage="verify";
        await page.evaluate(()=>globalThis.__virtualPageFindV1.verifyAll());
        await page.waitForFunction(()=>!globalThis.__virtualPageFindV1.snapshot().verification.running,null,{timeout:190000});
        const v=await page.evaluate(()=>globalThis.__virtualPageFindV1.snapshot().verification);
        console.log("shared-chat: verification "+JSON.stringify({checked:v.checked,verified:v.verified,approximate:v.approximate,notFound:v.notFound,total:v.total,cancelled:v.cancel,results:v.results}));
        // Only allow fixed events/fields to reach public CI output, even if
        // the underlying diagnostic implementation later gains more fields.
        const log=await page.evaluate(()=>globalThis.__virtualPageFindV1.diagnostics());
        const event=/^\d+ms (?:jump-direct|jump-replay-start|jump-replay-scroll|jump-replay-view|jump-replay-gap|jump-replay-busy|jump-local|jump|verify-finished) (.*)$/;
        const allowed=/^(?:index|savedY|target|actual|range|from|top|checked|verified|approximate|notFound)=-?\d+$|^(?:anchored|mounted|settled|cancelled)=(?:true|false)$|^method=(?:direct|replay|visible|local)$|^settleState=(?:quiet|geometry-quiet|target-visible|interrupted)$|^outcome=(?:verified|approximate|not-found)$/;
        for(const line of log.split("\n")){
          const m=line.match(event);
          if(m)console.log(line.slice(0,line.length-m[1].length)+m[1].split(" ").filter(token=>allowed.test(token)).join(" "));
        }
        if(v.cancel||v.checked!==v.total||v.verified!==v.total||v.notFound)process.exitCode=1;
        if(timezone==="Europe/Berlin" && oracleOK && v.verified===v.total){
          stage="individual navigation";
          // Exercise actual popup-style individual jump calls, not the
          // verification batch's forward-only shared replay cursor.
          for(const ordinal of [5,3,3]){
            const index=scan.ordinals.indexOf(ordinal);
            const trace=await page.evaluate(async ({index,ordinal,oracleMinutes})=>{
              const engine=globalThis.__virtualPageFindV1;
              const targetMinutes=oracleMinutes[ordinal-1];
              function visible(){
                for(const label of document.querySelectorAll("[role][aria-label]")){
                  const t=(label.textContent||"").trim();
                  if(t.length>160)continue;
                  const m=t.match(/^yesterday\s*(\d{1,2}):(\d{2})\s*([AP]M)$/i);
                  if(!m || (Number(m[1])%12+(m[3].toUpperCase()==="PM"?12:0))*60+Number(m[2])!==targetMinutes)continue;
                  const range=document.createRange();range.selectNodeContents(label);
                  for(const rect of range.getClientRects()){
                    if(rect.width<=0||rect.height<=0||rect.bottom<=0||rect.top>=innerHeight||rect.right<=0||rect.left>=innerWidth)continue;
                    let top=0,bottom=innerHeight,left=0,right=innerWidth;
                    for(let p=label;p;p=p.parentElement){
                      const s=getComputedStyle(p),r=p.getBoundingClientRect();
                      if(/auto|scroll|hidden|clip|overlay/.test(s.overflowY)){top=Math.max(top,r.top+p.clientTop);bottom=Math.min(bottom,r.top+p.clientTop+p.clientHeight);}
                      if(/auto|scroll|hidden|clip|overlay/.test(s.overflowX)){left=Math.max(left,r.left+p.clientLeft);right=Math.min(right,r.left+p.clientLeft+p.clientWidth);}
                    }
                    if(rect.bottom>top&&rect.top<bottom&&rect.right>left&&rect.left<right)return true;
                  }
                }
                return false;
              }
              const previousLines=engine.diagnostics().split("\n").length;
              const started=performance.now(),before=engine.snapshot().position,visibleBefore=visible();
              let seen=visibleBefore,lostAfterSeen=false,returnedToTopAfterSeen=false,firstSeenMs=visibleBefore?0:null,samples=0;
              function sample(){
                samples++;
                const now=visible(),pos=engine.snapshot().position;
                if(now&&!seen){seen=true;firstSeenMs=Math.round(performance.now()-started);}
                if(seen&&!now)lostAfterSeen=true;
                if(seen&&pos<=2&&before>2)returnedToTopAfterSeen=true;
              }
              const timer=setInterval(sample,80);
              try{
                const result=await engine.jump({index});
                sample();
                const log=engine.diagnostics().split("\n").slice(previousLines);
                const direct=log.filter(l=>l.includes(" jump-direct index="+(index+1)+" ")).at(-1)||"";
                const final=log.filter(l=>l.includes(" jump index="+(index+1)+" ")).at(-1)||"";
                const number=(line,key)=>Number(line.match(new RegExp("\\b"+key+"=(-?\\d+)"))?.[1]??-1);
                return {ordinal,before,after:engine.snapshot().position,visibleBefore,visibleAfter:visible(),seen,lostAfterSeen,returnedToTopAfterSeen,firstSeenMs,samples,elapsedMs:Math.round(performance.now()-started),outcome:result.outcome,
                  direct:direct?{target:number(direct,"target"),actual:number(direct,"actual"),settled:direct.includes("settled=true"),outcome:direct.match(/outcome=(verified|approximate|not-found)/)?.[1]||"unknown"}:null,
                  method:result.method||final.match(/method=(direct|replay|visible|local)/)?.[1]||"unknown"};
              }finally{clearInterval(timer);}
            },{index,ordinal,oracleMinutes});
            console.log("shared-chat: individual jump "+JSON.stringify(trace));
            if(trace.outcome!=="verified"||!trace.visibleAfter)process.exitCode=1;
            if(ordinal===3 && trace.visibleBefore && trace.method!=="visible")process.exitCode=1;
            if(ordinal===3 && trace.method==="replay")process.exitCode=1;
          }
        }

      }
    }
  }
}catch{
  console.error("shared-chat: failed at "+stage+" (details suppressed)");
  process.exitCode=2;
}finally{await browser?.close();}
