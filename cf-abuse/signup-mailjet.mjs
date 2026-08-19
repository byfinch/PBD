#!/usr/bin/env node
/**
 * signup-mailjet.mjs — Mailjet hesap ac + mail dogrula + SMTP/API key al
 * kullanim: node signup-mailjet.mjs [--profile PBD-06]
 */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { waitForLink } from "./lib/mailpit.mjs";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

const EMAIL = args.email || "secops.kemal@meridyendijital.com";
const PASSWORD = args.password || ("Pbd!" + randomBytes(6).toString("hex") + "Z9");
const CREDS = resolve(EV, "mailjet-creds.json");
writeFileSync(CREDS, JSON.stringify({ email: EMAIL, password: PASSWORD }, null, 2));
console.log("creds:", CREDS);
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `signup-mj-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === (args.profile || "PBD-06"));
console.log(`profil: ${profile.name} | ${EMAIL}`);

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
  await cdp.navigate("https://app.mailjet.com/signup");
  await sleep(18000);
  await ev(`(() => { const b = document.getElementById("onetrust-reject-all-handler"); if (b) { b.click(); return 1; } return 0; })()`);
  await sleep(1000);
  for (let i = 0; i < 10; i++) { if (await ev(`!!document.getElementById("firstName")`)) break; await sleep(3000); }
  console.log("firstName:", await typeInto("#firstName", "Kemal"));
  console.log("lastName:", await typeInto("#lastName", "Secer"));
  console.log("email:", await typeInto("#email", EMAIL));
  console.log("password:", await typeInto("#password", PASSWORD));
  await shot(cdp, "01-filled");

  const btn = await cdp.box("#create-account-btn");
  if (!btn) throw new Error("create butonu yok");
  await cdp.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
  console.log("Create account tiklandi");
  await sleep(8000);
  await shot(cdp, "02-after-submit");

  // recaptcha checkbox gorunur oldu mu?
  let rcBox = null;
  for (let i = 0; i < 8 && !rcBox; i++) {
    rcBox = await ev(`(() => {
      const f = [...document.querySelectorAll("iframe")].find(x => (x.src||"").includes("recaptcha") && (x.src||"").includes("anchor"));
      if (!f) return null;
      const r = f.getBoundingClientRect();
      if (r.width < 10) return null;
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    if (!rcBox) await sleep(2000);
  }
  if (rcBox) {
    console.log("recaptcha gorunur:", JSON.stringify(rcBox));
    // insan benzeri yaklasim: kavisli hover, bekle, tik
    const cx = rcBox.x + 28, cy = rcBox.y + rcBox.h / 2;
    for (const [mx, my] of [[cx - 240, cy - 130], [cx - 150, cy - 70], [cx - 80, cy - 25], [cx - 30, cy - 6]]) {
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: mx, y: my });
      await sleep(280 + Math.random() * 320);
    }
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
    await sleep(1300 + Math.random() * 900);
    await cdp.click(cx, cy);
    await sleep(6000);
    await shot(cdp, "03-captcha-clicked");
    let chal = await ev(`(() => {
      const bf = [...document.querySelectorAll("iframe")].find(f => (f.src||"").includes("bframe"));
      if (!bf) return false;
      const r = bf.getBoundingClientRect();
      return r.width > 100 && r.height > 100;
    })()`);
    if (chal) {
      console.log("challenge cikti — 30sn beklenip tekrar bakilacak");
      await sleep(30000);
      const tok = await ev(`(document.getElementById("g-recaptcha-response")||{}).value?.length > 0`);
      if (!tok) throw new Error("RECAPTCHA_CHALLENGE — manuel gerekli");
      chal = false;
    }
    for (let i = 0; i < 20; i++) {
      const ok = await ev(`(document.getElementById("g-recaptcha-response")||{}).value?.length > 0`);
      if (ok) { console.log("captcha token OK"); break; }
      await sleep(2500);
      if (i === 19) throw new Error("captcha token alinamadi");
    }
    const b2 = await cdp.box("#create-account-btn");
    if (b2) { await cdp.click(b2.x + b2.w / 2, b2.y + b2.h / 2); console.log("tekrar submit"); }
    await sleep(8000);
  }
  await shot(cdp, "04-after-all");
  let txt = ((await ev(`document.body.innerText.slice(0,800)`)) || "").replace(/\n+/g, " | ");
  console.log("sayfa:", txt.slice(0, 400));
  console.log("url:", await ev(`location.href`));

  // dogrulama maili
  console.log("mail bekleniyor...");
  const mail = await waitForLink(EMAIL, /mailjet\.com[^\s"'<>]*(confirm|verif|activat|validate)[^\s"'<>]*/i, { sinceMs: Date.now() - 180000, maxWaitMs: 180000 });
  if (!mail) {
    console.log("UYARI: mailjet maili bulunamadi");
  } else {
    console.log("dogrulama link:", mail.link);
    await cdp.navigate(mail.link);
    await sleep(10000);
    await shot(cdp, "05-verified");
    console.log("dogrulama sonrasi:", ((await ev(`document.body.innerText.slice(0,400)`)) || "").replace(/\n+/g, " | ").slice(0, 300));
    console.log("url:", await ev(`location.href`));
  }
  console.log("MJ_KAYIT_ASAMA_OK");
} catch (err) {
  console.log("HATA:", String(err).slice(0, 300));
  await shot(cdp, "err").catch(() => {});
  process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
