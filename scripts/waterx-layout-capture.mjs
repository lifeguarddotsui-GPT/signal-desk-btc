// Development-only browser verification. Requires a separately started Chromium
// with --remote-debugging-port=9222. No login bypass or production fixture route.
import { mkdir, writeFile } from "node:fs/promises";

const base = process.env.REPLIT_DEV_DOMAIN && `https://${process.env.REPLIT_DEV_DOMAIN}`;
if (!base) throw new Error("Development preview domain unavailable.");
const fixture = process.argv[2] ?? "";
const width = Number(process.argv[3] ?? 390);
const height = Number(process.argv[4] ?? 844);
const reduced = process.argv.includes("--reduced-motion");
const fullPage = process.argv.includes("--full-page");
const cardsView = process.argv.includes("--cards");
const destination = process.argv.find(arg => arg.startsWith("--out="))?.slice(6) ??
  `.local/screenshots/waterx-${fixture || "live"}-${width}${reduced ? "-reduced" : ""}.jpg`;
const target = await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let serial = 0;
const pending = new Map();
const errors = [];
socket.addEventListener("message", event => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown")
    errors.push(message.params.exceptionDetails.text);
});
function command(method, params = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
try {
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }],
  });
  await command("Page.navigate", { url: `${base}/${fixture ? `?fixture=${encodeURIComponent(fixture)}` : ""}` });
   let ready = false;
   for (let attempt = 0; attempt < 40; attempt++) {
     const check = await command("Runtime.evaluate", {
       expression: "document.querySelectorAll('.advisory-card').length === 2",
       returnByValue: true,
     });
     if (check.result.value) { ready = true; break; }
     await new Promise(resolve => setTimeout(resolve, 500));
   }
   if (!ready) throw new Error("Assessment cards did not render within 20 seconds.");
   if (!fixture) await new Promise(resolve => setTimeout(resolve, 5000));
   if (cardsView) await command("Runtime.evaluate", {
     expression: "document.querySelector('.advisory-desk')?.scrollIntoView({block:'start'})",
   });
  const result = await command("Runtime.evaluate", {
    expression: `JSON.stringify({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      title: document.title,
      cards: [...document.querySelectorAll('.advisory-card')].map(e=>({
        text:e.innerText, className:e.className,
        animation:getComputedStyle(e).animationName, shadow:getComputedStyle(e).boxShadow,
         border:getComputedStyle(e).borderColor,
         haloAnimation:getComputedStyle(e,'::after').animationName,
         haloShadow:getComputedStyle(e,'::after').boxShadow,
        top:e.getBoundingClientRect().top
      })),
       chart: document.querySelector('svg.price-chart')?.getBoundingClientRect().toJSON(),
      text:document.body.innerText.slice(0,5500)
    })`,
    returnByValue: true,
  });
  const details = JSON.parse(result.result.value);
   const metrics = fullPage ? await command("Page.getLayoutMetrics") : null;
   const screenshot = await command("Page.captureScreenshot", {
     format: "jpeg", quality: 88,
     ...(metrics ? { captureBeyondViewport: true, clip: {
       x: 0, y: 0, width, height: Math.min(metrics.cssContentSize.height, 5000), scale: 1,
     } } : {}),
   });
  await mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
  await writeFile(destination, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ destination, fixture: fixture || "live", reduced, ...details, errors }, null, 2));
  if (details.scrollWidth > width + 1 || errors.length) process.exitCode = 1;
} finally {
  await fetch(`http://127.0.0.1:9222/json/close/${target.id}`);
  socket.close();
}