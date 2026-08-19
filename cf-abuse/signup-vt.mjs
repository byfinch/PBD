#!/usr/bin/env node
/**
 * signup-vt.mjs — VirusTotal hesap ac + mail dogrula + API key al
 * kullanim: node signup-vt.mjs [--profile PBD-05]
 */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { waitForLink, messagesFor, messageBody } from "./lib/mailpit.mjs";
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

const EMAIL = args.email || "secops.kemal@meridyendijital.com";
const FIRST = "Kemal", LAST = "Secer";
const USERNAME = args.username || ("kemalsecer" + randomBytes(2).toString("hex"));
const PASSWORD = args.password || ("Pbd!" + randomBytes(6).toString("hex") + "Z9");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `signup-vt-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === (args.profile || "PBD-05"));
console.log(`profil: ${profile.name} | ${EMAIL} | user:${USERNAME}`);

const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);

const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => r.result.value);
async function setVal(id, value) {
  return ev(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return "YOK";
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? "OK" : "FAIL";
  })()`);
}

try {
  await cdp.navigate("https://www.virustotal.com/gui/join-us");
  await sleep(9000);
  // cookie banner kapat
  await ev(`(() => { const b=[...document.querySelectorAll("button")].find(x=>/^(ok|accept)/i.test((x.innerText||"").trim())); if(b){b.click();return "kapatildi"} return "yok" })()`).then((r)=>console.log("cookie banner:", r));
  await sleep(1000);
  await shot(cdp, "01-form");

  console.log("firstName:", await setVal("firstName", FIRST));
  console.log("lastName:", await setVal("lastName", LAST));
  console.log("email:", await setVal("email", EMAIL));
  console.log("userId:", await setVal("userId", USERNAME));
  console.log("password:", await setVal("password", PASSWORD));
  console.log("passwordRepeat:", await setVal("passwordRepeat", PASSWORD));
  await ev(`(() => { const el = document.getElementById("tosCheckbox"); if (!el.checked) el.click(); return el.checked; })()`);
  console.log("tos:", await ev(`document.getElementById("tosCheckbox").checked`));
  await shot(cdp, "02-filled");

  const btnBox = await cdp.box("#submit");
  if (!btnBox) throw new Error("submit butonu yok");
  await cdp.click(btnBox.x + btnBox.w / 2, btnBox.y + btnBox.h / 2);
  console.log("Join us tiklandi");
  await sleep(6000);

  // submit sonrasi reCAPTCHA v2 checkbox overlay'i cikiyor — iframe gec yuklenebiliyor, poll et
  let rcInfo = null;
  for (let i = 0; i < 15 && !rcInfo; i++) {
    rcInfo = await ev(`(() => {
      const f = [...document.querySelectorAll("iframe")].find(x => (x.src||"").includes("recaptcha") && (x.src||"").includes("anchor"));
      if (!f) return null;
      const r = f.getBoundingClientRect();
      if (r.width < 10) return null;
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    if (!rcInfo) await sleep(2000);
  }
  if (rcInfo) {
    console.log("recaptcha checkbox cikti:", JSON.stringify(rcInfo));
    await shot(cdp, "03-captcha");
    // insan benzeri: sayfada birkac rastgele hareket, checkbox uzerinde hover, sonra tik
    const cx = rcInfo.x + 28, cy = rcInfo.y + rcInfo.h / 2;
    for (const [mx, my] of [[cx - 220, cy - 120], [cx - 140, cy - 60], [cx - 80, cy - 20], [cx - 30, cy - 5]]) {
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: mx, y: my });
      await sleep(250 + Math.random() * 300);
    }
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
    await sleep(1200 + Math.random() * 800);
    await cdp.click(cx, cy);
    await sleep(6000);
    // challenge (resim secme) acildi mi?
    const chal = await ev(`(() => {
      const bf = [...document.querySelectorAll("iframe")].find(f => (f.src||"").includes("recaptcha/api2/bframe"));
      if (!bf) return false;
      const r = bf.getBoundingClientRect();
      const st = getComputedStyle(bf.closest("div") || bf);
      return r.width > 100 && r.height > 100 && st.visibility !== "hidden" && st.opacity !== "0";
    })()`);
    await shot(cdp, "03b-after-captcha-click");
    if (chal) {
      await sleep(8000);
      const done = await ev(`(document.getElementById("g-recaptcha-response")||{}).value?.length > 0`);
      if (!done) throw new Error("RECAPTCHA_CHALLENGE — resim secme cikti, manuel gerekli");
    }
    for (let i = 0; i < 30; i++) {
      const ok = await ev(`(document.getElementById("g-recaptcha-response")||{}).value?.length > 0`);
      if (ok) { console.log("captcha token OK"); break; }
      if (i % 4 === 3) {
        const chalNow = await ev(`(() => {
          const bf = [...document.querySelectorAll("iframe")].find(f => (f.src||"").includes("recaptcha/api2/bframe"));
          if (!bf) return false;
          const r = bf.getBoundingClientRect();
          return r.width > 100 && r.height > 100;
        })()`);
        if (chalNow) { await shot(cdp, "03c-challenge"); throw new Error("RECAPTCHA_CHALLENGE — resim secme cikti, manuel gerekli"); }
      }
      await sleep(2500);
      if (i === 29) throw new Error("captcha token alinamadi");
    }
    // token sonrasi formu tekrar submit et
    await sleep(2000);
    const b2 = await cdp.box("#submit");
    if (b2) { await cdp.click(b2.x + b2.w / 2, b2.y + b2.h / 2); console.log("tekrar Join us tiklandi"); }
  }
  await sleep(10000);
  await shot(cdp, "03-after-submit");
  let bodyTxt = (await ev(`document.body.innerText.slice(0,1500)`)) || "";
  console.log("sayfa:", bodyTxt.slice(0, 400).replace(/\n+/g, " | "));
  if (/captcha|challenge|select all/i.test(bodyTxt)) throw new Error("CAPTCHA_CHALLENGE — manuel gerekli");

  // dogrulama maili
  console.log("dogrulama maili bekleniyor...");
  const since = Date.now() - 180000;
  const mail = await waitForLink(EMAIL, /virustotal\.com[^\s"'<>]*(verify|confirm|activate)[^\s"'<>]*/i, { sinceMs: since, maxWaitMs: 180000 });
  if (!mail) {
    // belki baska formatta link — tum mailleri dok
    const msgs = await messagesFor(EMAIL, since);
    console.log("gelen mailler:", msgs.map((m) => m.Subject).join(" || ") || "yok");
    if (msgs.length) {
      const b = await messageBody(msgs[0].ID);
      const any = (b.html || b.text).match(/https?:\/\/[^\s"'<>]+/g);
      console.log("linkler:", (any || []).slice(0, 8).join("\n"));
    }
    throw new Error("dogrulama maili gelmedi");
  }
  console.log("dogrulama link:", mail.link);
  await cdp.navigate(mail.link);
  await sleep(9000);
  await shot(cdp, "04-verified");
  console.log("dogrulama sayfasi:", ((await ev(`document.body.innerText.slice(0,500)`)) || "").replace(/\n+/g, " | "));

  // login durumunu kontrol et, gerekirse giris yap
  const needLogin = await ev(`!!document.querySelector('input[type="password"]')`);
  if (needLogin) {
    console.log("login gerekiyor...");
    // VT sign-in: email/username + password alanlari
    const ids = await ev(`[...document.querySelectorAll("input")].map(i=>i.id||i.name||i.type).join(",")`);
    console.log("login alanlari:", ids);
    await setVal("email", EMAIL).then((r) => console.log("login email:", r));
    await setVal("password", PASSWORD).then((r) => console.log("login pass:", r));
    const lb = await cdp.box('button[type="submit"]');
    if (lb) await cdp.click(lb.x + lb.w / 2, lb.y + lb.h / 2);
    await sleep(9000);
    await shot(cdp, "05-after-login");
  }

  // API key sayfasi
  await cdp.navigate("https://www.virustotal.com/gui/my-apikey");
  await sleep(9000);
  await shot(cdp, "06-apikey");
  const key = await ev(`(() => {
    const t = document.body.innerText;
    const m = t.match(/[0-9a-f]{64}/i);
    if (m) return m[0];
    const el = document.querySelector("input[readonly],input[disabled]");
    return el ? el.value : null;
  })()`);
  console.log("API KEY:", key || "bulunamadi");
  appendFileSync(resolve(EV, "signup-vt-result.json"),
    JSON.stringify({ email: EMAIL, password: PASSWORD, username: USERNAME, apiKey: key, ts: new Date().toISOString() }) + "\n");
  if (!key) throw new Error("API key sayfada bulunamadi — screenshot kontrol");
  console.log("VT OK");
} catch (err) {
  console.log("HATA:", String(err).slice(0, 300));
  await shot(cdp, "err").catch(() => {});
  process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
