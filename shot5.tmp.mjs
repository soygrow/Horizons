import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:4352/opportunity/video-to-publishable-notes", { waitUntil: "load" });
await p.waitForTimeout(800);
for (const [name, sel] of [["path","#path"],["outcome","#outcome"],["risks","#risks"]]) {
  await p.evaluate((s) => document.querySelector(s).scrollIntoView(), sel);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `/tmp/f-${name}.png`, clip: { x: 0, y: 0, width: 1440, height: 900 } });
}
await b.close();
