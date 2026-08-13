#!/usr/bin/env node
/**
 * gsb-report.mjs — Google Safe Browsing phishing raporu (tarayici kirmizi uyarisi kanali).
 *
 *   node gsb-report.mjs --target https://phish.example/ [--profile PBD-05] [--dry]
 *
 * Akis: profil ac -> report_phish formu -> url + detay (DOM.focus) ->
 * reCAPTCHA checkbox (iframe ici piksel tik + yesil tik dogrulama) -> Submit.
 * Kanit: evidence/gsb-*.jpg + reports.jsonl satiri (source: "gsb").
 */
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { Agent, fetch as uFetch } from "undici";
import { RawCdp, sleep } from "./rawcdp.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PBD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(resolve(PBD, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null).filter(Boolean));
const TARGET = args.target;
const DRY = !!args.dry;
if (!TARGET) {
  console.log('kullanim: node gsb-report.mjs --target <phish-url> [--profile PBD-05] [--dry]');
  process.exit(1);
}
const FORM_URL = `https://safebrowsing.google.com/safebrowsing/report_phish/?url=${encodeURIComponent(TARGET)}`;
const mapping = JSON.parse(readFileSync(resolve(PBD, "config/profiles.json"), "utf8"));
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
mkdirSync(resolve(SCRIPT_DIR, "evidence"), { recursive: true });

const tls = new Agent({ connect: { rejectUnauthorized: false } });
const mlxToken = (await (await uFetch("https://api.multilogin.com/user/signin", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.MULTILOGIN_EMAIL, password: createHash("md5").update(process.env.MULTILOGIN_PASSWORD).digest("hex") }),
})).json())?.data?.token;
if (!mlxToken) { console.log("SIGNIN FAIL"); process.exit(1); }

const profile = args.profile
  ? mapping.profiles.find((x) => x.name === args.profile)
  : mapping.profiles[Math.floor(Math.random() * mapping.profiles.length)];
if (!profile) { console.log("profil yok"); process.exit(1); }

async function genExit() {
  const r = await uFetch("https://profile-proxy.multilogin.com/v1/proxy/connection_url", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mlxToken}`, "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({ country: "TR", protocol: "http", sessionType: "sticky", region: "", city: "", count: 1 }),
  });
  const s0 = (await r.json().catch(() => null))?.data?.[0];
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
  return !(await r.json().catch(() => null))?.status?.error_code;
}

const PY = process.platform === "win32" ? "python" : "python3";
const L = "https://launcher.mlx.yt:45001";
async function lapi(path) {
  const r = await uFetch(L + path, { headers: { Authorization: `Bearer ${mlxToken}` }, dispatcher: tls });
  return (await r.json().catch(() => null))?.data;
}

const DETAILS = [
  "This website is a phishing page impersonating a legitimate brand. It copies the official site's design and content to steal user credentials and personal information.",
  "Active phishing website. It imitates the official brand page and tricks users into entering their login credentials and personal data.",
  "Phishing scam site impersonating a well-known brand. The page replicates the official site to harvest user credentials.",
];

const t0 = Date.now();
let result = "error";
let note = "";

async function attempt() {
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
    if (code === "LOCK_PROFILE_ERROR" || code === "PROFILE_ALREADY_RUNNING") {
      await lapi(`/api/v1/profile/stop/p/${profile.id}`).catch(() => {});
      await sleep(8000);
      continue;
    }
    await sleep(4000);
  }
  if (!started?.port) throw new Error("profil acilmadi");
  const cdp = await RawCdp.connect(started.port);
  try {
    await cdp.enableNetwork();
    await cdp.navigate(FORM_URL);
    await sleep(6000);

    // form render bekle (details textarea)
    let ok = null;
    for (let i = 0; i < 9 && !ok; i++) {
      ok = await cdp.focusSelector("textarea");
      if (!ok) await sleep(5000);
    }
    if (!ok) throw new Error("EXIT_DEAD");
    console.log("form render OK");

    // metne gore kutu bul + tikla (Material dropdown/option icin)
    const clickByText = async (selector, re, maxLen = 600) => {
      const doc = await cdp.call("DOM.getDocument", { depth: -1 });
      const q = await cdp.call("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector });
      for (const nid of q.nodeIds ?? []) {
        const html = (await cdp.call("DOM.getOuterHTML", { nodeId: nid })).outerHTML ?? "";
        if (html.length > maxLen || !re.test(html)) continue;  // buyuk konteynerlari atla
        const b = await cdp.boxForNode(nid);
        if (!b || b.w < 10 || b.h < 8) continue;
        await cdp.click(b.x + Math.min(b.w / 2, 60), b.y + b.h / 2);
        return true;
      }
      return false;
    };

    // URL query param ile dolu geliyor — dokunma. Dropdownlar opsiyonel.
    // Additional details + Submit — bu sayfada Runtime serbest (Turnstile yok).
    // Koordinat tiklari Angular Material'da tutmuyor; dogrudan deger + input event.
    const details = DETAILS[Math.floor(Math.random() * DETAILS.length)];
    const fillRes = await cdp.call("Runtime.evaluate", {
      expression: `(() => {
        const ta = document.querySelector('textarea[formcontrolname="details"]') || document.querySelector('textarea');
        if (!ta) return "no-ta";
        ta.focus();
        ta.value = ${JSON.stringify(details)};
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        return "ok:" + ta.value.length;
      })()`,
      returnByValue: true,
    });
    console.log("detay:", fillRes.result?.value ?? "?");

    if (DRY) { result = "dry-ok"; note = "submit atlandi"; return result; }

    // reCAPTCHA invisible — g-recaptcha sinifli butonun click'i tokeni uretir.
    const clickRes = await cdp.call("Runtime.evaluate", {
      expression: `(() => {
        const b = document.querySelector('button[type="submit"]');
        if (!b) return "no-btn";
        b.click();
        return "clicked";
      })()`,
      returnByValue: true,
    });
    if (clickRes.result?.value !== "clicked") throw new Error("submit butonu yok");
    console.log("SUBMIT basildi");
    await sleep(10000);
    const html = await cdp.outerHTML("body").catch(() => "");
    const okk = /thank you|tesekkur|report has been|received|has been submitted|submission was successful/i.test(html);
    result = okk ? "submitted" : "submit-belirsiz";
    console.log("sunucu cevabi:", result);
    await cdp.screenshot(`${SCRIPT_DIR}/evidence/gsb-final-${Date.now()}.jpg`);
    return result;
  } catch (err) {
    note = String(err).slice(0, 200);
    console.log("HATA:", note);
    await cdp.screenshot(`${SCRIPT_DIR}/evidence/gsb-err-${Date.now()}.jpg`).catch(() => {});
    if (/EXIT_DEAD|cdp timeout|Target|closed|profil acilmadi/i.test(note)) return "EXIT_DEAD";
    return "error";
  } finally {
    cdp.close();
    await lapi(`/api/v1/profile/stop/p/${profile.id}`).catch(() => {});
  }
}

for (let att = 1; att <= 3; att++) {
  console.log(`--- deneme ${att}/3 ---`);
  note = "";
  const r = await attempt();
  if (r !== "EXIT_DEAD" && r !== "error") { result = r; break; }
  result = r;
  if (att < 3) {
    if (r === "EXIT_DEAD") {
      console.log("exit olu — taze residential exit baglaniyor");
      const px = await genExit();
      if (px && (await assignExit(profile.id, px))) console.log("yeni exit bagli");
    }
    await sleep(3000);
  }
}

appendFileSync(
  resolve(SCRIPT_DIR, "reports.jsonl"),
  JSON.stringify({ ts: new Date().toISOString(), source: "gsb", profile: profile.name, target: TARGET, result, note, ms: Date.now() - t0 }) + "\n"
);
console.log(`SONUC: ${result} | ${profile.name} | ${Math.round((Date.now() - t0) / 1000)}sn`);
