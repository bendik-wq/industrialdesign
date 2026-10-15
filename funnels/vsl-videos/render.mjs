// Usage: node render.mjs <timeline.json> <audio> <out.mp4> [workers=4]
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const [tlPath, audio, out, W = "4"] = process.argv.slice(2);
const tl = JSON.parse(readFileSync(tlPath, "utf8")), FPS = 25, N = Math.ceil(tl.dur * FPS), workers = Number(W);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--allow-file-access-from-files"] });
async function part(k) {
  const a = Math.floor((N * k) / workers), z = Math.floor((N * (k + 1)) / workers), file = `${out}.part${k}.mp4`;
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "inherit", "inherit"] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto("file://" + process.cwd() + "/frame.html"); await p.evaluate(() => document.fonts.ready);
  await p.evaluate((tl) => window.setup(tl), tl);
  for (let i = a; i < z; i++) {
    await p.evaluate((t) => window.render(t), i / FPS);
    const buf = await p.screenshot({ type: "jpeg", quality: 90 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if ((i - a) % 1000 === 0) console.log(`${out} worker ${k}: ${i - a}/${z - a}`);
  }
  ff.stdin.end(); await new Promise((r) => ff.on("close", r)); return file;
}
const files = await Promise.all([...Array(workers).keys()].map(part));
await b.close();
writeFileSync(`${out}.list`, files.map((f) => `file '${f}'`).join("\n"));
await new Promise((r) => spawn("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${out}.list`, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", "-shortest", "-movflags", "+faststart", out], { stdio: "inherit" }).on("close", r));
console.log("done", out);
