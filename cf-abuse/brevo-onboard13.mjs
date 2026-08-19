#!/usr/bin/env node
/** brevo-onboard13.mjs — virtualized paneli kademeli kaydir, Turkiye'yi sec */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard13-${tag}-${Date.now()}.jpg`), 70, true);

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

  // kademeli tarama: her adimda gorunen secenekleri oku, hedef varsa tikla
  let clicked = false;
  for (let step = 0; step < 40 && !clicked; step++) {
    const res = await ev(`(() => {
      const p = document.querySelector('[id^="sib-selectmenu--panel"]');
      if (!p) return { kapali: true };
      const sc = [...p.querySelectorAll("*")].find(e => e.scrollHeight > e.clientHeight + 50) || p;
      const items = [...p.querySelectorAll("*")].filter(e => e.children.length === 0 && (e.offsetWidth||e.offsetHeight) && (e.textContent||"").trim().length > 1 && (e.textContent||"").trim().length < 40);
      const texts = items.map(e => e.textContent.trim());
      const target = items.find(e => /^(turkey|türkiye)$/i.test(e.textContent.trim()));
      if (target) {
        const r = target.getBoundingClientRect();
        return { found: { x: r.x, y: r.y, w: r.width, h: r.height, t: target.textContent.trim() } };
      }
      // bir ekran asagi kaydir
      sc.scrollTop = sc.scrollTop + sc.clientHeight * 0.85;
      return { texts: texts.slice(0, 12), atBottom: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5 };
    })()`);
    if (res.kapali) { console.log("panel kapandi"); break; }
    if (res.found) {
      console.log("bulundu:", res.found.t);
      await cdp.click(res.found.x + res.found.w / 2, res.found.y + res.found.h / 2);
      clicked = true;
      break;
    }
    if (step % 8 === 0) console.log("taranan:", (res.texts || []).join(", ").slice(0, 90));
    if (res.atBottom) { console.log("listenin dibi — hedef yok"); break; }
    await sleep(500);
  }
  console.log("secim:", clicked);
  if (clicked) {
    await sleep(1500);
    console.log("country v:", await ev(`document.getElementById("select-menu-input").value`));
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
