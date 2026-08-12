#!/usr/bin/env node
/**
 * _test-10.mjs — 10 profil × 2 marka akış testi.
 * Tek profiller dönüşümlü marka alır (PBD-01 milanbahis, PBD-02 rovbet, ...),
 * aynı anda en fazla 2 tarayıcı çalışır (engine concurrency ile aynı).
 * Kullanım: node scripts/_test-10.mjs [concurrency]
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { Store } from "../dist/store/db.js";
import { createAntidetectClient, selectProfiles } from "../dist/antidetect/client.js";
import { runVisitOnce } from "../dist/engine.js";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const CONCURRENCY = Math.max(1, Number(process.argv[2]) || 2);
const BRANDS = [
  { domain: "milanbahisde.com", keyword: "milanbahis" },
  { domain: "rovbett.com", keyword: "rovbet" },
];

const config = loadConfig();
const store = new Store(config.output.dir);
const antidetect = createAntidetectClient(config);
const deps = { config, store, antidetect };

const all = await antidetect.listProfiles();
const pool = selectProfiles(all, config).sort((a, b) => a.name.localeCompare(b.name));
console.log(`havuz: ${pool.length} profil, eşzamanlılık ${CONCURRENCY}`);
if (!pool.length) process.exit(1);

const jobs = pool.map((profile, i) => {
  const brand = BRANDS[i % BRANDS.length];
  return {
    profile,
    item: {
      profileId: profile.id,
      profileName: profile.name,
      keyword: brand.keyword,
      targetDomain: brand.domain,
      scheduledHour: new Date().getHours(),
    },
  };
});

const t0 = Date.now();
let cursor = 0;
async function worker(id) {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const tag = `${job.profile.name}→${job.item.targetDomain}`;
    console.log(`[w${id}] START ${tag}`);
    try {
      await runVisitOnce(deps, job.item, job.profile);
    } catch (e) {
      console.log(`[w${id}] CRASH ${tag}: ${String(e).slice(0, 100)}`);
    }
    const v = store.db
      .prepare(`SELECT status, position, error, dwell_ms, via_query FROM visits WHERE profile_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(job.profile.id);
    console.log(`[w${id}] DONE  ${tag} -> ${v?.status ?? "?"}${v?.position ? " poz " + v.position : ""}${v?.error ? " err: " + String(v.error).slice(0, 60) : ""}${v?.dwell_ms ? " dwell " + Math.round(v.dwell_ms / 1000) + "sn" : ""}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

console.log(`\n== ÖZET (${Math.round((Date.now() - t0) / 60000)} dk) ==`);
const rows = store.db
  .prepare(
    `SELECT profile_name, site_domain, keyword, status, position, dwell_ms, internal_clicks, error
     FROM visits WHERE id > ? ORDER BY profile_name`
  )
  .all(jobs.length ? (store.db.prepare(`SELECT COALESCE(MIN(id) - 1, 0) AS m FROM (SELECT id FROM visits ORDER BY rowid DESC LIMIT ?)`).get(jobs.length)?.m ?? 0) : 0);
for (const r of rows) {
  console.log(
    `${r.profile_name}  ${r.site_domain.padEnd(18)} ${String(r.status).padEnd(8)} ${r.position ? "poz " + r.position : "     "} ${r.dwell_ms ? Math.round(r.dwell_ms / 1000) + "sn" : "   "} ${r.internal_clicks ? r.internal_clicks + " içtık" : ""} ${r.error ? "ERR " + String(r.error).slice(0, 50) : ""}`
  );
}
store.db.close();
console.log("== BITTI");
