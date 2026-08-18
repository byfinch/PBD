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
const identities = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "identities.json"), "utf8"));
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
mkdirSync(resolve(SCRIPT_DIR, "evidence"), { recursive: true });

const tls = new Agent({ connect: { rejectUnauthorized: false } });
const mlxToken = (await (await uFetch("https://api.multilogin.com/user/signin", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.MULTILOGIN_EMAIL, password: createHash("md5").update(process.env.MULTILOGIN_PASSWORD).digest("hex") }),
})).json()).data.token;

const profile = args.profile
  ? mapping.profiles.find((x) => x.name === args.profile)
  : mapping.profiles[Math.floor(Math.random() * mapping.profiles.length)];
let identity = args.identity
  ? identities.find((x) => x.email === args.identity) ?? identities[0]
  : identities[Math.floor(Math.random() * identities.length)];
const usedIdentities = new Set([identity.email]);
function freshIdentity() {
  const kalan = identities.filter((x) => !usedIdentities.has(x.email));
  if (!kalan.length) return null;
  identity = kalan[Math.floor(Math.random() * kalan.length)];
  usedIdentities.add(identity.email);
  return identity;
}

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

const PY = process.platform === "win32" ? "python" : "python3";
const L = "https://launcher.mlx.yt:45001";
async function lapi(path) {
  const r = await uFetch(L + path, { headers: { Authorization: `Bearer ${mlxToken}` }, dispatcher: tls });
  return (await r.json().catch(() => null))?.data;
}

// ── rapor metni parcalari (genis varyasyon havuzu — kopya/yapistir deseni olmasin) ──
function reportParts() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const openers = [
    "This website is impersonating our brand and operating a phishing scam.",
    "We are reporting an active phishing website impersonating our brand.",
    "This site is running a phishing scam by impersonating our brand.",
    "I would like to report a fraudulent website that copies our brand and misleads users.",
    "This page is a fake copy of our official website and is being used for phishing.",
    "We detected a phishing site that unlawfully uses our brand identity.",
  ];
  const bodies = [
    "The reported website copies our logo, design, and content in an attempt to deceive users into believing it is our official website. Users may be tricked into submitting personal information and credentials.",
    "The page imitates our official site's layout, logo and texts. Visitors are misled into entering their account credentials and personal data, which are then harvested by the operators.",
    "This fake website reproduces our brand's visual identity and content without authorization. Its purpose is to collect login details and personal information from unsuspecting users.",
    "The operators of this site cloned our branding and page content to appear legitimate. Users who land on it risk handing over their credentials and payment information.",
    "This is an unauthorized copy of our web presence. The site deceives visitors into thinking they are on the official page and attempts to steal their personal and financial data.",
  ];
  const closers = [
    "Please investigate and take appropriate action as soon as possible.",
    "We kindly ask you to review and take the necessary action against this abusive website.",
    "Please review this report and suspend the fraudulent content.",
    "We appreciate your prompt attention to this abuse report.",
  ];
  const parts = [pick(openers) + " " + pick(bodies) + " " + pick(closers)];
  if (OFFICIAL) parts.push(`Official website: ${OFFICIAL}`);
  parts.push(`Reported phishing website: ${TARGET}`);
  return parts;
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
    if (code === "LOCK_PROFILE_ERROR") {
      await lapi(`/api/v1/profile/stop/p/${profile.id}`).catch(() => {});
      await sleep(8000);
      continue;
    }
    if (code === "PROFILE_ALREADY_RUNNING") {
      await lapi(`/api/v1/profile/stop/p/${profile.id}`).catch(() => {});
      await sleep(6000);
      continue;
    }
    await sleep(4000);
  }
  if (!started?.port) throw new Error("profil acilmadi");
  const cdp = await RawCdp.connect(started.port);
  // submit POST'unun HTTP kodunu yakala (kesin kanit)
  let submitHttp = 0;
  let submitClicked = false;
  await cdp.enableNetwork();
  cdp.onResponse((p) => {
    const url = p.response?.url ?? "";
    const st = p.response?.status ?? 0;
    if (!url.includes("abuse.cloudflare.com")) return;
    if (/_sentry|zaraz|cdn-cgi|favicon|\.css|\.js($|\?)/.test(url)) return; // telemetri/statik
    console.log("NET:", st, url.slice(0, 90));
    if (st >= 400 && submitClicked) submitHttp = st;
  });

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


  // Turnstile — PIKSEL REHBERLI: screenshot'ta turuncu CF logosunu bul,
  // checkbox = logo - 250px. Tık sonrasi yesil piksel dogrulamasi.
  const { execFileSync } = await import("node:child_process");
  async function submitEnabled() {
    const doc = await cdp.call("DOM.getDocument", { depth: -1 });
    const q = await cdp.call("DOM.querySelector", { nodeId: doc.root.nodeId, selector: 'button[type="submit"]' });
    if (!q.nodeId) return false;
    return !(await cdp.isDisabled(q.nodeId));
  }
  let passed = false;
  for (let attemptTs = 1; attemptTs <= 3 && !passed; attemptTs++) {
    // Submit butonuna scroll'la (her zaman en dipte) — widget hemen ustunde
    {
      const doc0 = await cdp.call("DOM.getDocument", { depth: -1 });
      const sq = await cdp.call("DOM.querySelector", { nodeId: doc0.root.nodeId, selector: 'button[type="submit"]' });
      if (sq.nodeId) await cdp.cdp("DOM.scrollIntoViewIfNeeded", { nodeId: sq.nodeId }).catch(() => {});
    }
    await sleep(1500);
    const shotPath = `${SCRIPT_DIR}/evidence/ts-find-${Date.now()}.jpg`;
    await cdp.screenshot(shotPath);
    let out = "";
    try {
      out = execFileSync(PY, [resolve(dirname(fileURLToPath(import.meta.url)), "find-widget.py"), shotPath], { encoding: "utf8" }).trim();
    } catch { out = "yok"; }
    console.log(`widget tarama ${attemptTs}: ${out}`);
    if (out === "yok") { await sleep(4000); continue; }
    const [cx0, cy0] = out.split(",").map(Number);
    const dy = (attemptTs - 1) * 12;  // her denemede biraz asagi
    await cdp.click(cx0, cy0 + dy);
    console.log("tik atildi:", cx0, cy0 + dy);
    // yesil tik dogrulamasi (piksel) + submit state
    for (let t = 0; t < 24 && !passed; t += 6) {
      await sleep(6000);
      const vPath = `${SCRIPT_DIR}/evidence/ts-verify-${Date.now()}.jpg`;
      await cdp.screenshot(vPath);
      let green = "";
      try { green = execFileSync(PY, [resolve(dirname(fileURLToPath(import.meta.url)), "find-widget.py"), vPath, "verify"], { encoding: "utf8" }).trim(); } catch {}
      const enabled = await submitEnabled();
      if (green === "yesil" || enabled) passed = true;
    }
  }
  await cdp.screenshot(`${SCRIPT_DIR}/evidence/ts-${Date.now()}.jpg`);
  if (!passed) throw new Error("turnstile gecmedi");
  console.log("turnstile GECTI");

  // challenge sonrasi olasi reload icin bekleme + form hala duruyor mu
  await sleep(6000);
  {
    let nb = null;
    for (let i = 0; i < 5 && !nb; i++) {
      nb = await cdp.box('[aria-label="Your full name"]');
      if (!nb) await sleep(3000);
    }
    if (!nb) throw new Error("turnstile sonrasi form kayboldu (reload?)");
  }

// alanlar — DOM.focus + type (tik/Tab yarisi YOK): her alan dogrudan odaklanir
  {
    const F = async (sel, text, d = 30, idx = 0) => {
      const ok = await cdp.focusSelector(sel, idx);
      if (!ok) throw new Error("alan yok: " + sel);
      await sleep(300);
      await cdp.typeText(text, d);
    };
    await F('[aria-label="Your full name"]', identity.name);
    await F('[aria-label="Your email address"]', identity.email);
    await F('[aria-label="Confirm email address"]', identity.email);
    await F('[aria-label="Evidence URLs"]', TARGET, 15);
    // Logs (zorunlu) — paragraflar arasi gercek Enter
    if (!await cdp.focusSelector('[aria-label="Logs or other evidence of abuse"]')) throw new Error("logs alani yok");
    await sleep(300);
    for (const [pi, part] of reportParts().entries()) {
      if (pi) { await cdp.key("Enter"); await sleep(200); }
      await cdp.typeText(part, 30);
    }
    // pasif dogrulama: bossa hata ver (dis dongu temiz sekilde yeniden dener)
    {
      const lb = await cdp.box('[aria-label="Logs or other evidence of abuse"]');
      const shotPath = `${SCRIPT_DIR}/evidence/logs-check-${Date.now()}.jpg`;
      await cdp.screenshot(shotPath);
      if (lb) {
        let r = "?";
        try {
          r = execFileSync(PY, [resolve(SCRIPT_DIR, "check-text.py"), shotPath,
            String(Math.round(lb.x)), String(Math.round(lb.y)),
            String(Math.round(lb.w)), String(Math.round(lb.h)),
            String(Math.round(lb.vwW || 0))], { encoding: "utf8" }).trim();
        } catch {}
        console.log("logs dogrulama:", r);  // bilgi amacli — akisi KESMEZ (koordinat/DPR hassas)
      }
    }
    console.log("alanlar doldu");
    // KANIT 1: form tam dolu (tam sayfa)
    await cdp.screenshot(`${SCRIPT_DIR}/evidence/kanit-filled-${Date.now()}.jpg`, 70, true);
  }

  // DSA — once sayfa dibine don (widget kadraja girsin), sonra odakla
  {
    {
      const doc0 = await cdp.call("DOM.getDocument", { depth: -1 });
      const sq = await cdp.call("DOM.querySelector", { nodeId: doc0.root.nodeId, selector: 'button[type="submit"]' });
      if (sq.nodeId) await cdp.cdp("DOM.scrollIntoViewIfNeeded", { nodeId: sq.nodeId }).catch(() => {});
      await sleep(1500);
    }
    const wPath = `${SCRIPT_DIR}/evidence/dsa-anchor-${Date.now()}.jpg`;
    await cdp.screenshot(wPath);
    let anchored = false;
    try {
      const out = execFileSync(PY, [resolve(dirname(fileURLToPath(import.meta.url)), "find-widget.py"), wPath], { encoding: "utf8" }).trim();
      if (out !== "yok") {
        const [wx, wy] = out.split(",").map(Number);
        await cdp.click(wx, wy);  // zaten yesil — zararsiz, odak widget'a
        anchored = true;
      }
    } catch {}
  }
  // DSA — Comments alanindan ileri Tab (Shift YOK — Sticky Keys tetikliyordu).
  // Zincir: Comments -> hosting -> hosting-sub -> owner -> owner-sub -> DSA.
  // Disabled ara kutular atlanirsa 3 Tab'a duser; 3-6 arasi tara.
  {
    const dsaChecked = async () => {
      const doc = await cdp.call("DOM.getDocument", { depth: -1 });
      const q = await cdp.call("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "label" });
      for (const nid of q.nodeIds ?? []) {
        const html = (await cdp.call("DOM.getOuterHTML", { nodeId: nid })).outerHTML ?? "";
        if (/DSA certification/i.test(html)) return /data-state="checked"|aria-checked="true"/.test(html);
      }
      return false;
    };
    let dsaOk = false;
    for (const n of [5, 3, 4, 6]) {
      if (dsaOk) break;
      if (!await cdp.focusSelector('[aria-label="Comments"]')) break;
      await sleep(300);
      for (let i = 0; i < n; i++) { await cdp.key("Tab"); await sleep(200); }
      await cdp.key(" ");
      await sleep(700);
      dsaOk = await dsaChecked();
      console.log(`DSA (tab x${n}): ${dsaOk ? "isaretli" : "degil"}`);
    }
    if (!dsaOk) throw new Error("DSA isaretlenemedi");
  }

  if (DRY) {
    result = "dry-ok";
    note = "submit atilmadi (dry run)";
  } else {
    // Turnstile token tazeligi — alan doldurma uzun surduyse token bayatlar
    // ("signal timed out"). Submit'ten once yesil degilse tikla + tazele.
    {
      const vPath = `${SCRIPT_DIR}/evidence/ts-refresh-${Date.now()}.jpg`;
      await cdp.screenshot(vPath);
      let green = "";
      try { green = execFileSync(PY, [resolve(dirname(fileURLToPath(import.meta.url)), "find-widget.py"), vPath, "verify"], { encoding: "utf8" }).trim(); } catch {}
      if (green !== "yesil") {
        console.log("turnstile bayat — tazeleniyor");
        const fPath = `${SCRIPT_DIR}/evidence/ts-refind-${Date.now()}.jpg`;
        await cdp.screenshot(fPath);
        let out = "";
        try { out = execFileSync(PY, [resolve(dirname(fileURLToPath(import.meta.url)), "find-widget.py"), fPath], { encoding: "utf8" }).trim(); } catch {}
        if (out !== "yok") {
          const [rx, ry] = out.split(",").map(Number);
          await cdp.click(rx, ry);
          for (let t = 0; t < 30 && green !== "yesil"; t += 5) {
            await sleep(5000);
            const v2 = `${SCRIPT_DIR}/evidence/ts-reverify-${Date.now()}.jpg`;
            await cdp.screenshot(v2);
            try { green = execFileSync(PY, [resolve(dirname(fileURLToPath(import.meta.url)), "find-widget.py"), v2, "verify"], { encoding: "utf8" }).trim(); } catch {}
          }
        }
        console.log("turnstile tazeleme:", green === "yesil" ? "OK" : "OLMADI");
      }
    }
    // Submit — piksel rehberli (mavi buton)
    const sPath = `${SCRIPT_DIR}/evidence/submit-find-${Date.now()}.jpg`;
    await cdp.screenshot(sPath);
    let sout = "";
    try { sout = execFileSync(PY, [resolve(dirname(fileURLToPath(import.meta.url)), "find-widget.py"), sPath, "submit"], { encoding: "utf8" }).trim(); } catch {}
    console.log("submit tarama:", sout);
    if (sout === "yok") throw new Error("submit butonu bulunamadi");
    const [sx, sy] = sout.split(",").map(Number);
    await cdp.click(sx, sy);
    submitClicked = true;
    console.log("SUBMIT basildi:", sx, sy);
    await sleep(15000);
    const html = await cdp.outerHTML("body").catch(() => "");
    if (/Failed to fetch/i.test(html)) throw new Error("EXIT_DEAD");  // submit POST ag seviyesinde dustu
    if (/"dedupe"|already submitted this URL/i.test(html)) {
      console.log("sunucu: dedupe — bu URL bu kimlikle zaten raporlu");
      return "dedupe";
    }
    const ok = /thank you|received|success|tesekkur|alindi/i.test(html) && !/Request failed|error/i.test(html.slice(0, 4000));
    result = ok ? "submitted" : "submit-belirsiz";
    const errMatch = html.match(/Request failed with status (\d+)/);
    if (errMatch) { result = "submit-error"; note = "HTTP " + errMatch[1]; }
    if (!ok && submitHttp) { result = "submit-error"; note = "ag hatasi HTTP " + submitHttp; }  // thank-you dialogu 400'den once gelir
    console.log("sunucu cevabi:", result, note);
  }
  await cdp.screenshot(`${SCRIPT_DIR}/evidence/kanit-result-${Date.now()}.jpg`);
  return result;
  } catch (err) {
    note = String(err).slice(0, 200);
    console.log("HATA:", note);
    await cdp.screenshot(`${SCRIPT_DIR}/evidence/err-${Date.now()}.jpg`).catch(() => {});
    // cdp timeout / renderer çökmesi / bos sayfa — exit'e yaz, dondur
    if (/EXIT_DEAD|cdp timeout|Target|closed|profil acilmadi/i.test(note)) return "EXIT_DEAD";
    return "error";
  } finally {
    cdp.close();
    // sekme kapatma hijyeni -> profil New Tab'da kapanir
    await lapi(`/api/v1/profile/stop/p/${profile.id}`).catch(() => {});
  }
}

// ── kimlik + exit rotasyonlu ana dongu (%100 hedefi: basariya kadar dene) ──
const RETRYABLE = new Set(["EXIT_DEAD", "error", "dedupe", "submit-error", "submit-belirsiz"]);
for (let att = 1; att <= 5; att++) {
  console.log(`--- deneme ${att}/5 (${identity.email}) ---`);
  note = "";
  const r = await attempt(att);
  result = r;
  if (!RETRYABLE.has(r)) break;  // submitted / dry-ok
  if (att >= 5) break;
  // exit tarafi supheliyse ya da sunucu reddettiyse tazele
  const px = await genExit();
  if (px && (await assignExit(profile.id, px))) console.log("yeni exit bagli");
  // sunucu tarafli redlerde kimligi degistir (dedupe/400/belirsiz)
  if (r !== "EXIT_DEAD") {
    const yeni = freshIdentity();
    if (!yeni) { console.log("kimlik havuzu bitti"); break; }
    console.log(`kimlik degisti -> ${yeni.email}`);
  }
  await sleep(3000);
}

appendFileSync(
  resolve(SCRIPT_DIR, "reports.jsonl"),
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
