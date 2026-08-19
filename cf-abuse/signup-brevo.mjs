#!/usr/bin/env node
/**
 * signup-brevo.mjs — Brevo hesap ac + mail dogrula + SMTP key al
 * kullanim: node signup-brevo.mjs [--profile PBD-02]
 */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { waitForLink } from "./lib/mailpit.mjs";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

const EMAIL = args.email || "secops.kemal@meridyendijital.com";
const PASSWORD = args.password || ("Pbd!" + randomBytes(6).toString("hex") + "Z9");
const CREDS = resolve(EV, "brevo-creds.json");
writeFileSync(CREDS, JSON.stringify({ email: EMAIL, password: PASSWORD }, null, 2));
console.log("creds kaydedildi:", CREDS);
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `signup-brevo-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === (args.profile || "PBD-02"));
console.log(`profil: ${profile.name} | ${EMAIL}`);

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
  await cdp.navigate("https://onboarding.brevo.com/account/register");
  await sleep(10000);
  // cookie banner
  await ev(`(() => { const b = document.getElementById("onetrust-reject-all-handler"); if (b) { b.click(); return "reddedildi"; } return "yok"; })()`).then((r) => console.log("cookie:", r));
  await sleep(1500);
  await shot(cdp, "01-form");

  console.log("email:", await setVal("#email", EMAIL));
  console.log("password:", await setVal("#password", PASSWORD));
  await shot(cdp, "02-filled");

  const btnBox = await cdp.box("#register-form-create-button");
  if (!btnBox) throw new Error("create butonu yok");
  await cdp.click(btnBox.x + btnBox.w / 2, btnBox.y + btnBox.h / 2);
  console.log("Create your account tiklandi");
  await sleep(12000);
  await shot(cdp, "03-after-submit");
  let txt = ((await ev(`document.body.innerText.slice(0,1500)`)) || "").replace(/\n+/g, " | ");
  console.log("sayfa:", txt.slice(0, 500));

  // captcha challenge kontrolu
  const chal = await ev(`(() => {
    const bf = [...document.querySelectorAll("iframe")].find(f => (f.src||"").includes("bframe"));
    if (!bf) return false;
    const r = bf.getBoundingClientRect();
    return r.width > 100 && r.height > 100;
  })()`);
  if (chal) throw new Error("RECAPTCHA_CHALLENGE — manuel gerekli");

  // onboarding adimlari (profil sorulari) gelebilir — dogrulama maili onceden gelir
  console.log("dogrulama maili bekleniyor...");
  const mail = await waitForLink(EMAIL, /brevo\.(com|io)[^\s"'<>]*(confirm|valid|verif|activate)[^\s"'<>]*/i, { sinceMs: Date.now() - 180000, maxWaitMs: 180000 });
  if (!mail) {
    console.log("UYARI: brevo dogrulama maili bulunamadi (onboarding devam edebilir)");
  } else {
    console.log("dogrulama link:", mail.link);
    await cdp.navigate(mail.link);
    await sleep(9000);
    await shot(cdp, "04-verified");
    console.log("dogrulama sonrasi:", ((await ev(`document.body.innerText.slice(0,400)`)) || "").replace(/\n+/g, " | ").slice(0, 300));
  }
  console.log("BREVO_KAYIT_ASAMA_OK — onboarding/SMTP adimi ayri scriptte");
} catch (err) {
  console.log("HATA:", String(err).slice(0, 300));
  await shot(cdp, "err").catch(() => {});
  process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
