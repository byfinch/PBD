#!/usr/bin/env node
/** brevo-onboard3.mjs — complete-profile: gercek klavye ile doldur */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard3-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

async function typeInto(sel, text) {
  // once temizle, sonra gercek tuslarla yaz
  await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) { el.value = ""; } return 1; })()`);
  const ok = await cdp.focusSelector(sel);
  if (!ok) return "YOK";
  await sleep(400);
  await cdp.typeText(text, 45);
  await sleep(300);
  return ev(`document.querySelector(${JSON.stringify(sel)}).value`);
}
const dump = async () => ev(`(() => {
  const inputs = [...document.querySelectorAll("input,select,textarea")]
    .filter(i => i.type !== "hidden" && (i.offsetWidth || i.offsetHeight))
    .map(i => ({ tag: i.tagName, type: i.type, id: i.id, name: i.name, v: (i.value||"").slice(0,30), label: (i.labels && i.labels[0] ? i.labels[0].innerText : "").slice(0,40) }));
  const buttons = [...document.querySelectorAll("button")]
    .filter(b => b.offsetWidth || b.offsetHeight)
    .map(b => ({ id: b.id, text: (b.innerText||"").trim().slice(0,50) }))
    .filter(b => b.text);
  return { url: location.href, text: document.body.innerText.slice(0, 600), inputs, buttons };
})()`);

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(10000);
  // form gec yuklenebiliyor — #fname gelene kadar bekle
  for (let i = 0; i < 15; i++) {
    const ok = await ev(`!!document.getElementById("fname")`);
    if (ok) break;
    if (i === 14) {
      console.log("fname gelmedi. url:", await ev(`location.href`));
      console.log("sayfa:", ((await ev(`document.body.innerText.slice(0,500)`)) || "").replace(/\n+/g, " | "));
      await shot(cdp, "00-stuck");
      throw new Error("form yuklenemedi");
    }
    await sleep(3000);
  }
  console.log("fname:", await typeInto("#fname", "Kemal"));
  console.log("lname:", await typeInto("#lname", "Secer"));
  console.log("company:", await typeInto("#company_name", "Meridyen Dijital"));
  // website zaten dolu (meridyendijital.com) — birak
  console.log("website:", await ev(`document.getElementById("website").value`));
  await shot(cdp, "01-filled");

  // Continue — gercek tik
  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find(x => (x.innerText||"").trim().startsWith("Continue") && (x.offsetWidth||x.offsetHeight));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  if (!btn) throw new Error("Continue yok");
  await cdp.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
  console.log("Continue tiklandi");
  await sleep(10000);
  await shot(cdp, "02-next");
  console.log(JSON.stringify(await dump(), null, 1));
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
