#!/usr/bin/env node
/** brevo-smtp2.mjs — SMTP key uret ve degerini yakala */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const CREDS = resolve(EV, "brevo-creds.json");
const creds = JSON.parse(readFileSync(CREDS, "utf8"));
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-smtp2-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

const clickByText = async (re) => {
  const b = await ev(`(() => {
    const el = [...document.querySelectorAll("button,a")].find(x => ${re}.test((x.innerText||"").trim()) && (x.offsetWidth||x.offsetHeight));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  if (!b) return false;
  await cdp.click(b.x + b.w / 2, b.y + b.h / 2);
  return true;
};

try {
  await cdp.navigate("https://app.brevo.com/settings/keys/smtp");
  await sleep(15000);
  console.log("generate:", await clickByText("/generate smtp key/i"));
  await sleep(4000);
  await shot(cdp, "01-generate-dialog");
  // isim isteyebilir
  const dlg = await ev(`(() => {
    const inputs = [...document.querySelectorAll("input")].filter(i => i.type !== "hidden" && (i.offsetWidth||i.offsetHeight)).map(i => ({ id: i.id, ph: i.placeholder, v: i.value }));
    return { text: document.body.innerText.slice(0, 600), inputs };
  })()`);
  console.log(JSON.stringify(dlg, null, 1));
  const nameInput = (dlg.inputs ?? []).find((i) => /name|key/i.test(i.id + i.ph));
  if (nameInput) {
    await cdp.focusSelector("#" + nameInput.id);
    await sleep(300);
    await cdp.typeText("pbd-reports", 50);
    await sleep(500);
    console.log("isim girildi");
    // onay butonu (Generate/Create/OK)
    const ok = await ev(`(() => {
      const b = [...document.querySelectorAll("button")].find(x => /generate|create|ok|confirm|save/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight) && !/smtp key$/i.test((x.innerText||"").trim()));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, t: b.innerText.trim().slice(0,30) };
    })()`);
    console.log("onay butonu:", JSON.stringify(ok));
    if (ok) await cdp.click(ok.x + ok.w / 2, ok.y + ok.h / 2);
    await sleep(5000);
  }
  await shot(cdp, "02-key-shown");
  // key degerini yakala: input value, code, veya metin icinde xsmtpsib-*
  const key = await ev(`(() => {
    for (const i of document.querySelectorAll("input")) {
      if (/xsmtpsib-|^[A-Za-z0-9]{30,}$/.test(i.value || "")) return i.value;
    }
    const m = document.body.innerText.match(/xsmtpsib-[A-Za-z0-9]+/);
    if (m) return m[0];
    for (const el of document.querySelectorAll("code,pre,td,span,div")) {
      const t = (el.textContent||"").trim();
      if (/^xsmtpsib-[A-Za-z0-9]{20,}$/.test(t)) return t;
    }
    return null;
  })()`);
  console.log("SMTP KEY:", key ? key.slice(0, 14) + "..." + key.slice(-6) + " (len " + key.length + ")" : "bulunamadi");
  console.log("sayfa:", ((await ev(`document.body.innerText.slice(0,500)`)) || "").replace(/\n+/g, " | ").slice(0, 400));
  if (key) {
    creds.smtp = { host: "smtp-relay.brevo.com", port: 587, login: "b5f6c4001@smtp-brevo.com", key };
    writeFileSync(CREDS, JSON.stringify(creds, null, 2));
    console.log("kaydedildi:", CREDS);
  } else {
    process.exitCode = 1;
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
