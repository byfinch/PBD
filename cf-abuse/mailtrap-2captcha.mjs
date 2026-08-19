#!/usr/bin/env node
/** mailtrap-2captcha.mjs — Mailtrap signup, 2Captcha token enjeksiyonu ile */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile, loadEnv } from "./lib/mlx.mjs";
import { waitForLink } from "./lib/mailpit.mjs";
import { solveRecaptchaV2 } from "./lib/twocaptcha.mjs";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

loadEnv();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const EMAIL = "secops.kemal@meridyendijital.com";
const PASSWORD = "Pbd!" + randomBytes(6).toString("hex") + "Z9";
const CREDS = resolve(EV, "mailtrap-creds.json");
writeFileSync(CREDS, JSON.stringify({ email: EMAIL, password: PASSWORD }, null, 2));
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `mt2-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-04");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value);

// signup POST izleme
let signupPosted = false;
let signupRespStatus = 0;
{
  const prev = cdp.ws.onmessage;
  let lastReqId = null;
  cdp.ws.onmessage = (ev2) => {
    const m = JSON.parse(ev2.data);
    if (m.method === "Network.requestWillBeSent" && m.params.request.method === "POST" && /mailtrap\.io/.test(m.params.request.url) && !/\.(js|css|png)/.test(m.params.request.url)) {
      signupPosted = true;
      lastReqId = m.params.requestId;
      console.log("POST:", m.params.request.url.slice(0, 90));
    }
    if (m.method === "Network.responseReceived" && m.params.requestId === lastReqId) {
      signupRespStatus = m.params.response.status;
      console.log("POST yanit:", signupRespStatus);
    }
    prev(ev2);
  };
}
await cdp.enableNetwork();

async function typeInto(sel, text) {
  await cdp.focusSelector(sel);
  await sleep(400);
  await cdp.typeText(text, 45);
  await sleep(300);
}

try {
  await cdp.navigate("https://mailtrap.io/register/signup");
  await sleep(12000);
  for (let i = 0; i < 8; i++) { if (await ev(`!!document.getElementById("user_email")`)) break; await sleep(3000); }
  await typeInto("#user_email", EMAIL);
  await typeInto("#user_password", PASSWORD);
  await typeInto("#user_password_confirmation", PASSWORD);
  await shot(cdp, "01-filled");

  // sayfadaki sitekey'leri oku (signup formuna ait olani bul)
  const keys = await ev(`[...document.querySelectorAll("iframe")].map(f => (f.src.match(/[?&]k=([^&]+)/) || [])[1]).filter(Boolean)`);
  console.log("sitekeyler:", JSON.stringify(keys));
  const sitekey = keys?.[0];
  if (!sitekey) throw new Error("sitekey yok");

  console.log("2captcha cozuluyor...");
  const token = await solveRecaptchaV2({
    apiKey: process.env.TWOCAPTCHA_API_KEY,
    sitekey,
    pageurl: "https://mailtrap.io/register/signup",
    invisible: true,
  });
  console.log("token OK");
  // tum g-recaptcha-response textarealarina enjekte et
  console.log("enjekte:", await ev(`(() => {
    const tas = [...document.querySelectorAll('[id^="g-recaptcha-response"], [name="g-recaptcha-response"]')];
    for (const ta of tas) { ta.value = ${JSON.stringify(token)}; ta.dispatchEvent(new Event("input", { bubbles: true })); }
    return tas.length + " adet";
  })()`));

  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll('input[type="submit"]')].find(x => /^sign up$/i.test(x.value||"") && (x.offsetWidth||x.offsetHeight));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  await cdp.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
  console.log("Sign Up tiklandi");
  await sleep(6000);
  // tik gercekten POST yapti mi? yapmediysa requestSubmit
  if (!signupPosted) {
    console.log("POST yok — requestSubmit deneniyor...");
    await ev(`(() => {
      const b = [...document.querySelectorAll('input[type="submit"]')].find(x => /^sign up$/i.test(x.value||""));
      const f = b.closest("form");
      f.requestSubmit ? f.requestSubmit(b) : f.submit();
      return 1;
    })()`);
  }
  await sleep(10000);
  await shot(cdp, "02-after-submit");
  console.log("url:", await ev(`location.href`));
  console.log("sayfa:", ((await ev(`document.body.innerText.slice(0,500)`)) || "").replace(/\n+/g, " | ").slice(0, 350));

  // onay maili
  console.log("mail bekleniyor...");
  const mail = await waitForLink(EMAIL, /mailtrap\.io[^\s"'<>]*/i, { sinceMs: Date.now() - 120000, maxWaitMs: 200000, subjectRe: /confirm/i });
  if (!mail) throw new Error("onay maili gelmedi");
  console.log("onay link:", mail.link);
  await cdp.navigate(mail.link);
  await sleep(12000);
  await shot(cdp, "03-confirmed");
  console.log("onay sonrasi:", ((await ev(`document.body.innerText.slice(0,300)`)) || "").replace(/\n+/g, " | ").slice(0, 250));
  console.log("url:", await ev(`location.href`));
  console.log("MAILTRAP_HESAP_OK");
} catch (err) {
  console.log("HATA:", String(err).slice(0, 300));
  await shot(cdp, "err").catch(() => {});
  process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
