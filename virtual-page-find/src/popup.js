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
    const running=s.status==="running", has=s.status!=="idle";
    $("start").disabled=running || !candidates.length || busy;
    $("stop").disabled=!running || busy;
    $("query").disabled=running; $("case").disabled=running; $("container").disabled=running; $("pace").disabled=running;
    $("copy").disabled=!s.hits.length || running; $("restore").disabled=!has || running;
    $("clear").disabled=!has || running;
    const labels={idle:"Ready",running:s.phase,traversed:"Reached both ends (best effort)",partial:"Incomplete / uncertain"};
    const statusLabel=s.status==="traversed" && s.layoutChanges ? "Reached both ends (layout changed; best effort)" : labels[s.status];
    $("status").textContent=statusLabel+(has?" · "+s.hits.length+" matches · "+s.steps+" views · "+Math.round(s.elapsed/1000)+" s":"");
    $("progress").hidden=!running;
    $("progress").max=Math.max(1,s.range||0);
    $("progress").value=Math.max(0,s.position||0);
    $("notes").textContent=s.notes.join(" ");
    $("notes").hidden=!s.notes.length;
    $("layout").hidden=!s.layoutChanges;
    $("layout").textContent=s.layoutChanges ?
      "The page resized its scroll area "+s.layoutChanges+" time(s), possibly while loading or rendering content. No user input is required for this. Match counts and jump positions remain best effort." : "";
    const key=JSON.stringify([running,s.hits]);
    if (key!==revision) {
      revision=key;
      const fragment=document.createDocumentFragment();
      for (const [i,h] of s.hits.entries()) {
        const button=document.createElement("button");
        button.type="button"; button.className="result"; button.disabled=running;
        button.textContent=(i+1)+". "+h.context+" ("+h.y+" px)";
        button.addEventListener("click",async()=>{try { const r=await call("jump",{hit:h}); message(r.found?"Match visible.":"Approximate position only: match could not be verified."); } catch(e){message(e.message);} });
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
  async function poll() {
    if (busy) return;
    busy=true;
    try {
      const s=await call("snapshot");
      if(last?.status==="running" && s.status!=="running") await refreshCandidates();
      busy=false; render(s);
    } catch(e) {busy=false; clearInterval(timer); message(e.message);}
  }
  async function perform(fn) {
    if(busy) return;
    busy=true; message("");
    try { await fn(); } catch(e) {message(e.message);}
    finally {busy=false; if(last) render(last);}
  }
  $("form").addEventListener("submit",e=>{e.preventDefault();void perform(async()=>{
    render(await call("start",{id:Number($("container").value),query:$("query").value,sensitive:$("case").checked,pace:$("pace").value}));
  });});
  $("stop").addEventListener("click",()=>void perform(async()=>render(await call("stop"))));
  $("restore").addEventListener("click",()=>void perform(async()=>render(await call("restore"))));
  $("clear").addEventListener("click",()=>void perform(async()=>{render(await call("clear"));$("query").value="";}));
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
      if (s.query) { $("query").value=s.query; $("case").checked=s.sensitive; $("pace").value=s.pace || "normal"; }
      await refreshCandidates();render(s);
      timer=setInterval(poll,400);
      if(s.status!=="running") $("query").focus();
    } catch(e) {message("Cannot open scanner: "+e.message);}
  })();
})();
