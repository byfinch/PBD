#!/usr/bin/env node
/**
 * report.mjs — Cloudflare abuse (phishing) rapor motoru.
 *
 * Akis: profil start (automation port) -> raw CDP (Runtime'suz) -> form ac ->
 * alanlari doldur -> Turnstile tik -> Submit -> sunucu cevabini yakala.
 * Kanit: evidence/<id>-*.jpg + reports.jsonl satiri.
 *
 * Kullanim:
 *   node report.mjs --target https://phish.example/ --official https://brand.com/ --brand "Marka" [--profile PBD-05] [--dry]
 *   --dry: submit etmeden once durur (turnstile dahil her sey test edilir)
 */
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { Agent, fetch as uFetch } from "undici";
import { RawCdp, sleep } from "./rawcdp.mjs";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const PBD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORM_URL = "https://abuse.cloudflare.com/phishing";

// ── argumanlar ─────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const TARGET = args.target;
const OFFICIAL = args.official ?? "";
const BRAND = args.brand ?? "";
const DRY = "dry" in args || args.dry === "true";
if (!TARGET) {
  console.log('kullanim: node report.mjs --target <phish-url> --official <resmi-url> --brand "Marka" [--profile PBD-05] [--dry]');
  process.exit(1);
}

// ── config / env ───────────────────────────────────────────────────────────
const mapping = JSON.parse(readFileSync(`${PBD}/config/profiles.json`, "utf8"));
for (const line of readFileSync(`${PBD}/.env`, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const identities = JSON.parse(readFileSync("identities.json", "utf8"));
mkdirSync("evidence", { recursive: true });

const tls = new Agent({ connect: { rejectUnauthorized: false } });
const mlxToken = (await (await uFetch("https://api.multilogin.com/user/signin", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.MULTILOGIN_EMAIL, password: createHash("md5").update(process.env.MULTILOGIN_PASSWORD).digest("hex") }),
})).json()).data.token;

const profile = args.profile
  ? mapping.profiles.find((x) => x.name === args.profile)
  : mapping.profiles[Math.floor(Math.random() * mapping.profiles.length)];
const identity = identities[Math.floor(Math.random() * identities.length)];

async function genExit() {
  const r = await uFetch("https://profile-proxy.multilogin.com/v1/proxy/connection_url", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mlxToken}`, "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({ country: "TR", protocol: "http", sessionType: "sticky", region: "", city: "", count: 1 }),
  });
  const j = await r.json().catch(() => null);
  const s0 = j?.data?.[0];
  if (!s0) return null;
  const [host, port, username, password] = s0.split(":");
  return { host, type: "http", port: Number(port), username, password, save_traffic: false };
}

async function assignExit(profileId, proxy) {
  const r = await uFetch("https://api.multilogin.com/profile/partial_update", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mlxToken}`, "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({ profile_id: profileId, proxy }),
  });
  const j = await r.json().catch(() => null);
  return !j?.status?.error_code;
}

const L = "https://launcher.mlx.yt:45001";
async function lapi(path) {
  const r = await uFetch(L + path, { headers: { Authorization: `Bearer ${mlxToken}` }, dispatcher: tls });
  return (await r.json().catch(() => null))?.data;
}

// ── rapor metni (sablon + hafif varyasyon) ─────────────────────────────────
function reportText() {
  const openers = [
    "This website is impersonating our brand and operating a phishing scam.",
    "We are reporting an active phishing website impersonating our brand.",
    "This site is running a phishing scam by impersonating our brand.",
  ];
  const body = "The reported website copies our logo, design, and content in an attempt to deceive users into believing it is our official website. Users may be tricked into submitting personal information and credentials.";
  const parts = [openers[Math.floor(Math.random() * openers.length)], body];
  if (OFFICIAL) parts.push(`Official website: ${OFFICIAL}`);
  parts.push(`Reported phishing website: ${TARGET}`);
  return parts.join("\n\n");
}

// ── ana akis ───────────────────────────────────────────────────────────────
const t0 = Date.now();
let result = "error";
let note = "";

/** Tek deneme: start + form + doldurma + turnstile (+submit). */
async function attempt(attemptNo) {
  await lapi(`/api/v1/profile/stop/p/${profile.id}`).catch(() => {});
  await sleep(4000);
  let started = null;
  for (let a = 1; a <= 6; a++) {
    const r = await uFetch(
      `${L}/api/v2/profile/f/${mapping.folderId}/p/${profile.id}/start?automation_type=playwright&headless_mode=false`,
      { headers: { Authorization: `Bearer ${mlxToken}` }, dispatcher: tls }
    );
    const j = await r.json().catch(() => null);
    if (j?.data?.port) { started = j.data; break; }
    const code = j?.status?.error_code ?? "";
    console.log(`start deneme ${a}: ${code || "?"}`);
    if (code.includes("CORE_DOWNLOADING")) { await sleep(15000); continue; }
    if (code === "PROFILE_ALREADY_RUNNING") {
      await lapi(`/api/v1/profile/stop/p/${profile.id}`).catch(() => {});
      await sleep(6000);
      continue;
    }
    await sleep(4000);
  }
  if (!started?.port) throw new Error("profil acilmadi");
  const cdp = await RawCdp.connect(started.port);

  try {
    await cdp.navigate(FORM_URL);
    await sleep(6000);

    // form render bekle (name input'u gelene kadar); 45sn icinde gelmezse
    // bir kez reload, o da olmazsa exit dead say — dis dongu yenisini baglar.
    let nameBox = null;
    for (let i = 0; i < 9 && !nameBox; i++) {
      nameBox = await cdp.box('[aria-label="Your full name"]');
      if (!nameBox) await sleep(5000);
    }
    if (!nameBox) {
      console.log("ilk yukleme bos — reload");
      await cdp.navigate(FORM_URL);
      for (let i = 0; i < 9 && !nameBox; i++) {
        nameBox = await cdp.box('[aria-label="Your full name"]');
        if (!nameBox) await sleep(5000);
      }
    }
    if (!nameBox) throw new Error("EXIT_DEAD");
    console.log("form render OK");

  // alanlar
  async function fill(sel, value) {
    const ok = await cdp.clickSelector(sel, 12);
    if (!ok) { console.log("alan yok:", sel); return false; }
    await sleep(250);
    await cdp.typeText(value, 30 + Math.random() * 30);
    return true;
  }
  await fill('[aria-label="Your full name"]', identity.name);
  await fill('[aria-label="Your email address"]', identity.email);
  await fill('[aria-label="Confirm email address"]', identity.email);

  // textarealar: 0=Evidence URLs, 1=Logs (zorunlu), 2=Targeted Brand (ops.)
  const textareas = [];
  {
    const doc = await cdp.call("DOM.getDocument", { depth: -1 });
    const q = await cdp.call("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "textarea" });
    for (const nid of q.nodeIds ?? []) textareas.push(nid);
  }
  async function fillTextarea(nodeId, value) {
    const b = await cdp.boxForNode(nodeId);
    if (!b) return false;
    await cdp.click(b.x + 15, b.y + 15);
    await sleep(250);
    await cdp.typeText(value, 12);
    return true;
  }
  if (textareas[0]) await fillTextarea(textareas[0], TARGET);
  if (textareas[1]) await fillTextarea(textareas[1], reportText());
  if (textareas[2] && BRAND) await fillTextarea(textareas[2], BRAND + (OFFICIAL ? ` (${OFFICIAL})` : ""));
  console.log("alanlar doldu");

  // DSA checkbox (role=checkbox, sonuncu)
  {
    const doc = await cdp.call("DOM.getDocument", { depth: -1 });
    const q = await cdp.call("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: '[role="checkbox"]' });
    const ids = q.nodeIds ?? [];
    if (ids.length) {
      const b = await cdp.boxForNode(ids[ids.length - 1]);
      if (b) {
        await cdp.click(b.x + 8, b.y + 8);
        console.log("DSA checkbox tiklandi");
      }
    }
  }

  // Turnstile — once sayfa dibine in (layout sabitlensin), sonra oku
  for (let i = 0; i < 5; i++) { await cdp.wheel(800); await sleep(600); }
  await sleep(1500);
  const ts = await cdp.box("#turnstile-widget");
  if (!ts) throw new Error("turnstile widget yok");
  console.log("widget box:", JSON.stringify({ x: Math.round(ts.x), y: Math.round(ts.y), w: ts.w, h: ts.h }));
  if (ts.y < 0 || ts.y > (ts.vwH ?? 1000)) throw new Error("widget viewport disinda (koordinat hatasi)");
  await cdp.click(ts.x + 28, ts.y + ts.h / 2);
  console.log("turnstile tiklandi — token bekleniyor");

  // Submit'in acilmasi = token gecti (DOM: disabled attribute duser)
  const submitDoc = await cdp.call("DOM.getDocument", { depth: -1 });
  const submitQ = await cdp.call("DOM.querySelector", { nodeId: submitDoc.root.nodeId, selector: 'button[type="submit"]' });
  let passed = false;
  for (let t = 0; t < 45; t += 3) {
    if (submitQ.nodeId) {
      const disabled = await cdp.isDisabled(submitQ.nodeId);
      if (!disabled) { passed = true; break; }
    }
    await sleep(3000);
  }
  await cdp.screenshot(`evidence/ts-${Date.now()}.jpg`);
  if (!passed) throw new Error("turnstile gecmedi (submit disabled kaldi)");
  console.log("turnstile GECTI (submit aktif)");

  if (DRY) {
    result = "dry-ok";
    note = "submit atilmadi (dry run)";
  } else {
    await cdp.clickSelector('button[type="submit"]', 20);
    console.log("SUBMIT basildi — cevap bekleniyor");
    await sleep(12000);
    const html = await cdp.outerHTML("body");
    const ok = /thank you|received|success|tesekkur|alindi/i.test(html) && !/Request failed|error/i.test(html.slice(0, 4000));
    result = ok ? "submitted" : "submit-belirsiz";
    const errMatch = html.match(/Request failed with status (\d+)/);
    if (errMatch) { result = "submit-error"; note = "HTTP " + errMatch[1]; }
    console.log("sunucu cevabi:", result, note);
  }
  await cdp.screenshot(`evidence/final-${Date.now()}.jpg`);
  return result;
  } catch (err) {
    note = String(err).slice(0, 200);
    console.log("HATA:", note);
    await cdp.screenshot(`evidence/err-${Date.now()}.jpg`).catch(() => {});
    // cdp timeout / renderer çökmesi / bos sayfa — exit'e yaz, dondur
    if (/EXIT_DEAD|cdp timeout|Target|closed|profil acilmadi/i.test(note)) return "EXIT_DEAD";
    return "error";
  } finally {
    cdp.close();
    // sekme kapatma hijyeni -> profil New Tab'da kapanir
    await lapi(`/api/v1/profile/stop/p/${profile.id}`).catch(() => {});
  }
}

// ── exit rotasyonlu ana dongu ──────────────────────────────────────────────
for (let att = 1; att <= 3; att++) {
  console.log(`--- deneme ${att}/3 ---`);
  const r = await attempt(att);
  if (r !== "EXIT_DEAD" && r !== "error") { result = r; break; }
  result = r;
  if (att < 3) {
    if (r === "EXIT_DEAD") {
      console.log("exit olu — taze residential exit baglaniyor");
      const px = await genExit();
      if (px && (await assignExit(profile.id, px))) console.log("yeni exit bagli");
      else console.log("exit uretilemedi — ayni exit ile devam");
    } else {
      console.log("hata — ayni exit ile bir kez daha denenecek");
    }
    await sleep(3000);
  }
}

appendFileSync(
  "reports.jsonl",
  JSON.stringify({
    ts: new Date().toISOString(),
    profile: profile.name,
    identity: identity.email,
    target: TARGET,
    official: OFFICIAL,
    brand: BRAND,
    result,
    note,
    ms: Date.now() - t0,
  }) + "\n"
);
console.log(`SONUC: ${result} | ${profile.name} | ${identity.email} | ${Math.round((Date.now() - t0) / 1000)}sn`);
