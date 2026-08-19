#!/usr/bin/env node
/** brevo-onboard8.mjs — country icin klavye navigasyonu */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard8-${tag}-${Date.now()}.jpg`), 70, true);

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
const arrow = async (key) => {
  const code = key === "ArrowDown" ? "ArrowDown" : key;
  const vk = key === "ArrowDown" ? 40 : 13;
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
const findTurkey = () => ev(`(() => {
  const els = [...document.querySelectorAll("body *")].filter(e =>
    e.children.length === 0 && (e.offsetWidth||e.offsetHeight) && /^turkey$/i.test((e.textContent||"").trim()));
  if (!els.length) return null;
  const r = els[els.length-1].getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, n: els.length };
})()`);

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(12000);
  for (let i = 0; i < 10; i++) { if (await ev(`!!document.getElementById("address")`)) break; await sleep(3000); }
  await typeInto("#address", "Mumhane Caddesi No 12 Karakoy");
  await typeInto("#zip_code", "34425");
  await typeInto("#city", "Istanbul");

  // country: odakla + ArrowDown
  await cdp.focusSelector("#select-menu-input");
  await sleep(500);
  await arrow("ArrowDown");
  await sleep(2500);
  await shot(cdp, "01-arrowdown");
  let tr = await findTurkey();
  console.log("arrowdown sonrasi turkey:", JSON.stringify(tr));

  if (!tr) {
    // yazarak filtrele
    await cdp.typeText("Turkey", 150);
    await sleep(2500);
    await shot(cdp, "02-typed");
    tr = await findTurkey();
    console.log("yazdiktan sonra turkey:", JSON.stringify(tr));
  }
  if (tr) {
    await cdp.click(tr.x + tr.w / 2, tr.y + tr.h / 2);
    await sleep(1500);
  } else {
    // son care: Enter (highlighted secenegi kabul et)
    await arrow("Enter");
    await sleep(1500);
  }
  console.log("country v:", await ev(`(document.getElementById("select-menu-input")||{}).value`));
  console.log("aktif hata:", await ev(`document.body.innerText.includes("Select a country")`));
  await shot(cdp, "03-final");

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
    console.log(JSON.stringify(await ev(`({ url: location.href, text: document.body.innerText.slice(0,700) })`), null, 1));
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
