#!/usr/bin/env node
/** brevo-onboard7.mjs — country chevron tik + portal menusunu bul + Turkey sec */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard7-${tag}-${Date.now()}.jpg`), 70, true);

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
  return ev(`(document.querySelector(${JSON.stringify(sel)})||{}).value`);
}

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(12000);
  for (let i = 0; i < 10; i++) { if (await ev(`!!document.getElementById("address")`)) break; await sleep(3000); }
  console.log("address:", await typeInto("#address", "Mumhane Caddesi No 12 Karakoy"));
  console.log("zip:", await typeInto("#zip_code", "34425"));
  console.log("city:", await typeInto("#city", "Istanbul"));

  // chevron'a tik (input'un sag ucu)
  const cb = await cdp.box("#select-menu-input");
  if (!cb) throw new Error("country input yok");
  await cdp.click(cb.x + cb.w - 18, cb.y + cb.h / 2);
  await sleep(3500);
  await shot(cdp, "01-open");
  // portal: body'nin dogrudan cocuklari arasinda son acilan menu
  const portal = await ev(`(() => {
    const out = [];
    for (const el of document.querySelectorAll("body > *")) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && el.innerText && /Afghanistan|Albania|Turkey|United States/i.test(el.innerText.slice(0, 4000))) {
        out.push({ tag: el.tagName, cls: (el.className||"").toString().slice(0,60), id: el.id, text: el.innerText.slice(0, 150) });
      }
    }
    // alternatif: sabit konumlu buyuk kaplar
    if (!out.length) {
      for (const el of document.querySelectorAll("div")) {
        const st = getComputedStyle(el);
        if ((st.position === "fixed" || st.position === "absolute") && el.offsetHeight > 100 && /Turkey/.test(el.innerText || "") && (el.innerText||"").length < 8000) {
          out.push({ tag: "DIV", cls: (el.className||"").toString().slice(0,60), text: el.innerText.slice(0,150) });
        }
      }
    }
    return out.slice(0, 5);
  })()`);
  console.log("portal:", JSON.stringify(portal, null, 1));

  const tr = await ev(`(() => {
    const els = [...document.querySelectorAll("body *")].filter(e =>
      e.children.length === 0 && (e.offsetWidth||e.offsetHeight) && /^turkey$/i.test((e.textContent||"").trim()));
    if (!els.length) return null;
    const r = els[els.length-1].getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  console.log("turkey oge:", JSON.stringify(tr));
  if (tr) {
    await cdp.click(tr.x + tr.w / 2, tr.y + tr.h / 2);
    await sleep(1500);
    console.log("country v:", await ev(`(document.getElementById("select-menu-input")||{}).value`));
  }
  await shot(cdp, "02-selected");

  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find(x => /select your plan/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  if (btn && tr) {
    await cdp.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
    console.log("Select your plan tiklandi");
    await sleep(10000);
    await shot(cdp, "03-next");
    console.log(JSON.stringify(await ev(`({ url: location.href, text: document.body.innerText.slice(0,700) })`), null, 1));
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
