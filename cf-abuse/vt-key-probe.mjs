#!/usr/bin/env node
/** vt-key-probe.mjs — acik VT oturumunda (PBD-08) apikey sayfasindan key cek */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const CREDS = resolve(EV, "vt-creds.json");
const creds = JSON.parse(readFileSync(CREDS, "utf8"));

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-08");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => r.result.value);

try {
  await cdp.navigate("https://www.virustotal.com/gui/my-apikey");
  await sleep(15000);
  // goz ikonuna tikla (blur kaldir) — svg/ikon butonu bul
  const eyeClicked = await ev(`(() => {
    const walk = (root, depth, cb) => {
      if (depth > 12) return;
      for (const el of root.querySelectorAll("*")) {
        cb(el);
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1, cb);
      }
    };
    let clicked = false;
    walk(document, 0, (el) => {
      if (clicked) return;
      const label = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title") || "")).toLowerCase();
      if (/show|reveal|eye|visibility/.test(label) && (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.tagName === "IRON-ICON" || el.tagName === "VT-UI-ICON")) {
        el.click(); clicked = label || el.tagName;
      }
    });
    return clicked;
  })()`);
  console.log("goz tiklandi:", eyeClicked || "bulunamadi");
  await sleep(2500);
  // tum shadow'lu metni tara, 64-hex yakala
  const key = await ev(`(() => {
    let text = document.body.innerText || "";
    const walk = (root, depth) => {
      if (depth > 12) return;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { text += "\\n" + (el.shadowRoot.textContent || ""); walk(el.shadowRoot, depth + 1); }
      }
    };
    walk(document, 0);
    const m = text.match(/[0-9a-f]{64}/i);
    return m ? m[0] : null;
  })()`);
  console.log("API KEY:", key || "bulunamadi");
  if (key) {
    creds.apiKey = key;
    writeFileSync(CREDS, JSON.stringify(creds, null, 2));
    console.log("kaydedildi");
  }
  await cdp.screenshot(resolve(EV, `vt-keyprobe-${Date.now()}.jpg`), 70, false);
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
