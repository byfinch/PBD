#!/usr/bin/env node
/**
 * monitor.mjs — komsu domain taramasi + tespit kaydi + kanit toplama.
 *
 *   node monitor.mjs                              # monitors.json'daki TUM desenleri tara (timer)
 *   node monitor.mjs --domain herabet392.cam [--official U] [--brand B] [--span 5]  # watch'a ekle + tara
 *
 * Desen: <harf><sayi>.<tld> → ±span numarali komsulari DNS resolve dener.
 * Yeni aktif domain: detections.json (status:"pending") + reports.jsonl (source:"monitor")
 * + panel activity + kanit (müsait profil varsa screenshot, yoksa HTTP title/status).
 * Otomatik saldiri BASLATMAZ — kullanici panelden onaylar.
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve4 } from "node:dns/promises";
import { Agent, fetch as uFetch, request as uRequest } from "undici";
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadEnv, loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(SCRIPT_DIR, "monitor-state.json");
const MONITORS = resolve(SCRIPT_DIR, "monitors.json");
const DETECTIONS = resolve(SCRIPT_DIR, "detections.json");
const EVIDENCE = resolve(SCRIPT_DIR, "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null).filter(Boolean));
const SPAN = Number(args.span ?? 5);
const PANEL = args.panel || "http://127.0.0.1:3090";
const tls = new Agent({ connect: { rejectUnauthorized: false } });

// ---- durum dosyalari ----
const readJ = (p, dflt) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } };
const writeJ = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1));
const state = readJ(STATE, { seen: {} });
const monitors = readJ(MONITORS, { watch: [] });
const detections = readJ(DETECTIONS, { detections: [] });

function patternOf(domain) {
  // hazir desen: herabetN.cam
  const np = String(domain || "").match(/^([a-z-]+?)N\.([a-z.]+)$/i);
  if (np) return { stem: np[1].toLowerCase(), num: null, tld: np[2].toLowerCase() };
  const m = String(domain || "").match(/^([a-z-]+?)(\d+)\.([a-z.]+)$/i);
  if (!m) return null;
  return { stem: m[1].toLowerCase(), num: Number(m[2]), tld: m[3].toLowerCase() };
}

// desen (stem+tld) bazli dedupe: ayni desen bir kez izlenir
function addWatch(domain, official = "", brand = "") {
  const p = patternOf(domain);
  if (!p) return null;
  const hit = monitors.watch.find((w) => w.stem === p.stem && w.tld === p.tld);
  if (hit) {
    if (official) hit.official = official;
    if (brand) hit.brand = brand;
    if (hit.num == null && p.num != null) hit.num = p.num;
    return hit;
  }
  const w = { domain, ...p, official, brand, addedTs: new Date().toISOString(), lastCheck: null };
  monitors.watch.push(w);
  return w;
}

async function panelLog(text) {
  try {
    await uFetch(`${PANEL}/api/activity`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {}
}

// ---- kanit: musait profille screenshot, olmazsa HTTP title/status ----
async function captureEvidence(domain, probe) {
  try {
    loadEnv();
    const mapping = loadProfiles();
    const profile = mapping.profiles[Math.floor(Math.random() * mapping.profiles.length)];
    const { port } = await startProfile(profile, mapping.folderId, 1);
    try {
      const cdp = await RawCdp.connect(port);
      await cdp.navigate(`https://${domain}/`);
      await sleep(12000);
      const file = `kanit-monitor-${domain}-${Date.now()}.jpg`;
      await cdp.screenshot(resolve(EVIDENCE, file), 70);
      await stopProfile(profile.id);
      console.log(`kanit (profil ${profile.name}): ${file}`);
      return { evidence: file, note: `screenshot via ${profile.name}` };
    } finally {
      await stopProfile(profile.id).catch(() => {});
    }
  } catch (e) {
    console.log(`profil kanit atlaniyor (${String(e.message || e).slice(0, 60)}) — HTTP fallback`);
  }
  if (probe) return { evidence: null, note: `http ${probe.status} title="${probe.title}"${probe.error ? " " + probe.error : ""}` };
  return { evidence: null, note: "kanit yok" };
}

/** redirect zincirini takip et (maks 5 hop, hop basina 10sn). */
async function httpProbe(domain) {
  const chain = [];
  let url = `https://${domain}/`;
  let status = 0, title = "", error = "";
  try {
    for (let hop = 0; hop < 5; hop++) {
      chain.push(new URL(url).hostname);
      const r = await uRequest(url, {
        method: "GET", dispatcher: tls, maxRedirections: 0,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36" },
        signal: AbortSignal.timeout(10000),
      });
      status = r.statusCode;
      if (status >= 300 && status < 400 && r.headers.location) {
        url = new URL(r.headers.location, url).toString();
        await r.body.dump().catch(() => {});
        continue;
      }
      if (status === 200) {
        const html = (await r.body.text()).slice(0, 20000);
        title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim().slice(0, 120);
      } else {
        await r.body.dump().catch(() => {});
      }
      break;
    }
  } catch (e) {
    error = String(e.message || e).slice(0, 80);
  }
  let finalDomain = domain;
  try { finalDomain = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  return { chain, finalDomain, status, title, error };
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

/** redirect-main: official/izlenen/ayni-aile ana sitesine yonlenme (tespit sayilmaz). */
function classify(w, domain, probe) {
  const final = probe.finalDomain;
  if (!final || final === domain) return "pending"; // dogrudan icerik / probe basarisiz
  const officialHost = hostOf(w.official);
  if (officialHost && final === officialHost) return "redirect-main";
  if (monitors.watch.some((x) => x.domain === final)) return "redirect-main";
  const famRe = new RegExp(`^${w.stem}\\d+\\.${w.tld.replace(/\./g, "\\.")}$`, "i");
  if (famRe.test(final)) return "redirect-main";
  return "pending";
}

const watchOf = (domain) =>
  monitors.watch.find((x) => new RegExp(`^${x.stem}\\d+\\.${x.tld.replace(/\./g, "\\.")}$`, "i").test(domain)) || monitors.watch[0];

async function scanWatch(w) {
  // merkez numara: kayitli num yoksa state'te bilinen bu desenin en buyuk numarasi
  let center = w.num;
  if (center == null) {
    const re = new RegExp(`^${w.stem}(\\d+)\\.${w.tld.replace(/\./g, "\\.")}$`, "i");
    const known = Object.keys(state.seen).map((d) => d.match(re)).filter(Boolean).map((m) => Number(m[1]));
    if (known.length) center = Math.max(...known);
  }
  if (center == null) {
    console.log(`${w.stem}N.${w.tld}: taban numara yok, tarama atlaniyor (ornek: ${w.stem}123.${w.tld} olarak ekle)`);
    return { active: 0, fresh: 0, total: 0 };
  }
  const candidates = [];
  for (let n = Math.max(0, center - SPAN); n <= center + SPAN; n++) {
    if (n === w.num) continue; // parent'in kendisi
    candidates.push(`${w.stem}${n}.${w.tld}`);
  }
  const active = [];
  for (const d of candidates) {
    try {
      const ips = await resolve4(d);
      if (ips?.length) active.push({ domain: d, ip: ips[0] });
    } catch {}
  }
  const fresh = active.filter((a) => !state.seen[a.domain]);
  for (const a of active) state.seen[a.domain] ??= new Date().toISOString();
  w.lastCheck = new Date().toISOString();

  for (const a of fresh) {
    // ayni domain zaten kayitli ise tekrarlama
    if (detections.detections.some((x) => x.domain === a.domain)) continue;
    console.log(`YENI DOMAIN: ${a.domain} (${a.ip}) — redirect analizi`);
    const probe = await httpProbe(a.domain);
    // HTTP cevabi yoksa (baglanti/TLS/timeout) olu sayilir — tespit uretme
    if (!probe.status) {
      console.log(`  olu domain: ${a.domain} (${probe.error || "cevap yok"}) — tespit sayilmadi`);
      await panelLog(`olu domain: ${a.domain} (${probe.error || "baglanti hatasi"}) — tespit sayilmadi`);
      continue;
    }
    const cls = classify(w, a.domain, probe);
    const base = {
      domain: a.domain, ip: a.ip,
      parentTarget: `https://${w.domain}/`,
      official: w.official || "", brand: w.brand || "",
      ts: new Date().toISOString(),
      finalDomain: probe.finalDomain,
      redirectChain: probe.chain,
    };
    if (cls === "redirect-main") {
      console.log(`  redirect-main: ${probe.chain.join(" -> ")} -> ${probe.finalDomain} (tespit sayilmadi)`);
      detections.detections.push({ ...base, status: "redirect-main", evidence: null, note: `ana siteye yonlendiriyor: ${probe.finalDomain}` });
      appendFileSync(
        resolve(SCRIPT_DIR, "reports.jsonl"),
        JSON.stringify({
          ts: new Date().toISOString(), source: "monitor",
          target: `https://${a.domain}/`, result: "redirect-main",
          note: `ana siteye yonlendiriyor: ${probe.finalDomain} (desen: ${w.stem}N.${w.tld})`,
          ms: 0,
        }) + "\n"
      );
      await panelLog(`redirect-main: ${a.domain} -> ${probe.finalDomain} (tespit sayilmadi)`);
      continue;
    }
    const ev = await captureEvidence(a.domain, probe);
    detections.detections.push({
      ...base,
      status: "pending",
      evidence: ev.evidence, note: ev.note,
    });
    appendFileSync(
      resolve(SCRIPT_DIR, "reports.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(), source: "monitor",
        target: `https://${a.domain}/`, result: "active",
        note: `yeni aktif komsu domain (desen: ${w.stem}N.${w.tld}, ip: ${a.ip})`,
        ms: 0,
      }) + "\n"
    );
    await panelLog(`YENI DOMAIN: ${a.domain} (${a.ip}) — ${w.domain} komsusu, panelden onay bekleniyor`);
  }
  return { active: active.length, fresh: fresh.length, total: candidates.length };
}

// ---- ana akis ----
if (args.domain) addWatch(args.domain, args.official || "", args.brand || "");

// --reclassify: pending tespitleri redirect mantigiyla yeniden degerlendir (tek seferlik temizlik)
if (args.reclassify) {
  let changed = 0, dead = 0;
  for (const det of detections.detections.filter((d) => d.status === "pending")) {
    const w = watchOf(det.domain);
    if (!w) continue;
    const probe = await httpProbe(det.domain);
    det.finalDomain = probe.finalDomain;
    det.redirectChain = probe.chain;
    if (!probe.status) {
      det.status = "dead";
      det.note = `olu site: ${probe.error || "cevap yok"}`;
      det.resolvedTs = new Date().toISOString();
      dead++;
      console.log(`dead: ${det.domain} (${probe.error || "cevap yok"})`);
      continue;
    }
    if (classify(w, det.domain, probe) === "redirect-main") {
      det.status = "redirect-main";
      det.note = `ana siteye yonlendiriyor: ${probe.finalDomain}`;
      det.resolvedTs = new Date().toISOString();
      changed++;
      console.log(`redirect-main: ${det.domain} -> ${probe.finalDomain}`);
    }
  }
  writeJ(DETECTIONS, detections);
  console.log(`SONUC: reclassify ${changed} redirect-main, ${dead} dead, ${detections.detections.filter((d) => d.status === "pending").length} pending kaldi`);
  process.exit(0);
}

// --probe <domain>: tek domain canli/redirect testi (tani)
if (args.probe) {
  const probe = await httpProbe(String(args.probe));
  console.log(JSON.stringify(probe, null, 1));
  console.log(probe.status ? `CANLI (http ${probe.status}) final=${probe.finalDomain}` : `DEAD (${probe.error || "cevap yok"})`);
  process.exit(0);
}

if (!monitors.watch.length) {
  console.log("izlenen desen yok — once --domain ile ekle (panel fire da otomatik ekler)");
  process.exit(0);
}
const t0 = Date.now();
let A = 0, F = 0;
for (const w of monitors.watch) {
  const r = await scanWatch(w);
  A += r.active; F += r.fresh;
  console.log(`${w.stem}N.${w.tld}: ${r.active} aktif / ${r.total} aday, ${r.fresh} yeni`);
}
writeJ(STATE, state);
writeJ(MONITORS, monitors);
writeJ(DETECTIONS, detections);
const ozet = `monitor turu: ${monitors.watch.length} desen, ${A} aktif, ${F} yeni tespit`;
console.log(`SONUC: ${ozet} | ${Math.round((Date.now() - t0) / 1000)}sn`);
await panelLog(ozet);  // canli konsolda gorunsun — sessiz calismiyor
