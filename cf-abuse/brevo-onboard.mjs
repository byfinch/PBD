#!/usr/bin/env node
/**
 * brevo-onboard.mjs — Brevo onboarding adimlari (PBD-02 oturumu devam ediyor)
 * Her adimda: alanlari dok, doldur, ilerle. Etkilesimli degil; dump + screenshot.
 * kullanim: node brevo-onboard.mjs [--step N]
 */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);
async function setVal(sel, value) {
  return ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return "YOK";
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? "OK" : "FAIL";
  })()`);
}

try {
  await cdp.navigate("https://app.brevo.com/");
  await sleep(12000);
  console.log("url:", await ev(`location.href`));
  await shot(cdp, "01-current");
  const pageInfo = await ev(`(() => {
    const inputs = [...document.querySelectorAll("input,select,textarea")]
      .filter(i => i.type !== "hidden" && (i.offsetWidth || i.offsetHeight))
      .map(i => ({ tag: i.tagName, type: i.type, id: i.id, name: i.name, ph: i.placeholder, label: (i.labels && i.labels[0] ? i.labels[0].innerText : "").slice(0,40) }));
    const buttons = [...document.querySelectorAll("button")]
      .filter(b => b.offsetWidth || b.offsetHeight)
      .map(b => ({ id: b.id, text: (b.innerText||"").trim().slice(0,50) }))
      .filter(b => b.text);
    return { text: document.body.innerText.slice(0, 800), inputs, buttons };
  })()`);
  console.log(JSON.stringify(pageInfo, null, 1));
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
