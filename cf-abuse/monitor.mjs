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
import { Agent, fetch as uFetch } from "undici";
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
  const m = domain.match(/^([a-z-]+?)(\d+)\.([a-z.]+)$/i);
  if (!m) return null;
  return { stem: m[1], num: Number(m[2]), tld: m[3] };
}

function addWatch(domain, official = "", brand = "") {
  const p = patternOf(domain);
  if (!p) return null;
  const hit = monitors.watch.find((w) => w.domain === domain);
  if (hit) { if (official) hit.official = official; if (brand) hit.brand = brand; return hit; }
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
async function captureEvidence(domain) {
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
  try {
    const r = await uFetch(`https://${domain}/`, { dispatcher: tls, headers: { "User-Agent": "Mozilla/5.0" } });
    const html = (await r.text()).slice(0, 20000);
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim().slice(0, 120);
    return { evidence: null, note: `http ${r.status} title="${title}"` };
  } catch (e2) {
    return { evidence: null, note: `http hata: ${String(e2.message || e2).slice(0, 80)}` };
  }
}

async function scanWatch(w) {
  const candidates = [];
  for (let n = Math.max(0, w.num - SPAN); n <= w.num + SPAN; n++) {
    if (n === w.num) continue;
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
    // ayni domain zaten pending ise tekrarlama
    if (detections.detections.some((x) => x.domain === a.domain && x.status === "pending")) continue;
    console.log(`YENI DOMAIN: ${a.domain} (${a.ip})`);
    const ev = await captureEvidence(a.domain);
    detections.detections.push({
      domain: a.domain, ip: a.ip,
      parentTarget: `https://${w.domain}/`,
      official: w.official || "", brand: w.brand || "",
      ts: new Date().toISOString(), status: "pending",
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
console.log(`SONUC: ${monitors.watch.length} desen, ${A} aktif, ${F} yeni tespit | ${Math.round((Date.now() - t0) / 1000)}sn`);
