#!/usr/bin/env node
/**
 * vt-recover.mjs — VT aktivasyon + sifre sifirlama + API key alma
 * (signup sirasinda uretilen parola kaybedildigi icin forgot-password akisi)
 */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { waitForLink } from "./lib/mailpit.mjs";
import { appendFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const EMAIL = "secops.kemal@meridyendijital.com";
const ACTIVATION = "https://www.virustotal.com/gui/account-activation/a2VtYWxzZWNlcjk0MDJ8fHYzfHwxNzg3MDkyOTcxfHw0MjAwYzQyZTY1NDU2MTY0YzUwMjVhNTQzZTZhNjIwZjViMTZkMmQyZjQ2MWRmN2U3NWU3OGExNmUxNDhjOTFl";
const NEWPASSWORD = "Pbd!" + randomBytes(6).toString("hex") + "Z9";
const CREDS = resolve(EV, "vt-creds.json");
writeFileSync(CREDS, JSON.stringify({ email: EMAIL, username: "kemalsecer9402", password: NEWPASSWORD }, null, 2));
console.log("yeni parola kaydedildi:", CREDS);

const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `vt-recover-${tag}-${Date.now()}.jpg`), 70, true);
const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-08");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => r.result.value);
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
  // 1) aktivasyon
  await cdp.navigate(ACTIVATION);
  await sleep(9000);
  await shot(cdp, "01-activation");
  console.log("aktivasyon:", ((await ev(`document.body.innerText.slice(0,300)`)) || "").replace(/\n+/g, " | "));

  // 2) forgot password
  await cdp.navigate("https://www.virustotal.com/gui/forgot-password");
  await sleep(8000);
  await shot(cdp, "02-forgot");
  const inputs = await ev(`[...document.querySelectorAll("input")].map(i=>({id:i.id,type:i.type,ph:i.placeholder})).filter(i=>i.type!=="hidden")`);
  console.log("forgot alanlari:", JSON.stringify(inputs));
  const emailSel = inputs?.[0]?.id ? "#" + inputs[0].id : 'input[type="email"]';
  console.log("email set:", await setVal(emailSel, EMAIL));
  const fb = await cdp.box('button[type="submit"], #submit');
  if (fb) await cdp.click(fb.x + fb.w / 2, fb.y + fb.h / 2);
  await sleep(8000);
  await shot(cdp, "03-forgot-sent");
  console.log("forgot sonrasi:", ((await ev(`document.body.innerText.slice(0,400)`)) || "").replace(/\n+/g, " | "));

  // 3) reset maili
  console.log("reset maili bekleniyor...");
  const mail = await waitForLink(EMAIL, /virustotal\.com[^\s"'<>]*(reset|password)[^\s"'<>]*/i, { sinceMs: Date.now() - 120000, maxWaitMs: 180000 });
  if (!mail) throw new Error("reset maili gelmedi");
  console.log("reset link:", mail.link);
  await cdp.navigate(mail.link);
  await sleep(9000);
  await shot(cdp, "04-reset-form");
  const rinputs = await ev(`[...document.querySelectorAll("input")].map(i=>({id:i.id,type:i.type})).filter(i=>i.type==="password")`);
  console.log("reset alanlari:", JSON.stringify(rinputs));
  if (!rinputs?.length) throw new Error("reset formu bulunamadi");
  for (const inp of rinputs) console.log(inp.id, await setVal("#" + inp.id, NEWPASSWORD));
  const rb = await cdp.box('button[type="submit"], #submit');
  if (rb) await cdp.click(rb.x + rb.w / 2, rb.y + rb.h / 2);
  await sleep(9000);
  await shot(cdp, "05-after-reset");
  console.log("reset sonrasi:", ((await ev(`document.body.innerText.slice(0,400)`)) || "").replace(/\n+/g, " | "));

  // 4) login (gerekirse)
  const hasPw = await ev(`!!document.querySelector('input[type="password"]')`);
  if (hasPw) {
    console.log("login deneniyor...");
    const linputs = await ev(`[...document.querySelectorAll("input")].map(i=>({id:i.id,type:i.type})).filter(i=>i.type!=="hidden")`);
    console.log("login alanlari:", JSON.stringify(linputs));
    for (const inp of linputs ?? []) {
      if (inp.type === "password") await setVal("#" + inp.id, NEWPASSWORD);
      else await setVal("#" + inp.id, EMAIL);
    }
    const lb = await cdp.box('button[type="submit"], #submit');
    if (lb) await cdp.click(lb.x + lb.w / 2, lb.y + lb.h / 2);
    await sleep(9000);
    await shot(cdp, "06-after-login");
  }

  // 5) API key
  await cdp.navigate("https://www.virustotal.com/gui/my-apikey");
  await sleep(10000);
  await shot(cdp, "07-apikey");
  const key = await ev(`(() => {
    const m = document.body.innerText.match(/[0-9a-f]{64}/i);
    if (m) return m[0];
    const el = document.querySelector("input[readonly],input[disabled]");
    return el ? el.value : null;
  })()`);
  console.log("API KEY:", key || "bulunamadi");
  if (key) {
    const c = JSON.parse((await import("node:fs")).readFileSync(CREDS, "utf8"));
    c.apiKey = key;
    writeFileSync(CREDS, JSON.stringify(c, null, 2));
    console.log("VT TAMAM");
  } else throw new Error("api key bulunamadi");
} catch (err) {
  console.log("HATA:", String(err).slice(0, 300));
  await shot(cdp, "err").catch(() => {});
  process.exitCode = 1;
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
