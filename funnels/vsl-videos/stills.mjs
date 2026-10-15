import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";
const [tlPath, ...ts] = process.argv.slice(2); const tl = JSON.parse(readFileSync(tlPath, "utf8"));
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--allow-file-access-from-files"] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto("file://" + process.cwd() + "/frame.html"); await p.evaluate(() => document.fonts.ready); await p.evaluate((tl) => window.setup(tl), tl);
for (const t of ts) { await p.evaluate((t) => window.render(Number(t)), t); await p.screenshot({ path: `still_${t}.jpg`, type: "jpeg", quality: 70 }); }
await b.close();
