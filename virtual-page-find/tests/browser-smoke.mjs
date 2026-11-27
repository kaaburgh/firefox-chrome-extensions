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
      await page.evaluate(({id,sensitive})=>window.__virtualPageFindV1.start({id,query:"Yesterday",sensitive}),{id:containers[0].id,sensitive});
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
    await page.evaluate(id=>window.__virtualPageFindV1.start({id,query:"Yesterday"}),containers[0].id);
    await page.waitForTimeout(1000);
    await page.evaluate(()=>window.__virtualPageFindV1.stop());
    await page.waitForFunction(()=>window.__virtualPageFindV1.snapshot().status!=="running",null,{timeout:5000});
    const stopped=await page.evaluate(()=>window.__virtualPageFindV1.snapshot());
    assert.equal(stopped.status,"partial");
    assert.ok(stopped.notes.includes("Stopped by user."));
    assert.equal(await page.locator("#list").evaluate(el=>el.scrollTop),initial);
    console.log(name+": passed container discovery, seven/six matches, inline split, repeated labels, jump, restoration, cancellation");
  } finally { await browser.close(); }
}
try {
  if(requested==="all"||requested==="chromium") await test("Chromium",chromium);
  if(requested==="all"||requested==="firefox") await test("Firefox",firefox);
} finally { await new Promise(resolve=>server.close(resolve)); }
