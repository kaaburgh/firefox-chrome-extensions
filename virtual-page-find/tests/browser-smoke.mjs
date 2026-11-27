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
    const jump = await page.evaluate(hit=>window.__virtualPageFindV1.jump({hit}),s.hits[3]);
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
  } finally { await browser.close(); }
}

async function reviewRegressions(page,name) {
  async function setup(markup) {
    await page.setContent('<!doctype html><style>body{margin:0;font:16px sans-serif}#review-list{height:200px;width:400px;overflow:auto;overflow-anchor:none}</style>'+markup);
    return page.evaluate(()=>window.__virtualPageFindV1.discover().find(c=>c.label==="div#review-list").id);
  }
  async function scan(id, pace="normal") {
    const before=await page.locator("#review-list").evaluate(el=>el.scrollTop);
    await page.evaluate(({id,pace})=>window.__virtualPageFindV1.start({id,query:"Yesterday",pace}),{id,pace});
    await page.waitForFunction(()=>window.__virtualPageFindV1.snapshot().status!=="running",null,{timeout:90000});
    const s=await page.evaluate(()=>window.__virtualPageFindV1.snapshot());
    assert.equal(s.status,"traversed",s.notes.join("; "));
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

  const sticky=await setup('<div id="review-list"><div style="position:sticky;top:0;background:white">Yesterday Yesterday</div><div style="height:900px"></div><div>Yesterday</div></div>');
  s=await scan(sticky,"fast");
  assert.equal(s.hits.length,3,JSON.stringify(s.hits));
  assert.equal(s.hits.filter(h=>h.pinnedKey).length,2);
  assert.equal((await page.evaluate(hit=>window.__virtualPageFindV1.jump({hit}),s.hits[0])).found,true);

  const reverse=await setup('<div id="review-list" style="display:flex;flex-direction:column-reverse"><div style="flex:none;height:900px">Yesterday newest</div><div style="flex:none;height:50px">Yesterday oldest</div></div>');
  await page.locator("#review-list").evaluate(el=>{el.scrollTop=-100;});
  s=await scan(reverse,"fast");
  assert.equal(s.hits.length,2,JSON.stringify(s.hits));
  assert.ok(s.hits[0].context.includes("oldest"));
  assert.ok(s.hits[1].context.includes("newest"));
  assert.equal((await page.evaluate(hit=>window.__virtualPageFindV1.jump({hit}),s.hits[0])).found,true);
  await page.evaluate(()=>window.__virtualPageFindV1.restore());
  assert.equal(await page.locator("#review-list").evaluate(el=>el.scrollTop),-100);

  const clipped=await setup('<div id="review-list"><div style="height:10px;overflow:hidden"><div style="height:30px"></div><div>Yesterday</div></div><div style="height:500px"></div><div>Yesterday visible</div></div>');
  s=await scan(clipped,"fast");
  assert.equal(s.hits.length,1,JSON.stringify(s.hits));
  assert.ok(s.hits[0].context.includes("visible"));
  console.log(name+": passed 350ms debounce, pinned duplicate prevention, reverse-flow traversal/restoration, overflow clipping");
}

try {
  if(requested==="all"||requested==="chromium") await test("Chromium",chromium);
  if(requested==="all"||requested==="firefox") await test("Firefox",firefox);
} finally { await new Promise(resolve=>server.close(resolve)); }
