import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:4352/opportunity/video-to-publishable-notes", { waitUntil: "load" });
await p.waitForTimeout(900);
await p.screenshot({ path: "/tmp/f-det-full.png", fullPage: true });
const h = await p.evaluate(() => document.body.scrollHeight);
console.log("detail 高度", h);
for (const [i, y] of [[1, 700], [2, 1500], [3, 2300]]) {
  await p.evaluate((yy) => window.scrollTo(0, yy), y);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `/tmp/f-det-${i}.png`, clip: { x: 0, y: 0, width: 1440, height: 900 } });
}
await p.goto("http://localhost:4352/opportunity/archive", { waitUntil: "load" });
await p.waitForTimeout(500);
await p.screenshot({ path: "/tmp/f-archive.png", clip: { x: 0, y: 0, width: 1440, height: 900 } });
await b.close();
