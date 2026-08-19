#!/usr/bin/env node
/** brevo-onboard11.mjs — country secildi mi kontrol + panel acik kuyruk */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard11-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(12000);
  for (let i = 0; i < 10; i++) { if (await ev(`!!document.getElementById("address")`)) break; await sleep(3000); }
  const state = await ev(`(() => ({
    addr: document.getElementById("address").value,
    zip: document.getElementById("zip_code").value,
    city: document.getElementById("city").value,
    country: document.getElementById("select-menu-input").value,
    selected: (document.querySelector('[class*="selected-value"]')||{}).innerText,
  }))()`);
  console.log("state:", JSON.stringify(state));

  // panel ac + kendi icinde scroll (DOM uzerinden: scrollTop)
  const ctrlBox = await ev(`(() => {
    const el = document.querySelector('[class*="sib-selectmenu-control___"]');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  await cdp.click(ctrlBox.x + ctrlBox.w / 2, ctrlBox.y + ctrlBox.h / 2);
  await sleep(2500);
  // panel icindeki scroll container'i DOM'dan kaydir (virtualized list render tetikler)
  for (let i = 0; i < 20; i++) {
    const info = await ev(`(() => {
      const p = document.querySelector('[id^="sib-selectmenu--panel"]');
      if (!p) return "kapali";
      const sc = [...p.querySelectorAll("*")].find(e => e.scrollHeight > e.clientHeight + 50);
      if (!sc) return "scroll-yok " + p.innerText.slice(0,80);
      sc.scrollTop = sc.scrollHeight;
      const t = p.innerText;
      return /turkey/i.test(t) ? "TURKEY-GORUNUYOR" : t.slice(-60);
    })()`);
    if (info === "kapali") { console.log("panel kapandi"); break; }
    if (info === "TURKEY-GORUNUYOR") { console.log("turkey gorunuyor"); break; }
    if (i % 5 === 0) console.log(i, info);
    await sleep(600);
  }
  await shot(cdp, "01-scrolled");
  const tr = await ev(`(() => {
    const p = document.querySelector('[id^="sib-selectmenu--panel"]');
    if (!p) return null;
    const els = [...p.querySelectorAll("*")].filter(e => (e.offsetWidth||e.offsetHeight) && /^turkey$/i.test((e.textContent||"").trim()));
    if (!els.length) return null;
    const r = els[0].getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  console.log("turkey:", JSON.stringify(tr));
  if (tr) {
    await cdp.click(tr.x + tr.w / 2, tr.y + tr.h / 2);
    await sleep(1500);
    console.log("secim sonrasi:", JSON.stringify(await ev(`({
      country: document.getElementById("select-menu-input").value,
      selected: (document.querySelector('[class*="selected-value"]')||{}).innerText })`)));
    await shot(cdp, "02-selected");
    const btn = await ev(`(() => {
      const b = [...document.querySelectorAll("button")].find(x => /select your plan/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight));
      const r = b.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    await cdp.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
    console.log("Select your plan tiklandi");
    await sleep(12000);
    await shot(cdp, "03-next");
    console.log(JSON.stringify(await ev(`({ url: location.href, text: document.body.innerText.slice(0,900) })`), null, 1));
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
