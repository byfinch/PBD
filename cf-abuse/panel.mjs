#!/usr/bin/env node
/**
 * cf-abuse panel — bagimsiz sikayet paneli (PBD panelinden ayrik).
 * Port: 3090 (env PANEL_PORT ile degisir). Login: PANEL_USER/PANEL_PASSWORD.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import express from "express";
import { loadBrands, upsertBrand, removeBrand, httpResolve, brandOfficialUrl, brandByName } from "./lib/brands.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG = resolve(SCRIPT_DIR, "reports.jsonl");
const MONITORS = resolve(SCRIPT_DIR, "monitors.json");
const DETECTIONS = resolve(SCRIPT_DIR, "detections.json");
const PORT = Number(process.env.PANEL_PORT ?? 3090);
const USER = process.env.PANEL_USER ?? "admin";
const PASS = process.env.PANEL_PASSWORD ?? "pbd2026";

const readJ = (p, dflt) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } };
const writeJ = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1));
const loadMonitors = () => readJ(MONITORS, { watch: [] });
const loadDetections = () => readJ(DETECTIONS, { detections: [] });

function patternOf(domain) {
  const np = String(domain || "").match(/^([a-z-]+?)N\.([a-z.]+)$/i);
  if (np) return { stem: np[1].toLowerCase(), num: null, tld: np[2].toLowerCase() };
  const m = String(domain || "").match(/^([a-z-]+?)(\d+)\.([a-z.]+)$/i);
  return m ? { stem: m[1].toLowerCase(), num: Number(m[2]), tld: m[3].toLowerCase() } : null;
}

// desen (stem+tld) bazli dedupe ile watch'a ekle — autoWatch ve /api/monitors/add ortak
function upsertWatch({ domain, official = "", brand = "" }) {
  const p = patternOf(domain);
  if (!p) return null;
  const monitors = loadMonitors();
  const hit = monitors.watch.find((w) => w.stem === p.stem && w.tld === p.tld);
  if (hit) {
    if (official) hit.official = official;
    if (brand) hit.brand = brand;
    if (hit.num == null && p.num != null) hit.num = p.num;
    writeJ(MONITORS, monitors);
    return { entry: hit, created: false };
  }
  const w = { domain, ...p, official, brand, addedTs: new Date().toISOString(), lastCheck: null };
  monitors.watch.push(w);
  writeJ(MONITORS, monitors);
  return { entry: w, created: true };
}

// fire edilen hedefi monitor watch listesine ekle (desen uretilebiliyorsa)
function autoWatch(target, official, brand) {
  try {
    const domain = new URL(target).hostname.replace(/^www\./, "");
    upsertWatch({ domain, official, brand });
  } catch {}
}

const sessions = new Set();
const activity = [];
let running = null;
const queue = [];  // FIFO saldiri kuyrugu: [{target, official, brand, channel, queuedTs}]

function log(text) {
  activity.push({ ts: new Date().toISOString(), text });
  if (activity.length > 200) activity.splice(0, activity.length - 200);
}

const app = express();
app.use(express.json({ limit: "128kb" }));

app.post("/api/login", (req, res) => {
  const { u, p } = req.body ?? {};
  if (u === USER && p === PASS) {
    const t = createHash("sha256").update(randomBytes(32)).digest("hex");
    sessions.add(t);
    res.setHeader("Set-Cookie", `cfa_sess=${t}; HttpOnly; Path=/; SameSite=Strict`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});
app.post("/api/logout", (req, res) => {
  const m = (req.headers.cookie ?? "").match(/cfa_sess=([^;]+)/);
  if (m) sessions.delete(decodeURIComponent(m[1]));
  res.setHeader("Set-Cookie", "cfa_sess=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

// monitor.mjs gibi yerel bilesenler icin activity girisi (sadece loopback)
app.post("/api/activity", (req, res) => {
  const ip = req.socket.remoteAddress || "";
  if (!/^(127\.|::1$|::ffff:127\.)/.test(ip)) return res.status(403).json({ error: "sadece localhost" });
  const text = String(req.body?.text ?? "").slice(0, 300);
  if (text) log(text);
  res.json({ ok: true });
});

app.use(express.static(resolve(SCRIPT_DIR, "public")));

app.use((req, res, next) => {
  const m = (req.headers.cookie ?? "").match(/cfa_sess=([^;]+)/);
  if (m && sessions.has(decodeURIComponent(m[1]))) return next();
  res.status(401).json({ error: "auth" });
});

app.use("/evidence", express.static(resolve(SCRIPT_DIR, "evidence"), { fallthrough: false }));

app.get("/api/state", (_req, res) => {
  const reports = [];
  if (existsSync(LOG)) {
    for (const line of readFileSync(LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { reports.push(JSON.parse(line)); } catch {}
    }
  }
  const evDir = resolve(SCRIPT_DIR, "evidence");
  const evidence = [];
  if (existsSync(evDir)) {
    for (const f of readdirSync(evDir)) {
      if (!/\.(jpg|jpeg|png)$/i.test(f)) continue;
      try { evidence.push({ name: f, url: "/evidence/" + f, mtime: statSync(resolve(evDir, f)).mtimeMs }); } catch {}
    }
    evidence.sort((a, b) => b.mtime - a.mtime);
  }
  const det = loadDetections().detections;
  res.json({
    running,
    queue,
    activity: activity.slice(-60),
    reports: reports.reverse().slice(0, 500),
    evidence: evidence.slice(0, 600),
    monitors: loadMonitors().watch,
    detections: det.filter((d) => d.status === "pending"),
    brands: loadBrands().brands,
  });
});

// saldiri zincirini baslat (feed + abuse-mail + 10 profil CF/GSB) — /api/report ve tespit onayi ortak
function startAttack({ target, official, brand, channel }) {
  if (!official && brand) official = brandOfficialUrl(brand);  // marka kaydindan official
  if (!target || !official) return { status: 400, body: { error: "sahte url + resmi url gerekli (marka kayitliysa resmi otomatik dolar)" } };
  if (running) {
    queue.push({ target, official, brand, channel: channel || "both", queuedTs: new Date().toISOString() });
    log(`>> kuyruga alindi (${queue.length}.): ${target} (${brand || "-"})`);
    return { status: 202, body: { queued: true, position: queue.length } };
  }
  const ch0 = channel === "gsb" || channel === "cf" ? channel : "both";
  autoWatch(target, official, brand);
  // her zaman 10 profilin tamami, sirayla
  const profiles = JSON.parse(readFileSync(resolve(SCRIPT_DIR, "../config/profiles.json"), "utf8")).profiles.map((p) => p.name);
  running = target;
  log(`>> sikayet basladi [${ch0}, ${profiles.length} profil]: ${target} (${brand || "-"})`);
  const jobs = [];
  // feed + abuse-mail: profil gerektirmez, once ve hizli biter
  jobs.push(["feed.mjs", ["--target", target, "--official", official, "--brand", brand ?? ""]]);
  jobs.push(["abuse-mail.mjs", ["--target", target, "--official", official, "--brand", brand ?? ""]]);
  for (const p of profiles) {
    if (ch0 !== "gsb") jobs.push(["report.mjs", ["--target", target, "--official", official, "--brand", brand ?? "", "--profile", p]]);
    if (ch0 !== "cf") jobs.push(["gsb-report.mjs", ["--target", target, "--profile", p]]);
  }
  // sirayla calistir — profiller/eszamanli cakisma olmasin
  const runNext = (i) => {
    if (i >= jobs.length) {
      log(`>> bitti: ${target}`);
      running = null;
      const next = queue.shift();
      if (next) { log(`>> kuyruktan basladi: ${next.target}`); startAttack(next); }
      return;
    }
    const [script, args] = jobs[i];
    const ch = spawn(process.execPath, [resolve(SCRIPT_DIR, script), ...args], { cwd: SCRIPT_DIR });
    ch.stdout.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => log(`[${script.split(".")[0]}] ` + l.trim())));
    ch.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => log("[!] " + l.trim().slice(0, 140))));
    ch.on("close", () => setTimeout(() => runNext(i + 1), 8000));  // launcher nefes alsin
  };
  runNext(0);
  return { status: 200, body: { started: true, channel: ch0, profiles: profiles.length } };
}

app.post("/api/report", (req, res) => {
  const { target, official, brand, channel } = req.body ?? {};
  const r = startAttack({ target, official, brand, channel });
  res.status(r.status).json(r.body);
});

// kuyruktaki hedefi iptal et (calisani durdurmaz)
app.post("/api/queue/cancel", (req, res) => {
  const target = String(req.body?.target ?? "");
  const before = queue.length;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].target === target) queue.splice(i, 1);
  const removed = before - queue.length;
  if (removed) log(`>> kuyruktan iptal: ${target}`);
  res.json({ ok: true, removed });
});

// ---- domain monitoru: tespit onay/red ----

app.get("/api/detections", (_req, res) => {
  const det = loadDetections().detections;
  res.json({
    pending: det.filter((d) => d.status === "pending"),
    resolved: det.filter((d) => d.status !== "pending").slice(-20).reverse(),
  });
});

app.post("/api/detections/approve", (req, res) => {
  const domain = String(req.body?.domain ?? "");
  const store = loadDetections();
  const det = store.detections.find((d) => d.domain === domain && d.status === "pending");
  if (!det) return res.status(404).json({ error: "pending tespit yok" });
  const official = det.official || "";
  const brand = det.brand || "";
  const r = startAttack({ target: `https://${domain}/`, official, brand, channel: "both" });
  if (r.status !== 200 && r.status !== 202) return res.status(r.status).json(r.body);
  det.status = "approved";
  det.resolvedTs = new Date().toISOString();
  writeJ(DETECTIONS, store);
  log(`>> tespit onaylandi: ${domain} — ${r.body.queued ? `kuyruga alindi (${r.body.position}.)` : "saldiri zinciri basladi"}`);
  res.json({ ok: true, ...r.body });
});

app.post("/api/detections/dismiss", (req, res) => {
  const domain = String(req.body?.domain ?? "");
  const store = loadDetections();
  const det = store.detections.find((d) => d.domain === domain && d.status === "pending");
  if (!det) return res.status(404).json({ error: "pending tespit yok" });
  det.status = "dismissed";
  det.resolvedTs = new Date().toISOString();
  writeJ(DETECTIONS, store);
  log(`>> tespit yoksayildi: ${domain}`);
  res.json({ ok: true });
});

app.post("/api/monitors/add", (req, res) => {
  const domain = String(req.body?.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!domain) return res.status(400).json({ error: "domain veya desen gerekli" });
  let official = String(req.body?.official ?? "");
  let brand = String(req.body?.brand ?? "");
  const r = upsertWatch({ domain, official, brand });
  if (!r) return res.status(400).json({ error: `desen uretilemedi: ${domain} (orn. rovbet123.com veya herabetN.cam)` });
  // official/brand verilmediyse marka kayitlarindan doldur
  if ((!official || !brand) && r.entry.stem) {
    const b = brandByName(r.entry.stem);
    if (b) {
      let touched = false;
      if (!r.entry.brand) { r.entry.brand = b.name; touched = true; }
      if (!r.entry.official && b.officialDomain) { r.entry.official = `https://${b.officialDomain}/`; touched = true; }
      if (touched) {
        const monitors = loadMonitors();
        const w = monitors.watch.find((x) => x.stem === r.entry.stem && x.tld === r.entry.tld);
        if (w) { w.brand = r.entry.brand; w.official = r.entry.official; writeJ(MONITORS, monitors); }
      }
    }
  }
  log(`>> monitor izlemesine eklendi: ${r.entry.stem}N.${r.entry.tld}${r.created ? "" : " (desen zaten vardi, guncellendi)"}`);
  res.json({ ok: true, created: r.created, pattern: `${r.entry.stem}N.${r.entry.tld}` });
});

// ---- marka kayitlari ----

app.get("/api/brands", (_req, res) => res.json({ brands: loadBrands().brands }));

app.post("/api/brands", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const resolverUrl = String(req.body?.resolverUrl ?? "").trim();
  if (!name || !resolverUrl) return res.status(400).json({ error: "marka adi + resolver linki gerekli" });
  const rz = await httpResolve(resolverUrl);
  const r = upsertBrand({ name, resolverUrl, officialDomain: rz.ok ? rz.host : "" });
  r.entry.lastResolveNote = rz.ok ? `http ${rz.status}` : rz.note;
  log(`>> marka ${r.created ? "eklendi" : "guncellendi"}: ${name} -> ${rz.ok ? rz.host : "(cozulemedi, resolver timer tekrarlar)"}`);
  res.json({ ok: true, created: r.created, officialDomain: r.entry.officialDomain, note: r.entry.lastResolveNote });
});

app.post("/api/brands/update", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const resolverUrl = String(req.body?.resolverUrl ?? "").trim();
  if (!name) return res.status(400).json({ error: "marka adi gerekli" });
  if (!brandByName(name)) return res.status(404).json({ error: "marka yok" });
  let officialDomain;
  if (resolverUrl) {
    const rz = await httpResolve(resolverUrl);
    officialDomain = rz.ok ? rz.host : "";
  }
  const r = upsertBrand({ name, resolverUrl: resolverUrl || undefined, officialDomain });
  log(`>> marka guncellendi: ${name} -> ${r.entry.officialDomain || "(cozulemedi)"}`);
  res.json({ ok: true, officialDomain: r.entry.officialDomain });
});

app.post("/api/brands/remove", (req, res) => {
  const name = String(req.body?.name ?? "");
  const removed = removeBrand(name);
  if (removed) log(`>> marka silindi: ${name}`);
  res.json({ ok: true, removed });
});

app.post("/api/monitors/remove", (req, res) => {
  const domain = String(req.body?.domain ?? "");
  const monitors = loadMonitors();
  const before = monitors.watch.length;
  monitors.watch = monitors.watch.filter((w) => w.domain !== domain);
  writeJ(MONITORS, monitors);
  res.json({ ok: true, removed: before - monitors.watch.length });
});

app.listen(PORT, () => console.log(`cf-abuse panel: http://localhost:${PORT} (${USER})`));
