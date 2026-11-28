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
      await page.evaluate(({id,query})=>globalThis.__virtualPageFindV1.start({id,query,pace:"normal",rescan:true}),{id:candidate.id,query});
      await page.waitForFunction(()=>globalThis.__virtualPageFindV1.snapshot().status!=="running",null,{timeout:190000});
      const scan=await page.evaluate(()=>{
        const s=globalThis.__virtualPageFindV1.snapshot();
        const attrs={};
        for(const h of s.hits){const attr=h.anchor?.attr||"none";attrs[attr]=(attrs[attr]||0)+1;}
        return {status:s.status,matches:s.hits.length,steps:s.steps,pass:s.pass,layoutChanges:s.layoutChanges,finalLayoutChanges:s.finalLayoutChanges,anchorTypes:attrs,positions:s.hits.map(h=>h.y)};
      });
      console.log("shared-chat: scan "+JSON.stringify(scan));
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
