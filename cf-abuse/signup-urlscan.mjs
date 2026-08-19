#!/usr/bin/env node
/**
 * signup-urlscan.mjs — urlscan.io hesap ac + mail dogrula + API key al
 * kullanim: node signup-urlscan.mjs [--profile PBD-03] [--email x@y] [--name "Ad Soyad"]
 */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile, loadEnv } from "./lib/mlx.mjs";
loadEnv();
import { waitForLink } from "./lib/mailpit.mjs";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

const EMAIL = args.email || "secops.kemal@meridyendijital.com";
const NAME = args.name || "Kemal Secer";
const [FIRST, ...rest] = NAME.split(" ");
const LAST = rest.join(" ") || "Secer";
const PASSWORD = args.password || ("Pbd!" + randomBytes(6).toString("hex") + "Z9");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `signup-urlscan-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === (args.profile || "PBD-03"));
console.log(`profil: ${profile.name} | ${EMAIL} | ${NAME}`);

const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);

/** React-safe deger set + input event */
async function setVal(name, value) {
  const r = await cdp.call("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const el = document.querySelector('[name="${name}"]');
      if (!el) return "YOK";
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value === ${JSON.stringify(value)} ? "OK" : "FAIL:" + el.value;
    })()`,
  });
  return r.result.value;
}
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => r.result.value);

try {
  await cdp.navigate("https://urlscan.io/user/signup");
  await sleep(8000);
  await shot(cdp, "01-form");

  console.log("firstname:", await setVal("firstname", FIRST));
  console.log("lastname:", await setVal("lastname", LAST));
  console.log("username:", await setVal("username", EMAIL));
  console.log("password:", await setVal("password", PASSWORD));
  console.log("company:", await setVal("company", "Meridyen Dijital"));
  console.log("title:", await setVal("title", "Security Analyst"));

  // terms checkbox — DOM click (sentetik yeterli, captcha mantigi yok)
  await ev(`(() => { const el = document.querySelector('[name="termsAndConditions"]'); el.click(); return el.checked; })()`);
  await sleep(600);
  console.log("terms isaretli:", await ev(`document.querySelector('[name="termsAndConditions"]').checked`));

  // reCAPTCHA v2 — 2Captcha ile token coz + enjekte et
  {
    await shot(cdp, "02-before-captcha");
    const { solveRecaptchaV2 } = await import("./lib/twocaptcha.mjs");
    console.log("2captcha cozuluyor...");
    const token = await solveRecaptchaV2({
      apiKey: process.env.TWOCAPTCHA_API_KEY,
      sitekey: "6LdpjT8UAAAAAG_0TXCcMTAKBSnUBiU4M8YfQtvM",
      pageurl: "https://urlscan.io/user/signup",
    });
    console.log("token alindi, enjekte ediliyor");
    await ev(`(() => {
      const ta = document.getElementById("g-recaptcha-response");
      ta.value = ${JSON.stringify(token)};
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      return ta.value.length;
    })()`).then((r) => console.log("textarea len:", r));
    await shot(cdp, "03-token-injected");
  }

  await shot(cdp, "04-filled");
  const btnBox = await cdp.box('button[type="submit"]');
  if (!btnBox) throw new Error("submit butonu yok");
  await cdp.click(btnBox.x + btnBox.w / 2, btnBox.y + btnBox.h / 2);
  console.log("Create account tiklandi");
  await sleep(10000);
  await shot(cdp, "05-after-submit");
  const bodyTxt = await ev(`document.body.innerText.slice(0,2000)`);
  console.log("sayfa:", (bodyTxt || "").slice(0, 400));
  if (/error|invalid|already|spam/i.test(bodyTxt || "") && !/activat|verif|email.*sent|check your/i.test(bodyTxt || ""))
    console.log("UYARI: olasi hata mesaji var — screenshot kontrol et");

  // activation maili bekle
  console.log("activation maili bekleniyor...");
  const since = Date.now() - 120000;
  const mail = await waitForLink(EMAIL, /urlscan\.io\/(user\/)?(activate|verify|confirm)[^\s"'<>]*/i, { sinceMs: since, maxWaitMs: 150000 });
  if (!mail) throw new Error("activation maili gelmedi");
  console.log("activation link:", mail.link);
  await cdp.navigate(mail.link);
  await sleep(8000);
  await shot(cdp, "06-activated");
  console.log("aktivasyon sayfasi:", (await ev(`document.body.innerText.slice(0,600)`)) || "");

  // login gerekirse
  if (/login|sign in/i.test((await ev(`location.href`)) || "") || (await ev(`!!document.querySelector('input[type="password"]')`))) {
    console.log("login gerekiyor...");
    await setVal("email", EMAIL);
    await setVal("password", PASSWORD);
    const lb = await cdp.box('button[type="submit"]');
    if (lb) await cdp.click(lb.x + lb.w / 2, lb.y + lb.h / 2);
    await sleep(8000);
  }

  // API key sayfasi
  await cdp.navigate("https://urlscan.io/user/profile");
  await sleep(6000);
  await shot(cdp, "07-profile");
  const profTxt = (await ev(`document.body.innerText`)) || "";
  console.log("profil sayfasi (snippet):", profTxt.slice(0, 500));
  appendFileSync(resolve(EV, "signup-urlscan-result.json"),
    JSON.stringify({ email: EMAIL, password: PASSWORD, name: NAME, ts: new Date().toISOString() }) + "\n");
  console.log("HESAP OK — API key cikarma asamasina gec");
} catch (err) {
  console.log("HATA:", String(err).slice(0, 300));
  await shot(cdp, "err").catch(() => {});
  process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
