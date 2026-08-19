#!/usr/bin/env node
/** urlscan-finalize.mjs — aktivasyon + login + API key uret */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const CREDS = resolve(EV, "urlscan-creds.json");
const creds = JSON.parse(readFileSync(CREDS, "utf8"));
const ACT = "https://urlscan.io/user/signup/01a01752-63e9-77d3-8f47-04656c9e3da9/";
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `urlscan4-${tag}-${Date.now()}.jpg`), 70, true);

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
  // 1) aktivasyon — Finish! butonuna bas
  await cdp.navigate(ACT);
  await sleep(9000);
  await shot(cdp, "01-activation");
  console.log("aktivasyon:", ((await ev(`document.body.innerText.slice(0,500)`)) || "").replace(/\n+/g, " | ").slice(0, 300));
  await ev(`(() => { const f = document.forms[0]; if (f) { const b = document.querySelector('button[type="submit"],input[type="submit"]'); f.requestSubmit ? f.requestSubmit(b||undefined) : f.submit(); } return 1; })()`);
  await sleep(9000);
  await shot(cdp, "01b-finished");
  console.log("finish sonrasi:", ((await ev(`document.body.innerText.slice(0,400)`)) || "").replace(/\n+/g, " | ").slice(0, 250));
  console.log("url:", await ev(`location.href`));

  // 2) login
  {
    await cdp.navigate("https://urlscan.io/user/login/");
    await sleep(8000);
    console.log("email:", await setVal("email", creds.email));
    console.log("password:", await setVal("password", creds.password));
    await ev(`(() => { const f = document.forms[0]; const b = document.querySelector('button[type="submit"],input[type="submit"]'); f.requestSubmit ? f.requestSubmit(b||undefined) : f.submit(); return 1; })()`);
    await sleep(9000);
    await shot(cdp, "03-after-login");
    console.log("login sonrasi:", ((await ev(`document.body.innerText.slice(0,400)`)) || "").replace(/\n+/g, " | ").slice(0, 250));
    console.log("url:", await ev(`location.href`));
  }

  // 3) profil sayfasi — API key
  await cdp.navigate("https://urlscan.io/user/profile/");
  await sleep(9000);
  await shot(cdp, "04-profile");
  const prof = await ev(`(() => ({
    url: location.href,
    text: document.body.innerText.slice(0, 1000),
    inputs: [...document.querySelectorAll("input")].filter(i=>i.type!=="hidden"&&(i.offsetWidth||i.offsetHeight)).map(i=>({name:i.name,type:i.type,v:(i.value||"").slice(0,50),ro:i.readOnly})),
    buttons: [...document.querySelectorAll("button,a")].filter(b=>(b.offsetWidth||b.offsetHeight)&&/key|api|create|generate|new/i.test(b.innerText||"")).map(b=>(b.innerText||"").trim().slice(0,40)),
  }))()`);
  console.log(JSON.stringify(prof, null, 1));
} catch (err) {
  console.log("HATA:", String(err).slice(0, 300));
  await shot(cdp, "err").catch(() => {});
  process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
