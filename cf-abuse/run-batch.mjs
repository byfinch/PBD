#!/usr/bin/env node
/**
 * run-batch.mjs — coklu hedef raporlayici.
 *
 * targets.txt formati (her satir):  phish_url | official_url | brand
 *   https://sahte.cam/ | https://primebahis404.com/ | Primebahis
 *
 * Davranis:
 *  - Profil rotasyonu (PBD-01..10 sirayla), kimlik rotasyonu (deterministik)
 *  - (kimlik, hedef) cifti daha once raporlandiysa ATLAR (sunucu dedupe'u)
 *  - Raporlar arasi 45-120 sn jitter
 *  - Her rapor reports.jsonl'e islenir
 *
 * Kullanim: node run-batch.mjs [targets.txt]
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PBD = resolve(SCRIPT_DIR, "..");
const mapping = JSON.parse(readFileSync(`${PBD}/config/profiles.json`, "utf8"));
const identities = JSON.parse(readFileSync(resolve(SCRIPT_DIR, "identities.json"), "utf8"));
const targetsFile = process.argv[2] || resolve(SCRIPT_DIR, "targets.txt");

const lines = readFileSync(targetsFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const targets = lines.map((l) => {
  const [target, official = "", brand = ""] = l.split("|").map((x) => x.trim());
  return { target, official, brand };
});

// onceki raporlar (dedupe guard)
const done = new Set();
const logPath = resolve(SCRIPT_DIR, "reports.jsonl");
if (existsSync(logPath)) {
  for (const l of readFileSync(logPath, "utf8").split("\n")) {
    try {
      const r = JSON.parse(l);
      if (r.result === "submitted" || r.result === "dedupe") done.add(`${r.identity}|${r.target}`);
    } catch {}
  }
}

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
console.log(`${targets.length} hedef, ${done.size} tamamlanmis cift, ${mapping.profiles.length} profil`);

let idIdx = 0;
for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  const profile = mapping.profiles[i % mapping.profiles.length];
  // bu hedef icin kullanılmamis kimlik sec
  let identity = null;
  for (let k = 0; k < identities.length; k++) {
    const cand = identities[(idIdx + k) % identities.length];
    if (!done.has(`${cand.email}|${t.target}`)) { identity = cand; idIdx = (idIdx + k + 1) % identities.length; break; }
  }
  if (!identity) {
    console.log(`ATLA ${t.target} — tum kimlikler kullanilmis`);
    continue;
  }

  console.log(`\n[${i + 1}/${targets.length}] ${t.target} → ${profile.name} / ${identity.email}`);
  const args = [
    resolve(SCRIPT_DIR, "report.mjs"),
    "--target", t.target,
    "--official", t.official,
    "--brand", t.brand,
    "--profile", profile.name,
    "--identity", identity.email,
  ];
  const res = await new Promise((res2) => {
    const ch = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    ch.stdout.on("data", (d) => { out += d; });
    ch.stderr.on("data", (d) => { out += d; });
    ch.on("close", (code) => res2(out));
  });
  const m = out.match(/SONUC: (\S+)/);
  const verdict = m ? m[1] : "crashed";
  console.log(`sonuc: ${verdict}`);
  if (verdict === "submitted" || verdict === "dedupe") done.add(`${identity.email}|${t.target}`);

  if (i < targets.length - 1) {
    const wait = 45_000 + Math.random() * 75_000;
    console.log(`sonraki rapora ${Math.round(wait / 1000)}sn...`);
    await sleep(wait);
  }
}
console.log("\n== BATCH BITTI ==");
