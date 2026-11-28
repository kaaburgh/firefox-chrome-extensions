(function popupMain() {
  "use strict";
  const api=globalThis.browser || globalThis.chrome;
  const $=id=>document.getElementById(id);
  let tab, timer, busy=false, last=null, revision="", candidates=[];
  function message(text) {$("message").textContent=text;}
  async function call(command,args={}) {
    const result=await api.scripting.executeScript({target:{tabId:tab.id},func:(cmd,arg)=>{
      const engine=globalThis.__virtualPageFindV1;
      if (!engine) throw new Error("Scanner is missing. Reopen the extension.");
      return engine[cmd](arg);
    },args:[command,args]});
    if (!result.length || result[0].error || result[0].result===undefined) throw new Error("Scanner unavailable. Reopen on an ordinary web page.");
    return result[0].result;
  }
  function render(s) {
    last=s;
    const verifying=!!s.verification?.running, navigating=!!s.navBusy, running=s.status==="running"||verifying||navigating, has=s.status!=="idle";
    $("start").disabled=running || !candidates.length || busy;
    $("stop").disabled=!running || busy || navigating;
    $("query").disabled=running; $("case").disabled=running; $("container").disabled=running; $("pace").disabled=running; $("rescan").disabled=running;
    $("copy").disabled=!s.hits.length || running; $("restore").disabled=!has || running;
    $("clear").disabled=!has || running;
    $("verify").disabled=running || !s.hits.length;
    const v=s.verification;
    $("verification").hidden=!v;
    $("verification").textContent=v ? (v.running?"Verifying… ":"Verification: ")+v.verified+"/"+v.total+" DOM identities verified; "+v.approximate+" approximate, "+v.notFound+" not found; "+v.checked+"/"+v.total+" checked."+(v.limit<v.total?" First 100 only.":"")+(v.cancel?" Stopped.":"") : "";
    const labels={idle:"Ready",running:s.phase,traversed:"Reached both ends (best effort)","layout-uncertain":"Reached both ends — results uncertain (layout changed)",partial:"Incomplete / uncertain"};
    const statusLabel=navigating?"Navigating to result":verifying?"Verifying positions":labels[s.status];
    $("status").textContent=statusLabel+(has?" · "+s.hits.length+" matches · "+s.steps+" views · "+Math.round(s.elapsed/1000)+" s":"");
    $("progress").hidden=!running || navigating;
    $("progress").max=verifying?Math.max(1,v.limit):Math.max(1,s.range||0);
    $("progress").value=verifying?v.checked:Math.max(0,s.position||0);
    $("notes").textContent=s.notes.join(" ");
    $("notes").hidden=!s.notes.length;
    $("layout").hidden=!s.layoutChanges;
    $("layout").textContent=s.layoutChanges ?
      s.status==="traversed" && s.pass===2 && !s.finalLayoutChanges ?
        "The first pass encountered layout changes; the second pass reached both ends without further detected range changes. Positions are still best effort." :
        "Warning: the page resized its scroll area "+s.layoutChanges+" time(s), possibly while loading or rendering content. No user input is required. Matches may be missing or duplicated, and jump positions may be inaccurate." : "";
    $("diagnostics").hidden=!has;
    $("copy-log").disabled=!has;
    const jump=s.lastJump;
    $("last-jump").hidden=!jump;
    $("last-jump").textContent=jump?"Last click: #"+jump.index+" · "+jump.method+" · "+jump.outcome+" · "+(jump.elapsedMs/1000).toFixed(2)+" s":"";
    if (!has) { $("log").value=""; }
    const key=JSON.stringify([running,s.hits,v?.results]);
    if (key!==revision) {
      revision=key;
      const fragment=document.createDocumentFragment();
      for (const [i,h] of s.hits.entries()) {
        const button=document.createElement("button");
        button.type="button"; button.className="result"; button.disabled=running;
        const checked=v?.results?.[i];
        const checkLabel=checked==="verified"?" · Verified":checked==="approximate"?" · Approximate":checked==="not-found"?" · Not found":"";
        button.textContent=(i+1)+". "+h.context+" ("+h.y+" px)"+checkLabel;
        button.addEventListener("click",()=>void perform(async()=>{message("Navigating to result #"+(i+1)+"…");const r=await call("jump",{index:i});render(await call("snapshot"));if($("diagnostics").open)await refreshLog();message(r.found?"DOM identity verified.":r.outcome==="approximate"?"Approximate position: identical text, identity not verified.":"Target could not be verified.");}));
        fragment.append(button);
      }
      $("results").replaceChildren(fragment);
    }
  }
  async function refreshCandidates() {
    const list=await call("discover"); if(!list) return;
    candidates=list;
    $("container").replaceChildren(...list.map(c=>{const o=document.createElement("option");o.value=String(c.id);o.textContent=c.label+" · "+c.height+" px view / "+c.range+" px scroll";return o;}));
  }
  async function refreshLog() {
    if (!$("diagnostics").open || !last || last.status==="idle") return;
    const value=await call("diagnostics");
    const log=$("log");
    if (log.value!==value) {
      const follow=log.scrollHeight-log.clientHeight-log.scrollTop<24;
      log.value=value;
      if (follow) log.scrollTop=log.scrollHeight;
    }
    $("copy-log").disabled=!value;
  }
  async function poll() {
    if (busy) return;
    busy=true;
    try {
      const s=await call("snapshot");
      if((last?.status==="running"||last?.verification?.running||last?.navBusy) && s.status!=="running" && !s.verification?.running && !s.navBusy) await refreshCandidates();
      busy=false; render(s);
      if ($("diagnostics").open) {
        busy=true;
        try { await refreshLog(); } finally {busy=false;}
      }
    } catch(e) {busy=false; clearInterval(timer); message(e.message);}
  }
  async function perform(fn) {
    if(busy) return;
    busy=true; message("");
    try { await fn(); } catch(e) {message(e.message);}
    finally {busy=false; if(last) render(last);}
  }
  $("form").addEventListener("submit",e=>{e.preventDefault();void perform(async()=>{
    render(await call("start",{id:Number($("container").value),query:$("query").value,sensitive:$("case").checked,pace:$("pace").value,rescan:$("rescan").checked}));
  });});
  $("stop").addEventListener("click",()=>void perform(async()=>render(await call("stop"))));
  $("verify").addEventListener("click",()=>void perform(async()=>render(await call("verifyAll"))));
  $("restore").addEventListener("click",()=>void perform(async()=>render(await call("restore"))));
  $("clear").addEventListener("click",()=>void perform(async()=>{render(await call("clear"));$("query").value="";}));
  $("diagnostics").addEventListener("toggle",()=>{if ($("diagnostics").open) void poll();});
  $("copy-log").addEventListener("click",async()=>{
    try {
      // Fetch the live content-script journal, not the last polled textarea.
      const value=await call("diagnostics");
      $("log").value=value;
      await navigator.clipboard.writeText(value);message("Diagnostic log copied.");
    }catch(e){
      $("diagnostics").open=true;$("log").focus();$("log").select();
      message("Clipboard unavailable. Copy the selected diagnostic log manually.");
    }
  });
  $("copy").addEventListener("click",async()=>{
    try {await navigator.clipboard.writeText(last.hits.map((h,i)=>(i+1)+". "+h.context+" ["+h.y+" px]").join("\n"));message("Copied.");}
    catch(e){message("Clipboard unavailable: "+e.message);}
  });
  (async()=>{
    try {
      [tab]=await api.tabs.query({active:true,currentWindow:true});
      if (!tab?.id) throw new Error("No active tab.");
      await api.scripting.executeScript({target:{tabId:tab.id},files:["core.js","engine.js"]});
      const s=await call("snapshot");
      if (s.query) { $("query").value=s.query; $("case").checked=s.sensitive; $("pace").value=s.pace || "normal"; $("rescan").checked=s.rescan!==false; }
      await refreshCandidates();render(s);
      if ($("diagnostics").open) await refreshLog();
      timer=setInterval(poll,400);
      if(s.status!=="running") $("query").focus();
    } catch(e) {message("Cannot open scanner: "+e.message);}
  })();
})();
