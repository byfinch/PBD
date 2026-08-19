#!/usr/bin/env node
/** brevo-netwatch.mjs — onboarding API cagrilari yakala */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

// network izleme
const reqs = new Map();
cdp.onResponse((p) => {
  const u = p.response?.url ?? "";
  if (!/brevo|sib|sendinblue/i.test(u)) return;
  if (/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/.test(u)) return;
  const e = reqs.get(p.requestId) || {};
  e.status = p.response.status;
  e.url = u;
  reqs.set(p.requestId, e);
  console.log("RESP:", e.status, (e.method||""), u.slice(0, 110), e.post ? "POSTDATA:" + e.post.slice(0, 200) : "");
});
// requestWillBeSent icin ham ws dinleyicisi ekle
{
  const prev = cdp.ws.onmessage;
  cdp.ws.onmessage = (ev2) => {
    const m = JSON.parse(ev2.data);
    if (m.method === "Network.requestWillBeSent") {
      const r = m.params.request;
      if (/brevo|sendinblue/i.test(r.url) && !/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/.test(r.url)) {
        reqs.set(m.params.requestId, { url: r.url, method: r.method, post: r.postData || "" });
      }
    }
    prev(ev2);
  };
}
await cdp.enableNetwork();

async function typeInto(sel, text) {
  await cdp.focusSelector(sel);
  await sleep(400);
  await cdp.typeText(text, 50);
  await sleep(400);
}

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(12000);
  for (let i = 0; i < 10; i++) { if (await ev(`!!document.getElementById("address")`)) break; await sleep(3000); }
  await typeInto("#address", "Mumhane Caddesi No 12 Karakoy");
  await typeInto("#zip_code", "34425");
  await typeInto("#city", "Istanbul");
  console.log("--- country input tiklaniyor ---");
  const cb = await cdp.box("#select-menu-input");
  await cdp.click(cb.x + cb.w / 2, cb.y + cb.h / 2);
  await sleep(5000);
  await cdp.screenshot(resolve(EV, `brevo-netwatch-country-${Date.now()}.jpg`), 70, true);
  console.log("--- Select your plan tiklaniyor ---");
  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find(x => /select your plan/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  if (btn) { await cdp.click(btn.x + btn.w / 2, btn.y + btn.h / 2); }
  await sleep(8000);
  console.log("--- yakalanan istekler bitti ---");
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
