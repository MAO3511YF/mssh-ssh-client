// 把 SVG 渲染成指定尺寸的透明 PNG（连接已运行的 Edge 调试实例）
// 用法: node scripts/icon/render-svg.mjs <in.svg> <out.png> [pixel] [port]
// 前置: msedge --headless=new --remote-debugging-port=9334 about:blank
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , inSvg, outPng, pixelArg = "1024", portArg = "9228"] = process.argv;
if (!inSvg || !outPng) throw new Error("用法: node render-svg.mjs <in.svg> <out.png> [pixel] [port]");
const pixel = Number(pixelArg);
const PORT = Number(portArg);

const htmlPath = join(mkdtempSync(join(tmpdir(), "edge-icon-")), "page.html");
writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
#stage{position:absolute;inset:0}
#stage img{display:block;width:100%;height:100%}</style>
<div id="stage"><img src="${pathToFileURL(resolve(inSvg)).href}"></div>`, "utf8");

const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(pathToFileURL(htmlPath).href)}`, { method: "PUT" });
if (!res.ok) throw new Error(`创建页面失败 ${res.status}`);
const target = await res.json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
await send("Emulation.setDeviceMetricsOverride", {
  width: pixel, height: pixel, deviceScaleFactor: 1, mobile: false,
});
await sleep(800);
const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
if (!shot.result?.data) throw new Error("截图失败: " + JSON.stringify(shot).slice(0, 300));
writeFileSync(outPng, Buffer.from(shot.result.data, "base64"));
await send("Page.close").catch(() => {});
ws.close();
console.log(`saved ${outPng} (${pixel}px)`);
