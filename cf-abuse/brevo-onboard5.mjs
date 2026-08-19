#!/usr/bin/env node
/** brevo-onboard5.mjs — adres adimi duzeltme: ozel karaktersiz adres + ulke dropdown secimi */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard5-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

async function retype(sel, text) {
  // mevcut degeri sec + sil, yeniden yaz
  await cdp.focusSelector(sel);
  await sleep(300);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.key("Backspace").catch(() => {});
  await sleep(200);
  await cdp.typeText(text, 45);
  await sleep(300);
  return ev(`(document.querySelector(${JSON.stringify(sel)})||{}).value`);
}
const dump = async () => ev(`(() => {
  return { url: location.href, text: document.body.innerText.slice(0, 700),
    inputs: [...document.querySelectorAll("input")].filter(i => i.type !== "hidden" && (i.offsetWidth||i.offsetHeight)).map(i => ({ id: i.id, v: (i.value||"").slice(0,40) })) };
})()`);

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(12000);
  // adres duzelt (":" kaldir)
  const curAddr = await ev(`(document.getElementById("address")||{}).value`);
  console.log("mevcut adres:", curAddr);
  if (curAddr && curAddr.includes(":")) console.log("adres duzeltildi:", await retype("#address", curAddr.replace(/[:]/g, " ").replace(/\s+/g, " ").trim()));

  // ulke dropdown: input'a tikla, liste ac, Turkey sec
  const cb = await cdp.box("#select-menu-input");
  if (!cb) throw new Error("country input yok");
  await cdp.click(cb.x + cb.w / 2, cb.y + cb.h / 2);
  await sleep(2500);
  await shot(cdp, "01-country-open");
  // secenekleri dok
  const opts = await ev(`(() => {
    const cand = [...document.querySelectorAll('[role="option"], [role="listbox"] li, li, [class*="option"], [class*="menu"] div')]
      .filter(e => (e.offsetWidth||e.offsetHeight) && (e.innerText||"").trim().length < 40)
      .map(e => (e.innerText||"").trim());
    return [...new Set(cand)].slice(0, 30);
  })()`);
  console.log("secenekler:", JSON.stringify(opts));
  // Turkey'ye tikla (koordinatla)
  const tr = await ev(`(() => {
    const els = [...document.querySelectorAll('[role="option"], li, [class*="option"]')]
      .filter(e => (e.offsetWidth||e.offsetHeight) && /^(turkey|türkiye)$/i.test((e.innerText||"").trim()));
    if (!els.length) return null;
    const r = els[0].getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, t: els[0].innerText.trim() };
  })()`);
  console.log("turkey:", JSON.stringify(tr));
  if (tr) {
    await cdp.click(tr.x + tr.w / 2, tr.y + tr.h / 2);
    await sleep(1500);
  } else {
    // yazarak filtrele
    await retype("#select-menu-input", "Turkey");
    await sleep(2000);
    const tr2 = await ev(`(() => {
      const els = [...document.querySelectorAll('[role="option"], li, [class*="option"]')]
        .filter(e => (e.offsetWidth||e.offsetHeight) && /turkey/i.test(e.innerText||""));
      if (!els.length) return null;
      const r = els[0].getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, t: els[0].innerText.trim().slice(0,30) };
    })()`);
    console.log("turkey2:", JSON.stringify(tr2));
    if (tr2) { await cdp.click(tr2.x + tr2.w / 2, tr2.y + tr2.h / 2); await sleep(1500); }
  }
  await shot(cdp, "02-country-done");
  console.log("country v:", await ev(`(document.getElementById("select-menu-input")||{}).value`));

  // ileri
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
    await shot(cdp, "03-next");
    console.log(JSON.stringify(await dump(), null, 1));
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
