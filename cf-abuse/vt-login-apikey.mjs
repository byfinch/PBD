#!/usr/bin/env node
/** vt-login-apikey.mjs — VT login + API key cekme */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const CREDS = resolve(EV, "vt-creds.json");
const creds = JSON.parse(readFileSync(CREDS, "utf8"));
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `vt-login-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-08");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => r.result.value);
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
  await cdp.navigate("https://www.virustotal.com/gui/sign-in");
  await sleep(9000);
  await shot(cdp, "01-signin");
  const inputs = await ev(`[...document.querySelectorAll("input")].map(i=>({id:i.id,type:i.type,ph:i.placeholder})).filter(i=>i.type!=="hidden")`);
  console.log("login alanlari:", JSON.stringify(inputs));
  for (const inp of inputs ?? []) {
    if (inp.type === "password") console.log(inp.id, await setVal("#" + inp.id, creds.password));
    else console.log(inp.id, await setVal("#" + inp.id, creds.username));
  }
  await shot(cdp, "02-filled");
  const lb = await cdp.box('button[type="submit"], #submit');
  if (lb) await cdp.click(lb.x + lb.w / 2, lb.y + lb.h / 2);
  await sleep(12000);
  await shot(cdp, "03-after-login");
  console.log("login sonrasi url:", await ev(`location.href`));
  console.log("sayfa:", ((await ev(`document.body.innerText.slice(0,300)`)) || "").replace(/\n+/g, " | "));

  await cdp.navigate("https://www.virustotal.com/gui/my-apikey");
  await sleep(15000);
  await shot(cdp, "04-apikey");
  const key = await ev(`(() => {
    // shadow DOM piercing: tum input'lari derin tara
    const found = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.tagName === "INPUT" && el.value) found.push(el.value);
      }
    };
    walk(document);
    for (const v of found) { const m = v.match(/[0-9a-f]{64}/i); if (m) return m[0]; }
    // metin icinde ara (shadow dahil)
    let allText = "";
    const walkT = (root) => {
      allText += root.textContent ? "" : "";
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { walkT(el.shadowRoot); }
      }
      allText += root === document ? document.body.innerText : "";
    };
    walkT(document);
    const m2 = allText.match(/[0-9a-f]{64}/i);
    return m2 ? m2[0] : (found.length ? "INPUTLAR:" + JSON.stringify(found).slice(0,300) : null);
  })()`);
  console.log("API KEY:", key || "bulunamadi");
  if (key) {
    creds.apiKey = key;
    writeFileSync(CREDS, JSON.stringify(creds, null, 2));
    console.log("VT TAMAM");
  } else process.exitCode = 1;
} catch (err) {
  console.log("HATA:", String(err).slice(0, 300));
  await shot(cdp, "err").catch(() => {});
  process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
