#!/usr/bin/env node
/** brevo-onboard10.mjs — country: control tik + yazarak filtrele + Turkey sec + ilerle */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard10-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

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

  const ctrlBox = await ev(`(() => {
    const el = document.querySelector('[class*="sib-selectmenu-control___"]');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  await cdp.click(ctrlBox.x + ctrlBox.w / 2, ctrlBox.y + ctrlBox.h / 2);
  await sleep(2500);
  // panel acikken dogrudan yaz (type-ahead) — odak DEGISTIRME
  await cdp.typeText("Turkey", 130);
  await sleep(2500);
  await shot(cdp, "01-filtered");
  let tr = await ev(`(() => {
    const p = document.querySelector('[id^="sib-selectmenu--panel"]');
    if (!p) return { kapali: true };
    const els = [...p.querySelectorAll("*")].filter(e => (e.offsetWidth||e.offsetHeight) && /^turkey$/i.test((e.textContent||"").trim()));
    if (!els.length) return { panelText: p.innerText.slice(0,200) };
    const r = els[0].getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  console.log("turkey:", JSON.stringify(tr));
  if (!(tr && tr.x !== undefined)) {
    // type-ahead calismadiysa: panel acik mi kontrol et, tekrar ac + End/scroll ile dibe in
    await cdp.click(ctrlBox.x + ctrlBox.w / 2, ctrlBox.y + ctrlBox.h / 2);
    await sleep(2000);
    // panel uzerinde wheel ile dibe kaydir (birkac tur)
    for (let i = 0; i < 14; i++) {
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: ctrlBox.x + 200, y: ctrlBox.y + 200, deltaX: 0, deltaY: 600 });
      await sleep(700);
    }
    await sleep(1500);
    await shot(cdp, "01b-scrolled");
    tr = await ev(`(() => {
      const p = document.querySelector('[id^="sib-selectmenu--panel"]');
      if (!p) return { kapali: true };
      const els = [...p.querySelectorAll("*")].filter(e => (e.offsetWidth||e.offsetHeight) && /^turkey$/i.test((e.textContent||"").trim()));
      if (!els.length) return { panelText: p.innerText.slice(0,300) };
      const r = els[0].getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    console.log("turkey (scroll):", JSON.stringify(tr));
  }
  if (tr && tr.x !== undefined) {
    await cdp.click(tr.x + tr.w / 2, tr.y + tr.h / 2);
    await sleep(1500);
    console.log("country v:", await ev(`document.getElementById("select-menu-input").value`));
    console.log("selected:", await ev(`(document.querySelector('[class*="selected-value"]')||{}).innerText`));
  }
  await shot(cdp, "02-selected");

  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find(x => /select your plan/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  if (btn) {
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
