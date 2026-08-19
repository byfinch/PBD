#!/usr/bin/env node
/** brevo-onboard2.mjs — complete-profile formunu doldur, sonraki adimi dok */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard2-${tag}-${Date.now()}.jpg`), 70, true);

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
const dump = async () => ev(`(() => {
  const inputs = [...document.querySelectorAll("input,select,textarea")]
    .filter(i => i.type !== "hidden" && (i.offsetWidth || i.offsetHeight))
    .map(i => ({ tag: i.tagName, type: i.type, id: i.id, name: i.name, ph: i.placeholder, label: (i.labels && i.labels[0] ? i.labels[0].innerText : "").slice(0,40) }));
  const buttons = [...document.querySelectorAll("button")]
    .filter(b => b.offsetWidth || b.offsetHeight)
    .map(b => ({ id: b.id, text: (b.innerText||"").trim().slice(0,50) }))
    .filter(b => b.text);
  return { url: location.href, text: document.body.innerText.slice(0, 700), inputs, buttons };
})()`);

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(10000);
  console.log("fname:", await setVal("#fname", "Kemal"));
  console.log("lname:", await setVal("#lname", "Secer"));
  console.log("company:", await setVal("#company_name", "Meridyen Dijital"));
  // "I don't have a website" secenegi
  const noSite = await ev(`(() => {
    const els = [...document.querySelectorAll("label,span,div,a")].filter(e => (e.innerText||"").trim() === "I don't have a website");
    if (!els.length) return "yok";
    els[0].click(); return "tiklandi";
  })()`);
  console.log("no-website:", noSite);
  await sleep(1000);
  const siteVal = await ev(`(document.getElementById("website")||{}).value ?? "yok"`);
  console.log("website alani:", siteVal, "| disabled:", await ev(`(document.getElementById("website")||{}).disabled`));
  await shot(cdp, "01-filled");
  // Continue
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find(x => (x.innerText||"").trim() === "Continue" && (x.offsetWidth||x.offsetHeight));
    if (!b) return "yok";
    b.click(); return "tiklandi";
  })()`);
  console.log("continue:", clicked);
  await sleep(10000);
  await shot(cdp, "02-next");
  console.log(JSON.stringify(await dump(), null, 1));
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
