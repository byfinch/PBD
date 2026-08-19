#!/usr/bin/env node
/** brevo-onboard4.mjs — adres adimi: dok + doldur + ilerle */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard4-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

const dump = async () => ev(`(() => {
  const inputs = [...document.querySelectorAll("input,select,textarea")]
    .filter(i => i.type !== "hidden" && (i.offsetWidth || i.offsetHeight))
    .map(i => ({ tag: i.tagName, type: i.type, id: i.id, name: i.name, v: (i.value||"").slice(0,30), label: (i.labels && i.labels[0] ? i.labels[0].innerText : "").slice(0,40) }));
  const buttons = [...document.querySelectorAll("button,a")]
    .filter(b => b.offsetWidth || b.offsetHeight)
    .map(b => ({ tag: b.tagName, id: b.id, text: (b.innerText||"").trim().slice(0,50) }))
    .filter(b => b.text);
  return { url: location.href, text: document.body.innerText.slice(0, 600), inputs, buttons };
})()`);

async function typeInto(sel, text) {
  const ok = await cdp.focusSelector(sel);
  if (!ok) return "YOK";
  await sleep(400);
  await cdp.typeText(text, 45);
  await sleep(300);
  return ev(`(document.querySelector(${JSON.stringify(sel)})||{}).value`);
}

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(12000);
  const d1 = await dump();
  console.log(JSON.stringify(d1, null, 1));
  await shot(cdp, "01-addr-form");

  // alanlari id/label'a gore doldur
  const addr = (d1.inputs ?? []).find((i) => /address/i.test(i.label + i.id + i.name));
  const zip = (d1.inputs ?? []).find((i) => /postal|zip/i.test(i.label + i.id + i.name));
  const city = (d1.inputs ?? []).find((i) => /city/i.test(i.label + i.id + i.name));
  if (addr) console.log("address:", await typeInto("#" + addr.id, "Mumhane Caddesi No:12 Karakoy"));
  if (zip) console.log("zip:", await typeInto("#" + zip.id, "34425"));
  if (city) console.log("city:", await typeInto("#" + city.id, "Istanbul"));
  // country: select ya da autocomplete
  const country = (d1.inputs ?? []).find((i) => /country/i.test(i.label + i.id + i.name));
  if (country) {
    console.log("country alani:", country.tag, country.id, country.type);
    if (country.tag === "SELECT") {
      console.log("country set:", await ev(`(() => {
        const s = document.getElementById(${JSON.stringify(country.id)});
        const opt = [...s.options].find(o => /turkey|türkiye/i.test(o.text));
        if (!opt) return "secenek yok: " + [...s.options].slice(0,10).map(o=>o.text).join(",");
        s.value = opt.value;
        s.dispatchEvent(new Event("change", { bubbles: true }));
        return opt.text;
      })()`));
    } else {
      console.log("country:", await typeInto("#" + country.id, "Turkey"));
      await sleep(2000);
      // autocomplete secenegi ciktiysa ilkini sec
      console.log("ac secim:", await ev(`(() => {
        const opts = [...document.querySelectorAll('[role="option"],[role="listbox"] li, .autocomplete li, ul li')].filter(e => /turkey/i.test(e.innerText||"") && (e.offsetWidth||e.offsetHeight));
        if (!opts.length) return "yok";
        opts[0].click(); return "tiklandi: " + opts[0].innerText.slice(0,30);
      })()`));
    }
  }
  await shot(cdp, "02-addr-filled");
  // ileri butonu ("Select your plan" ya da Continue)
  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll("button,a")].find(x => /select your plan|continue|next/i.test((x.innerText||"").trim()) && (x.offsetWidth||x.offsetHeight));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, text: b.innerText.trim().slice(0,30) };
  })()`);
  console.log("buton:", JSON.stringify(btn));
  if (btn) {
    await cdp.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
    console.log("tiklandi");
    await sleep(10000);
    await shot(cdp, "03-next");
    console.log(JSON.stringify(await dump(), null, 1));
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
