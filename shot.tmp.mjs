import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const pages = [["/opportunity","opp-index"],["/opportunity/archive","opp-archive"],["/opportunity/video-to-publishable-notes","opp-detail"]];
for (const [u, name] of pages) {
  await p.goto("http://localhost:4350" + u, { waitUntil: "load", timeout: 30000 });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `/tmp/shot-${name}.png`, fullPage: true });
  console.log(name, (await p.evaluate(() => document.body.scrollHeight)) + "px");
}
await b.close();
