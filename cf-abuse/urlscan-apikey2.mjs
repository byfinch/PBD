#!/usr/bin/env node
/** urlscan-apikey2.mjs — description input'unun yerini bul (iframe?) */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const creds = JSON.parse(readFileSync(resolve(EV, "urlscan-creds.json"), "utf8"));

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-03");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text);
async function setVal(name, value) {
  return ev(`(() => {
    const el = document.querySelector('[name="${name}"]');
    if (!el) return "YOK";
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "OK";
  })()`);
}

try {
  await cdp.navigate("https://urlscan.io/user/login/");
  await sleep(8000);
  if (await ev(`!!document.querySelector('input[name="password"]')`)) {
    await setVal("email", creds.email);
    await setVal("password", creds.password);
    await ev(`(() => { const f = document.forms[0]; const b = document.querySelector('button[type="submit"],input[type="submit"]'); f.requestSubmit ? f.requestSubmit(b||undefined) : f.submit(); return 1; })()`);
    await sleep(9000);
  }
  await cdp.navigate("https://urlscan.io/user/profile/");
  await sleep(8000);
  await ev(`(() => { const b = [...document.querySelectorAll("button,a")].find(x => /new api key/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight)); if (b) b.click(); return 1; })()`);
  await sleep(4000);
  const info = await ev(`(() => {
    const el = document.querySelector('input[name="description"]') || [...document.querySelectorAll("input[type=text]")].find(i => i.offsetWidth || i.offsetHeight);
    return {
      found: !!el,
      name: el?.name,
      formAction: el?.closest("form")?.action ?? null,
      elOuter: el ? el.outerHTML.slice(0, 250) : null,
      visible: el ? !!(el.offsetWidth || el.offsetHeight) : null,
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await cdp.screenshot(resolve(EV, `urlscan6-${Date.now()}.jpg`), 70, true);
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
