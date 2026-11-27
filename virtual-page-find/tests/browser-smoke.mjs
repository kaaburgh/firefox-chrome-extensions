// Optional development-only dependency: npm install --no-save --package-lock=false playwright@1.56.1
// Run: node tests/browser-smoke.mjs [chromium|firefox|all]
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {readFile} from "node:fs/promises";
import {createServer} from "node:http";
import {chromium, firefox} from "playwright";

const base = new URL("../", import.meta.url);
const fixture = await readFile(new URL("tests/virtual-list.html", base));
const server = createServer((req, res) => {
  res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
  res.end(fixture);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port;
const requested = process.argv[2] || "all";
if (!["all","chromium","firefox"].includes(requested)) throw Error("Invalid browser");
async function test(name, browserType) {
  const browser = await browserType.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1100,height:900}});
    await page.goto(url);
    for (const path of ["src/core.js","src/engine.js"])
      await page.addScriptTag({path:fileURLToPath(new URL(path,base))});
    const initial = await page.locator("#list").evaluate(el=>el.scrollTop);
    assert.equal(initial,7200);
    const containers = await page.evaluate(()=>window.__virtualPageFindV1.discover());
    assert.equal(containers[0].label,"div#list");
    assert.ok(containers.some(c=>c.label==="div#side"));
    async function scan(sensitive, expected) {
      await page.evaluate(({id,sensitive})=>window.__virtualPageFindV1.start({id,query:"Yesterday",sensitive,pace:"fast"}),{id:containers[0].id,sensitive});
      await page.waitForFunction(()=>window.__virtualPageFindV1.snapshot().status!=="running",null,{timeout:90000});
      const s = await page.evaluate(()=>window.__virtualPageFindV1.snapshot());
      assert.equal(s.status,"traversed",s.notes.join("; "));
      assert.equal(s.hits.length,expected,JSON.stringify(s.hits));
      assert.equal(await page.locator("#list").evaluate(el=>el.scrollTop),initial);
      const rows = s.hits.map(h=>Math.floor(h.y/48));
      assert.deepEqual(rows,sensitive?[0,18,19,75,149,299]:[0,18,19,75,149,220,299]);
      return s;
    }
    const s = await scan(false,7);
    const jump = await page.evaluate(hit=>window.__virtualPageFindV1.jump({index:3}));
    assert.equal(jump.found,true);
    await page.evaluate(()=>window.__virtualPageFindV1.restore());
    await scan(true,6);
    await page.evaluate(id=>window.__virtualPageFindV1.start({id,query:"Yesterday",pace:"fast"}),containers[0].id);
    await page.waitForTimeout(1000);
    await page.evaluate(()=>window.__virtualPageFindV1.stop());
    await page.waitForFunction(()=>window.__virtualPageFindV1.snapshot().status!=="running",null,{timeout:5000});
    const stopped=await page.evaluate(()=>window.__virtualPageFindV1.snapshot());
    assert.equal(stopped.status,"partial");
    assert.ok(stopped.notes.includes("Stopped by user."));
    assert.equal(await page.locator("#list").evaluate(el=>el.scrollTop),initial);
    console.log(name+": passed container discovery, seven/six matches, inline split, repeated labels, jump, restoration, cancellation");
    await reviewRegressions(page, name);
    await navigationRegressions(page,name);
    await popupSizing(page, name);
    await popupDiagnostics(page, name);
  } finally { await browser.close(); }
}

async function reviewRegressions(page,name) {
  async function setup(markup) {
    await page.setContent('<!doctype html><style>body{margin:0;font:16px sans-serif}#review-list{height:200px;width:400px;overflow:auto;overflow-anchor:none}</style>'+markup);
    return page.evaluate(()=>window.__virtualPageFindV1.discover().find(c=>c.label==="div#review-list").id);
  }
  async function scan(id, pace="normal", expectedStatus="traversed") {
    const before=await page.locator("#review-list").evaluate(el=>el.scrollTop);
    await page.evaluate(({id,pace})=>window.__virtualPageFindV1.start({id,query:"Yesterday",pace,rescan:false}),{id,pace});
    await page.waitForFunction(()=>window.__virtualPageFindV1.snapshot().status!=="running",null,{timeout:90000});
    const s=await page.evaluate(()=>window.__virtualPageFindV1.snapshot());
    assert.equal(s.status,expectedStatus,s.notes.join("; "));
    assert.equal(await page.locator("#review-list").evaluate(el=>el.scrollTop),before);
    return s;
  }
  const delayed=await setup(`<div id="review-list"><div id="space" style="height:1800px;position:relative"></div></div>
    <script>
    (()=>{const el=document.querySelector("#review-list"),space=document.querySelector("#space");let timer;
    function draw(){const first=Math.max(0,Math.floor(el.scrollTop/40)-1);const items=[];
      for(let i=first;i<Math.min(45,first+8);i++){const row=document.createElement("div");row.style.cssText="position:absolute;top:"+i*40+"px;height:40px;left:0;right:0";row.textContent=i===20?"Yesterday":"Row "+i;items.push(row);}
      space.replaceChildren(...items);}
    el.addEventListener("scroll",()=>{clearTimeout(timer);timer=setTimeout(draw,350);});draw();})();
    </script>`);
  let s=await scan(delayed);
  assert.equal(s.hits.length,1,JSON.stringify(s.hits));
  assert.equal(Math.floor(s.hits[0].y/40),20);
  assert.equal(s.pace,"normal");

  const sticky=await setup('<div id="review-list"><div id="sticky-label" style="position:sticky;top:0;background:white">Yesterday Yesterday</div><div style="height:900px"></div><div>Yesterday</div></div>');
  s=await scan(sticky,"fast");
  assert.equal(s.hits.length,3,JSON.stringify(s.hits));
  assert.equal(s.hits.filter(h=>h.pinnedKey).length,2);
  assert.equal((await page.evaluate(()=>window.__virtualPageFindV1.jump({index:0}))).found,true);

  const reverse=await setup('<div id="review-list" style="display:flex;flex-direction:column-reverse"><div id="newest" style="flex:none;height:900px">Yesterday newest</div><div id="oldest" style="flex:none;height:50px">Yesterday oldest</div></div>');
  await page.locator("#review-list").evaluate(el=>{el.scrollTop=-100;});
  s=await scan(reverse,"fast");
  assert.equal(s.hits.length,2,JSON.stringify(s.hits));
  assert.ok(s.hits[0].context.includes("oldest"));
  assert.ok(s.hits[1].context.includes("newest"));
  assert.equal((await page.evaluate(()=>window.__virtualPageFindV1.jump({index:0}))).found,true);
  await page.evaluate(()=>window.__virtualPageFindV1.restore());
  assert.equal(await page.locator("#review-list").evaluate(el=>el.scrollTop),-100);

  const clipped=await setup('<div id="review-list"><div style="height:10px;overflow:hidden"><div style="height:30px"></div><div>Yesterday</div></div><div style="height:500px"></div><div>Yesterday visible</div></div>');
  s=await scan(clipped,"fast");
  assert.equal(s.hits.length,1,JSON.stringify(s.hits));
  assert.ok(s.hits[0].context.includes("visible"));
  console.log(name+": passed 350ms debounce, pinned duplicate prevention, reverse-flow traversal/restoration, overflow clipping");

  const growing=await setup(`<div id="review-list"><div>Yesterday first</div><div style="height:500px"></div></div>
    <script>(()=>{const el=document.querySelector("#review-list");let appended=false;
      el.addEventListener("scroll",()=>{if(!appended && el.scrollTop>0){appended=true;
        const row=document.createElement("div");row.textContent="Yesterday appended";el.append(row);}});})();</script>`);
  s=await scan(growing,"fast","layout-uncertain");
  assert.equal(s.hits.length,2,JSON.stringify(s.hits));
  assert.ok(s.layoutChanges>=1);
  assert.equal(s.notes.length,0);
  assert.ok(s.hits[1].context.includes("appended"));

  // Prepending above the current viewport may silently miss a new label and
  // count a moved existing label twice, even if the total count looks correct.
  const prepending=await setup(`<div id="review-list"><div style="height:150px"></div><div>Yesterday existing</div><div style="height:900px"></div></div>
    <script>(()=>{const el=document.querySelector("#review-list");let inserted=false;
      el.addEventListener("scroll",()=>{if(!inserted && el.scrollTop>0){inserted=true;
        const row=document.createElement("div");row.style.height="80px";row.textContent="Yesterday prepended";el.prepend(row);}});})();</script>`);
  s=await scan(prepending,"fast","layout-uncertain");
  assert.ok(s.layoutChanges>=1);
  assert.equal(s.notes.length,0);
  const diagnostic=await page.evaluate(()=>window.__virtualPageFindV1.diagnostics());
  for(const event of ["start","finding-top","settle","view","scroll","range-change","bottom-check","restore","finished"])
    assert.ok(diagnostic.includes(" "+event+" "),event);
  assert.ok(diagnostic.includes("status=layout-uncertain"));
  assert.ok(diagnostic.includes("mutations="));
  assert.ok(!["Yesterday","existing","prepended","review-list","http://","https://"].some(value=>diagnostic.includes(value)),"Diagnostic must not include query, page text, DOM IDs or URL");
  await page.evaluate(()=>window.__virtualPageFindV1.clear());
  assert.equal(await page.evaluate(()=>window.__virtualPageFindV1.diagnostics()),"");

  const jumping=await setup(`<div id="review-list"><div style="height:1200px"></div></div>
    <script>(()=>{const el=document.querySelector("#review-list");let jumped=false;
      el.addEventListener("scroll",()=>{if(!jumped && el.scrollTop>0){jumped=true;el.scrollTop=900;}});})();</script>`);
  await page.evaluate(id=>window.__virtualPageFindV1.start({id,query:"Yesterday",pace:"fast"}),jumping);
  await page.waitForFunction(()=>window.__virtualPageFindV1.snapshot().status!=="running",null,{timeout:90000});
  s=await page.evaluate(()=>window.__virtualPageFindV1.snapshot());
  assert.equal(s.status,"partial");
  assert.ok(s.notes.some(n=>n.includes("A scroll jump exceeded one viewport")));
  console.log(name+": passed append/prepend layout uncertainty, private diagnostics, and real gap warning");
}

async function navigationRegressions(page,name) {
  const html=await readFile(new URL("tests/navigation-fixture.html",base),"utf8");
  await page.setContent(html);
  const id=await page.evaluate(()=>window.__virtualPageFindV1.discover().find(c=>c.label==="div#nav-list").id);
  await page.evaluate(id=>window.__virtualPageFindV1.start({id,query:"Yesterday",pace:"fast"}),id);
  await page.waitForFunction(()=>window.__virtualPageFindV1.snapshot().status!=="running",null,{timeout:90000});
  const s=await page.evaluate(()=>window.__virtualPageFindV1.snapshot());
  assert.equal(s.status,"traversed",s.notes.join("; "));
  assert.equal(s.pass,2);assert.ok(s.layoutChanges>0);assert.equal(s.finalLayoutChanges,0);
  assert.equal(s.hits.length,4);
  const oracle=[2,12,23,34];
  for(let i=0;i<oracle.length;i++){
    const result=await page.evaluate(index=>window.__virtualPageFindV1.jump({index}),i);
    assert.equal(result.outcome,"verified");
    // The oracle attribute is never read by the scanner. Verify the actual
    // logical row is present within the viewport, not just an equal string.
    const visible=await page.evaluate(expected=>{
      const el=document.querySelector("#nav-list"),r=el.getBoundingClientRect();
      const row=document.querySelector('[data-vpf-test-id="oracle-'+expected+'"]');
      if(!row)return false;const b=row.getBoundingClientRect();return b.top>=r.top && b.bottom<=r.bottom;
    },oracle[i]);
    assert.equal(visible,true,"wrong logical row: "+oracle[i]);
  }
  const initial=await page.locator("#nav-list").evaluate(el=>el.scrollTop);
  await page.evaluate(()=>window.__virtualPageFindV1.verifyAll());
  await page.waitForFunction(()=>!window.__virtualPageFindV1.snapshot().verification.running,null,{timeout:30000});
  const v=await page.evaluate(()=>window.__virtualPageFindV1.snapshot().verification);
  assert.equal(v.verified,4);assert.equal(v.checked,4);
  assert.equal(await page.locator("#nav-list").evaluate(el=>el.scrollTop),initial);
  // Identical text at the old position is not proof of identity.
  await page.setContent('<div id="static-list" style="height:200px;width:400px;overflow:auto"><div id="original">Yesterday</div><div style="height:500px"></div></div>');
  const staticId=await page.evaluate(()=>window.__virtualPageFindV1.discover().find(c=>c.label==="div#static-list").id);
  await page.evaluate(id=>window.__virtualPageFindV1.start({id,query:"Yesterday",pace:"fast"}),staticId);
  await page.waitForFunction(()=>window.__virtualPageFindV1.snapshot().status!=="running");
  await page.evaluate(()=>{document.querySelector("#original").id="replacement";});
  const ambiguous=await page.evaluate(()=>window.__virtualPageFindV1.jump({index:0}));
  assert.equal(ambiguous.found,false);assert.equal(ambiguous.outcome,"approximate");
  console.log(name+": passed two-pass reflow, four independent oracle positions, batch verification and rejection of a wrong identity");
}

async function popupSizing(page,name) {
  const css=await readFile(new URL("src/popup.css",base),"utf8");
  const html=await readFile(new URL("src/popup.html",base),"utf8");
  // Test the packaged markup and CSS with a deliberately small initial viewport.
  // Native toolbar popup sizing/animation itself still needs manual validation.
  await page.setViewportSize({width:100,height:600});
  await page.setContent(html.replace(/<link rel="stylesheet" href="popup.css">/,"<style>"+css+"</style>").replace('<script src="popup.js"></script>',""));
  async function widths(){
    return page.evaluate(()=>({
      body:document.body.getBoundingClientRect().width,
      content:document.querySelector("form").getBoundingClientRect().width,
      bodyScroll:document.body.scrollWidth,
      rootScroll:document.documentElement.scrollWidth
    }));
  }
  assert.deepEqual(await widths(),{body:389,content:365,bodyScroll:389,rootScroll:389});
  await page.setViewportSize({width:389,height:600});
  await page.evaluate(()=>{
    const option=document.createElement("option");option.textContent="Very long scroll container ".repeat(20);
    document.querySelector("#container").append(option);
    const button=document.createElement("button");button.className="result";button.textContent="X".repeat(500);
    document.querySelector("#results").append(button);
  });
  assert.deepEqual(await widths(),{body:389,content:365,bodyScroll:389,rootScroll:389});
  // Firefox initially measures preferred body width in a viewport up to 800px.
  // Ensure the BODY itself is explicitly constrained at that size too.
  await page.setViewportSize({width:800,height:600});
  await page.evaluate(()=>{
    document.querySelector("#diagnostics").hidden=false;
    document.querySelector("#diagnostics").open=true;
    document.querySelector("#log").value="long diagnostic line ".repeat(100);
    document.querySelector("#layout").hidden=false;
    document.querySelector("#layout").textContent="X".repeat(500);
  });
  assert.deepEqual(await widths(),{body:389,content:365,bodyScroll:389,rootScroll:800});
  await page.setViewportSize({width:389,height:600});
  assert.deepEqual(await widths(),{body:389,content:365,bodyScroll:389,rootScroll:389});
  assert.equal(await page.locator("#container").evaluate(el=>el.getBoundingClientRect().width),365);
  await page.evaluate(()=>{document.querySelector("#diagnostics").open=false;document.querySelector("#diagnostics").hidden=true;});
  console.log(name+": passed fixed BODY width at 100/389/800px viewports and long option/result/log containment");
}

async function popupDiagnostics(page,name) {
  // Exercise the actual popup script with a minimal mock of extension APIs.
  // This is not a native toolbar popup or a permission/clipboard integration test.
  await page.evaluate(()=>{
    const s={status:"layout-uncertain",layoutChanges:1,notes:[],hits:[{context:"[Yesterday]",y:150,x:0}],steps:3,elapsed:300,query:"Yesterday",pace:"fast"};
    const api={tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async ({args})=>args?[{result:args[0]==="discover"?[{id:0,label:"Test",height:200,range:500}]:args[0]==="diagnostics"?"test diagnostic record":s}]:[]}};
    Object.defineProperty(globalThis,"browser",{value:api,configurable:true});
  });
  await page.addScriptTag({path:fileURLToPath(new URL("src/popup.js",base))});
  await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("results uncertain"));
  const warning=await page.locator("#layout").textContent();
  assert.ok(warning.includes("missing or duplicated"));
  assert.ok(warning.includes("No user input is required"));
  await page.locator("#diagnostics summary").click();
  await page.waitForFunction(()=>document.querySelector("#log").value==="test diagnostic record");
  assert.equal(await page.locator("#copy-log").isEnabled(),true);
  console.log(name+": passed popup layout-warning wording and diagnostic display");
}

try {
  if(requested==="all"||requested==="chromium") await test("Chromium",chromium);
  if(requested==="all"||requested==="firefox") await test("Firefox",firefox);
} finally { await new Promise(resolve=>server.close(resolve)); }
