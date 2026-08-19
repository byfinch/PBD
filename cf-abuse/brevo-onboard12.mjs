#!/usr/bin/env node
/** brevo-onboard12.mjs — panelde Turkiye ara + sec + formu tamamla */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard12-${tag}-${Date.now()}.jpg`), 70, true);

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
  // panele "T" harfiyle type-ahead ya da tam liste tara
  const full = await ev(`(() => {
    const p = document.querySelector('[id^="sib-selectmenu--panel"]');
    if (!p) return "kapali";
    const t = p.innerText;
    const m = t.match(/T[a-züÜ]+/g);
    return m ? m.join(", ") : t.slice(0, 300);
  })()`);
  console.log("T ile baslayanlar:", full);

  // Turkiye'ye kaydir + tikla
  const tr = await ev(`(() => {
    const p = document.querySelector('[id^="sib-selectmenu--panel"]');
    if (!p) return null;
    const opts = [...p.querySelectorAll("*")].filter(e => e.children.length === 0 && /^(turkey|türkiye)$/i.test((e.textContent||"").trim()));
    if (!opts.length) return null;
    const el = opts[0];
    el.scrollIntoView({ block: "center" });
    return "ok";
  })()`);
  await sleep(1200);
  const trBox = await ev(`(() => {
    const p = document.querySelector('[id^="sib-selectmenu--panel"]');
    const opts = [...p.querySelectorAll("*")].filter(e => e.children.length === 0 && /^(turkey|türkiye)$/i.test((e.textContent||"").trim()) && (e.offsetWidth||e.offsetHeight));
    if (!opts.length) return null;
    const r = opts[0].getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, t: opts[0].textContent.trim() };
  })()`);
  console.log("turkiye box:", JSON.stringify(trBox));
  if (trBox) {
    await cdp.click(trBox.x + trBox.w / 2, trBox.y + trBox.h / 2);
    await sleep(1500);
    console.log("secildi:", JSON.stringify(await ev(`({ v: document.getElementById("select-menu-input").value, sel: (document.querySelector('[class*="selected-value"]')||{}).innerText })`)));
    await shot(cdp, "01-selected");
    const btn = await ev(`(() => {
      const b = [...document.querySelectorAll("button")].find(x => /select your plan/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight));
      const r = b.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    await cdp.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
    console.log("Select your plan tiklandi");
    await sleep(12000);
    await shot(cdp, "02-next");
    console.log(JSON.stringify(await ev(`({ url: location.href, text: document.body.innerText.slice(0,900) })`), null, 1));
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
