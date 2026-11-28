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
let browser, stage="browser launch";
try {
  browser=await firefox.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
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
      await page.evaluate(query=>{
        const shapes=new Set();
        const attrs=["id","data-message-id","data-turn-id","data-item-id","data-testid","data-message-author-role","data-index","data-key","data-turn","role","aria-label","datetime"];
        const tags=new Set(["div","span","time","article","section","main","p","li","button","header","footer"]);
        const inspect=()=>{
          const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
          for(let node=w.nextNode();node;node=w.nextNode()){
            if(!node.data.toLowerCase().includes(query))continue;
            const range=document.createRange();range.selectNodeContents(node);
            if(!Array.from(range.getClientRects()).some(r=>r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight))continue;
            const chain=[];
            for(let p=node.parentElement;p&&chain.length<12;p=p.parentElement){
              const present=attrs.filter(a=>p.hasAttribute(a));
              const testId=p.getAttribute("data-testid")||"";
              const kind=/^conversation-turn-\d+$/.test(testId)?"turn-number":/^conversation-turn-/.test(testId)?"turn-other":"";
              chain.push({tag:tags.has(p.localName)?p.localName:"other",attrs:present,kind,
                siblingMessage:!!p.querySelector("[data-message-id], [data-turn-id], [data-testid^='conversation-turn-']")});
            }
            if(shapes.size<24)shapes.add(JSON.stringify(chain));
          }
        };
        const timer=setInterval(inspect,200);inspect();
        globalThis.__vpfLiveProbe=()=>{clearInterval(timer);return [...shapes].map(s=>JSON.parse(s));};
      },query);
      await page.evaluate(({id,query})=>globalThis.__virtualPageFindV1.start({id,query,pace:"normal",rescan:true}),{id:candidate.id,query});
      await page.waitForFunction(()=>globalThis.__virtualPageFindV1.snapshot().status!=="running",null,{timeout:190000});
      const scan=await page.evaluate(()=>{
        const s=globalThis.__virtualPageFindV1.snapshot();
        const attrs={};
        for(const h of s.hits){const attr=h.anchor?.attr||"none";attrs[attr]=(attrs[attr]||0)+1;}
        return {status:s.status,matches:s.hits.length,steps:s.steps,pass:s.pass,layoutChanges:s.layoutChanges,finalLayoutChanges:s.finalLayoutChanges,anchorTypes:attrs,positions:s.hits.map(h=>h.y)};
      });
      console.log("shared-chat: scan "+JSON.stringify(scan));
      const shapes=await page.evaluate(()=>globalThis.__vpfLiveProbe());
      console.log("shared-chat: match ancestor shapes "+JSON.stringify(shapes));
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
      const scanField=/^(?:step|steps|pass|passes|top|rawTop|range|oldRange|height|viewHeight|newHits|totalHits|hits|anchoredHits|layoutChanges|finalLayoutChanges|from|to|target|actual|requested|attempt|stable|mutations|waitMs|collectMs|firstHits|firstWarnings|changes|minimumWait)=-?\d+$|^(?:reachedEnd|firstReachedEnd|manual|reverse)=(?:true|false)$|^reason=(?:quiet|timeout|interrupted)$|^status=(?:partial|traversed|layout-uncertain)$|^pace=(?:fast|normal|slow)$/;
      for(const line of scanLog.split("\n")){
        const warning=line.match(/^(\d+ms warning) reason=(.*)$/);
        if(warning){console.log(warning[1]+" code="+(safeReasons.get(warning[2])||"other"));continue;}
        const m=line.match(scanEvents);
        if(m)console.log(line.slice(0,line.length-m[1].length)+m[1].split(" ").filter(token=>scanField.test(token)).join(" "));
      }
      if(!scan.matches || scan.status==="partial" || (expected && scan.matches!==Number(expected)))process.exitCode=1;
      if(scan.matches){
        stage="verify";
        await page.evaluate(()=>globalThis.__virtualPageFindV1.verifyAll());
        await page.waitForFunction(()=>!globalThis.__virtualPageFindV1.snapshot().verification.running,null,{timeout:190000});
        const v=await page.evaluate(()=>globalThis.__virtualPageFindV1.snapshot().verification);
        console.log("shared-chat: verification "+JSON.stringify({checked:v.checked,verified:v.verified,approximate:v.approximate,notFound:v.notFound,total:v.total,cancelled:v.cancel,results:v.results}));
        // Only allow fixed events/fields to reach public CI output, even if
        // the underlying diagnostic implementation later gains more fields.
        const log=await page.evaluate(()=>globalThis.__virtualPageFindV1.diagnostics());
        const event=/^\d+ms (?:jump-direct|jump-replay-start|jump-replay-scroll|jump-replay-view|jump-replay-gap|jump|verify-finished) (.*)$/;
        const allowed=/^(?:index|savedY|target|actual|range|from|top|checked|verified|approximate|notFound)=-?\d+$|^(?:anchored|mounted|settled|cancelled)=(?:true|false)$|^method=(?:direct|replay)$|^outcome=(?:verified|approximate|not-found)$/;
        for(const line of log.split("\n")){
          const m=line.match(event);
          if(m)console.log(line.slice(0,line.length-m[1].length)+m[1].split(" ").filter(token=>allowed.test(token)).join(" "));
        }
        if(v.cancel||v.checked!==v.total||v.notFound)process.exitCode=1;
      }
    }
  }
}catch{
  console.error("shared-chat: failed at "+stage+" (details suppressed)");
  process.exitCode=2;
}finally{await browser?.close();}
