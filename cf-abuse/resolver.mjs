#!/usr/bin/env node
/**
 * resolver.mjs — marka resolver linklerini saatlik yeniden cozer (cf-resolver.timer).
 *
 *   node resolver.mjs            # tum markalari coz
 *   node resolver.mjs --name X   # tek marka
 *
 * HTTP cozum basarisizsa (bot korumasi) Mimic profiliyle dener.
 * officialDomain degisirse: brands.json guncellenir + panel activity +
 * monitors.json'daki ayni markali watch kayitlarinin official'i guncellenir.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetch as uFetch } from "undici";
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadEnv, loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { loadBrands, saveBrands, httpResolve } from "./lib/brands.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MONITORS = resolve(SCRIPT_DIR, "monitors.json");
const PANEL = process.env.PANEL_URL || "http://127.0.0.1:3090";
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null).filter(Boolean));

async function panelLog(text) {
  try {
    await uFetch(`${PANEL}/api/activity`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {}
}

/** Mimic profiliyle coz (bot korumali kisalticilar icin). */
async function profileResolve(url) {
  loadEnv();
  const mapping = loadProfiles();
  const profile = mapping.profiles[Math.floor(Math.random() * mapping.profiles.length)];
  const { port } = await startProfile(profile, mapping.folderId, 1);
  try {
    const cdp = await RawCdp.connect(port);
    await cdp.navigate(url);
    await sleep(15000);
    const hist = await cdp.call("Page.getNavigationHistory");
    const cur = hist.entries?.[hist.currentIndex]?.url || "";
    const host = cur ? new URL(cur).hostname.replace(/^www\./, "") : "";
    return { ok: !!host, host, note: `profil ${profile.name}` };
  } finally {
    await stopProfile(profile.id).catch(() => {});
  }
}

const store = loadBrands();
const only = args.name ? String(args.name).toLowerCase() : null;
const monitors = (() => { try { return JSON.parse(readFileSync(MONITORS, "utf8")); } catch { return { watch: [] } }; })();
let monitorsChanged = false;
let updated = 0, failed = 0;

for (const b of store.brands) {
  if (only && b.name.toLowerCase() !== only) continue;
  if (!b.resolverUrl) { console.log(`${b.name}: resolverUrl yok, atlaniyor`); continue; }
  let r = await httpResolve(b.resolverUrl);
  if (!r.ok) {
    console.log(`${b.name}: HTTP cozum yetersiz (${r.note}) — profil deneniyor`);
    try { r = await profileResolve(b.resolverUrl); } catch (e) { r = { ok: false, note: String(e.message || e).slice(0, 60) }; }
  }
  if (!r.ok || !r.host) { failed++; console.log(`${b.name}: COZULEMEDI (${r.note || "?"})`); continue; }
  const old = b.officialDomain;
  if (old !== r.host) {
    b.officialDomain = r.host;
    b.lastResolved = new Date().toISOString();
    updated++;
    console.log(`${b.name}: ${old || "(bos)"} -> ${r.host}`);
    await panelLog(`MARKA GUNCELLENDI: ${b.name} -> ${r.host}${old ? ` (eski: ${old})` : ""}`);
    // ayni markali watch kayitlarinin official'ini guncelle
    for (const w of monitors.watch) {
      if ((w.brand || "").toLowerCase() === b.name.toLowerCase()) {
        w.official = `https://${r.host}/`;
        monitorsChanged = true;
      }
    }
  } else {
    b.lastResolved = new Date().toISOString();
    console.log(`${b.name}: degisiklik yok (${r.host})`);
  }
}

saveBrands(store);
if (monitorsChanged) writeFileSync(MONITORS, JSON.stringify(monitors, null, 1));
console.log(`SONUC: ${store.brands.length} marka, ${updated} guncellendi, ${failed} cozulemedi`);
