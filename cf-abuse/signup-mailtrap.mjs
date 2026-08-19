#!/usr/bin/env node
/** signup-mailtrap.mjs — Mailtrap hesap ac + mail dogrula */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { waitForLink } from "./lib/mailpit.mjs";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const EMAIL = "secops.kemal@meridyendijital.com";
const PASSWORD = "Pbd!" + randomBytes(6).toString("hex") + "Z9";
const CREDS = resolve(EV, "mailtrap-creds.json");
writeFileSync(CREDS, JSON.stringify({ email: EMAIL, password: PASSWORD }, null, 2));
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `signup-mt-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-08");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

async function typeInto(sel, text) {
  const ok = await cdp.focusSelector(sel);
  if (!ok) return "YOK";
  await sleep(400);
  await cdp.typeText(text, 45);
  await sleep(300);
  return ev(`(document.querySelector(${JSON.stringify(sel)})||{}).value`);
}

try {
  await cdp.navigate("https://mailtrap.io/register/signup");
  await sleep(12000);
  for (let i = 0; i < 8; i++) { if (await ev(`!!document.getElementById("user_email")`)) break; await sleep(3000); }
  console.log("email:", await typeInto("#user_email", EMAIL));
  console.log("pass:", await typeInto("#user_password", PASSWORD));
  console.log("conf:", await typeInto("#user_password_confirmation", PASSWORD));
  await shot(cdp, "01-filled");

  // Sign Up (input[type=submit][value="Sign Up"])
  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll('input[type="submit"]')].find(x => /^sign up$/i.test(x.value||"") && (x.offsetWidth||x.offsetHeight));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  if (!btn) throw new Error("Sign Up butonu yok");
  await cdp.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
  console.log("Sign Up tiklandi");
  await sleep(10000);
  await shot(cdp, "02-after-submit");
  // challenge kontrol
  const chal = await ev(`(() => {
    const bf = [...document.querySelectorAll("iframe")].find(f => (f.src||"").includes("bframe"));
    if (!bf) return false;
    const r = bf.getBoundingClientRect();
    return r.width > 100 && r.height > 100 && bf.offsetParent !== null;
  })()`);
  if (chal) throw new Error("RECAPTCHA_CHALLENGE — manuel gerekli");
  console.log("sayfa:", ((await ev(`document.body.innerText.slice(0,500)`)) || "").replace(/\n+/g, " | ").slice(0, 350));
  console.log("url:", await ev(`location.href`));

  console.log("mail bekleniyor...");
  const mail = await waitForLink(EMAIL, /mailtrap\.io[^\s"'<>]*(confirm|verif|activat)[^\s"'<>]*/i, { sinceMs: Date.now() - 180000, maxWaitMs: 180000 });
  if (!mail) throw new Error("mailtrap onay maili gelmedi");
  console.log("onay link:", mail.link);
  await cdp.navigate(mail.link);
  await sleep(12000);
  await shot(cdp, "03-confirmed");
  console.log("onay sonrasi:", ((await ev(`document.body.innerText.slice(0,400)`)) || "").replace(/\n+/g, " | ").slice(0, 300));
  console.log("url:", await ev(`location.href`));
  console.log("MT_KAYIT_OK");
} catch (err) {
  console.log("HATA:", String(err).slice(0, 300));
  await shot(cdp, "err").catch(() => {});
  process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
