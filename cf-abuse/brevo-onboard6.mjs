#!/usr/bin/env node
/** brevo-onboard6.mjs — adres formu: hepsini tek gecede, country icin detayli dump */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard6-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

async function typeInto(sel, text) {
  const ok = await cdp.focusSelector(sel);
  if (!ok) return "YOK";
  await sleep(400);
  await cdp.typeText(text, 50);
  await sleep(400);
  return ev(`(document.querySelector(${JSON.stringify(sel)})||{}).value`);
}

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(12000);
  // form gelene kadar bekle
  for (let i = 0; i < 10; i++) {
    if (await ev(`!!document.getElementById("address")`)) break;
    await sleep(3000);
  }
  console.log("address:", await typeInto("#address", "Mumhane Caddesi No 12 Karakoy"));
  console.log("zip:", await typeInto("#zip_code", "34425"));
  console.log("city:", await typeInto("#city", "Istanbul"));

  // country dropdown ac
  const cb = await cdp.box("#select-menu-input");
  if (!cb) throw new Error("country input yok");
  await cdp.click(cb.x + cb.w / 2, cb.y + cb.h / 2);
  await sleep(3000);
  await shot(cdp, "01-country-open");
  // acilan menuyu bul: body seviyesinde son eklenen gorunur menu/listbox
  const menuInfo = await ev(`(() => {
    const lists = [...document.querySelectorAll('[role="listbox"], [class*="menu"], [class*="dropdown"], ul')].filter(e => e.offsetWidth && e.offsetHeight && e.innerText && e.innerText.length > 20);
    return lists.map(l => ({ cls: (l.className||"").slice(0,60), role: l.getAttribute("role"), text: (l.innerText||"").slice(0,200) })).slice(0,6);
  })()`);
  console.log("menuler:", JSON.stringify(menuInfo, null, 1));
  // input'a yazarak filtrele
  await cdp.focusSelector("#select-menu-input");
  await sleep(300);
  await cdp.typeText("Turk", 120);
  await sleep(2500);
  await shot(cdp, "02-country-filtered");
  const menuInfo2 = await ev(`(() => {
    const lists = [...document.querySelectorAll('[role="option"], [role="listbox"] *, li')]
      .filter(e => e.offsetWidth && e.offsetHeight && /turk/i.test(e.innerText||"") && (e.innerText||"").trim().length < 40)
      .map(e => { const r = e.getBoundingClientRect(); return { t: e.innerText.trim(), x: r.x, y: r.y, w: r.width, h: r.height }; });
    return lists.slice(0, 6);
  })()`);
  console.log("filtreli:", JSON.stringify(menuInfo2));
  if (menuInfo2?.length) {
    const t = menuInfo2[0];
    await cdp.click(t.x + t.w / 2, t.y + t.h / 2);
    await sleep(1500);
    console.log("secildi:", t.t);
  }
  console.log("country v:", await ev(`(document.getElementById("select-menu-input")||{}).value`));
  await shot(cdp, "03-ready");

  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find(x => /select your plan/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  if (btn) {
    await cdp.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
    console.log("Select your plan tiklandi");
    await sleep(10000);
    await shot(cdp, "04-next");
    const d = await ev(`({ url: location.href, text: document.body.innerText.slice(0,700) })`);
    console.log(JSON.stringify(d, null, 1));
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
