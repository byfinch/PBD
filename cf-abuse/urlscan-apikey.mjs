#!/usr/bin/env node
/** urlscan-apikey.mjs — New API key olustur + key'i yakala (PBD-03 oturumu) */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const CREDS = resolve(EV, "urlscan-creds.json");
const creds = JSON.parse(readFileSync(CREDS, "utf8"));
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `urlscan5-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-03");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);
async function setVal(name, value) {
  return ev(`(() => {
    const el = document.querySelector('[name="${name}"]');
    if (!el) return "YOK";
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? "OK" : "FAIL";
  })()`);
}

try {
  // login (oturum kalmis olabilir, yine de garanti)
  await cdp.navigate("https://urlscan.io/user/login/");
  await sleep(8000);
  if (await ev(`!!document.querySelector('input[name="password"]')`)) {
    await setVal("email", creds.email);
    await setVal("password", creds.password);
    await ev(`(() => { const f = document.forms[0]; const b = document.querySelector('button[type="submit"],input[type="submit"]'); f.requestSubmit ? f.requestSubmit(b||undefined) : f.submit(); return 1; })()`);
    await sleep(9000);
    console.log("login:", await ev(`location.href`));
  }
  await cdp.navigate("https://urlscan.io/user/profile/");
  await sleep(8000);

  // New API key butonuna tikla
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll("button,a")].find(x => /new api key/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight));
    if (!b) return "yok";
    b.click(); return "tiklandi";
  })()`);
  console.log("new api key:", clicked);
  await sleep(4000);
  await shot(cdp, "01-newkey-dialog");
  // form mu acti? (isim vs. girebilir)
  const dlg = await ev(`(() => ({
    inputs: [...document.querySelectorAll("input")].filter(i=>i.type!=="hidden"&&(i.offsetWidth||i.offsetHeight)).map(i=>({name:i.name,type:i.type,v:(i.value||"").slice(0,60)})),
    text: document.body.innerText.slice(0, 600),
  }))()`);
  console.log(JSON.stringify(dlg, null, 1));
  // diyalogda input varsa doldur + submit
  const nameInp = (dlg.inputs ?? []).find((i) => /desc|name|label|comment/i.test(i.name));
  if (nameInp) {
    // JS ile deger set et + requestSubmit (bu sitede koordinat tik calismiyor)
    console.log("desc set:", await ev(`(() => {
      const el = document.querySelector('[name="description"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "Phishing report automation (PBD project)");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    })()`));
    console.log("submit:", await ev(`(() => {
      const el = document.querySelector('[name="description"]');
      const f = el.closest("form");
      if (!f) return "form yok";
      const b = f.querySelector('button[type="submit"],input[type="submit"]') || [...f.querySelectorAll("button")].pop();
      f.requestSubmit ? f.requestSubmit(b || undefined) : f.submit();
      return "ok";
    })()`));
    await sleep(7000);
    await shot(cdp, "02-key-created");
  }
  // key'i yakala: uuid formatinda olur (xxxxxxxx-xxxx-...)
  const key = await ev(`(() => {
    const m = document.body.innerText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (m) return m[0];
    const el = [...document.querySelectorAll("input")].find(i => /[0-9a-f-]{30,}/i.test(i.value||""));
    return el ? el.value : null;
  })()`);
  console.log("API KEY:", key || "bulunamadi");
  if (key) {
    creds.apiKey = key;
    writeFileSync(CREDS, JSON.stringify(creds, null, 2));
    console.log("kaydedildi");
  } else {
    await shot(cdp, "03-nokey");
    console.log("sayfa:", ((await ev(`document.body.innerText.slice(0,800)`)) || "").replace(/\n+/g, " | ").slice(0, 500));
    process.exitCode = 1;
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
