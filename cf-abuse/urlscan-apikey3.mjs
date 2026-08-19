#!/usr/bin/env node
/** urlscan-apikey3.mjs — dogru seciciyle API key olustur */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const CREDS = resolve(EV, "urlscan-creds.json");
const creds = JSON.parse(readFileSync(CREDS, "utf8"));
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `urlscan7-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-03");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value);
async function setVal(sel, value) {
  return ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return "YOK";
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? "OK" : "FAIL";
  })()`);
}

try {
  await cdp.navigate("https://urlscan.io/user/login/");
  await sleep(8000);
  if (await ev(`!!document.querySelector('input[name="password"]')`)) {
    await setVal('input[name="email"]', creds.email);
    await setVal('input[name="password"]', creds.password);
    await ev(`(() => { const f = document.forms[0]; const b = document.querySelector('button[type="submit"],input[type="submit"]'); f.requestSubmit ? f.requestSubmit(b||undefined) : f.submit(); return 1; })()`);
    await sleep(9000);
  }
  await cdp.navigate("https://urlscan.io/user/profile/");
  await sleep(8000);
  await ev(`(() => { const b = [...document.querySelectorAll("button,a")].find(x => /new api key/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight)); if (b) b.click(); return 1; })()`);
  await sleep(4000);
  console.log("desc:", await setVal('input[name="description"]', "Phishing report automation (PBD project)"));
  console.log("submit:", await ev(`(() => {
    const el = document.querySelector('input[name="description"]');
    const f = el.closest("form");
    if (!f) return "form yok";
    const b = f.querySelector('button[type="submit"],input[type="submit"]') || [...f.querySelectorAll("button")].pop();
    f.requestSubmit ? f.requestSubmit(b || undefined) : f.submit();
    return "ok";
  })()`));
  await sleep(8000);
  await shot(cdp, "01-created");
  const key = await ev(`(() => {
    const m = document.body.innerText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (m) return m[0];
    const el = [...document.querySelectorAll("input")].find(i => /[0-9a-f-]{30,}/i.test(i.value||""));
    return el ? el.value : null;
  })()`);
  console.log("API KEY:", key || "bulunamadi");
  console.log("sayfa:", ((await ev(`document.body.innerText.slice(0,700)`)) || "").replace(/\n+/g, " | ").slice(0, 450));
  if (key) {
    creds.apiKey = key;
    writeFileSync(CREDS, JSON.stringify(creds, null, 2));
    console.log("kaydedildi");
  } else process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
