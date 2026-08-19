#!/usr/bin/env node
/** urlscan-retry2.mjs — form.submit yollari + tum istekleri izle */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile, loadEnv } from "./lib/mlx.mjs";
import { waitForLink } from "./lib/mailpit.mjs";
import { solveRecaptchaV2 } from "./lib/twocaptcha.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

loadEnv();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const EMAIL = "secops.kemal@meridyendijital.com";
const PASSWORD = "Pbd!" + randomBytes(6).toString("hex") + "Z9";
writeFileSync(resolve(EV, "urlscan-creds.json"), JSON.stringify({ email: EMAIL, password: PASSWORD }, null, 2));
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `urlscan3-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-03");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

{
  const prev = cdp.ws.onmessage;
  cdp.ws.onmessage = (ev2) => {
    const m = JSON.parse(ev2.data);
    if (m.method === "Network.requestWillBeSent" && /urlscan\.io/.test(m.params.request.url) && m.params.request.method !== "GET")
      console.log("REQ:", m.params.request.method, m.params.request.url, "|", (m.params.request.postData || "").slice(0, 150));
    if (m.method === "Network.responseReceived" && /urlscan\.io\/(user|api)/.test(m.params.response.url))
      console.log("RESP:", m.params.response.status, m.params.response.url);
    prev(ev2);
  };
}
await cdp.enableNetwork();

async function setVal(name, value) {
  return ev(`(() => {
    const el = document.querySelector('[name="${name}"]');
    if (!el) return "YOK";
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? "OK" : "FAIL";
  })()`);
}

try {
  await cdp.navigate("https://urlscan.io/user/signup");
  await sleep(9000);
  await setVal("firstname", "Kemal"); await setVal("lastname", "Secer");
  await setVal("username", EMAIL); await setVal("password", PASSWORD);
  await setVal("company", "Meridyen Dijital"); await setVal("title", "Security Analyst");
  await ev(`(() => { const el = document.querySelector('[name="termsAndConditions"]'); if (!el.checked) el.click(); return el.checked; })()`);

  // form yapisini incele
  const formInfo = await ev(`(() => {
    const btn = document.querySelector('button[type="submit"]');
    const form = btn.closest("form");
    return {
      action: form?.action, method: form?.method, onsubmit: !!form?.onsubmit,
      btnOnclick: btn.getAttribute("onclick"), formHtml: form ? form.outerHTML.slice(0, 300) : null,
      nforms: document.forms.length,
    };
  })()`);
  console.log("form:", JSON.stringify(formInfo, null, 1));

  console.log("2captcha cozuluyor...");
  const token = await solveRecaptchaV2({
    apiKey: process.env.TWOCAPTCHA_API_KEY,
    sitekey: "6LdpjT8UAAAAAG_0TXCcMTAKBSnUBiU4M8YfQtvM",
    pageurl: "https://urlscan.io/user/signup",
  });
  console.log("token OK");
  await ev(`(() => {
    const ta = document.getElementById("g-recaptcha-response");
    ta.value = ${JSON.stringify(token)};
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return ta.value.length;
  })()`);

  // once gercek buton tiki, 5sn icinde navigasyon olmazsa requestSubmit
  const btnBox = await cdp.box('button[type="submit"]');
  await cdp.click(btnBox.x + btnBox.w / 2, btnBox.y + btnBox.h / 2);
  await sleep(5000);
  let url1 = await ev(`location.href`);
  console.log("tik sonrasi url:", url1);
  if (!/signup/.test(url1) === false) {
    // hala signup'tayiz — requestSubmit dene
    console.log("requestSubmit deneniyor...");
    await ev(`(() => {
      const btn = document.querySelector('button[type="submit"]');
      const form = btn.closest("form") || document.forms[0];
      form.requestSubmit ? form.requestSubmit(btn) : form.submit();
      return 1;
    })()`);
    await sleep(8000);
  }
  await shot(cdp, "01-after");
  console.log("son url:", await ev(`location.href`));
  console.log("sayfa:", ((await ev(`document.body.innerText.slice(0,600)`)) || "").replace(/\n+/g, " | ").slice(0, 350));

  console.log("mail bekleniyor...");
  const mail = await waitForLink(EMAIL, /urlscan\.io[^\s"'<>]*(activate|verify|confirm)[^\s"'<>]*/i, { sinceMs: Date.now() - 120000, maxWaitMs: 150000 });
  if (!mail) throw new Error("activation maili gelmedi");
  console.log("LINK:", mail.link);
  await cdp.navigate(mail.link);
  await sleep(9000);
  await shot(cdp, "02-activated");
  console.log("aktivasyon:", ((await ev(`document.body.innerText.slice(0,400)`)) || "").replace(/\n+/g, " | "));
} catch (err) {
  console.log("HATA:", String(err).slice(0, 300));
  await shot(cdp, "err").catch(() => {});
  process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
