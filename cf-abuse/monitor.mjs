#!/usr/bin/env node
/**
 * monitor.mjs — komsu domain taramasi (tek tur; systemd timer ile 10dk'da bir).
 *
 *   node monitor.mjs --domain herabet392.cam [--span 5] [--panel http://127.0.0.1:3090]
 *
 * Desen: <harf><sayi>.<tld> → ±span numarali komsulari DNS resolve dener.
 * YENI aktif domain bulunca reports.jsonl (source:"monitor") + panel activity.
 * Otomatik saldiri BASLATMAZ — sadece tespit ve log.
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve4 } from "node:dns/promises";
import { fetch as uFetch } from "undici";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(SCRIPT_DIR, "monitor-state.json");
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null).filter(Boolean));
const DOMAIN = args.domain;
const SPAN = Number(args.span ?? 5);
const PANEL = args.panel || "http://127.0.0.1:3090";
if (!DOMAIN) {
  console.log("kullanim: node monitor.mjs --domain <ornek123.tld> [--span 5] [--panel url]");
  process.exit(1);
}

const m = DOMAIN.match(/^([a-z-]+?)(\d+)\.([a-z.]+)$/i);
if (!m) { console.log(`desen cikartilamadi: ${DOMAIN}`); process.exit(1); }
const [, stem, numS, tld] = m;
const num = Number(numS);

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { seen: {} };
const candidates = [];
for (let n = Math.max(0, num - SPAN); n <= num + SPAN; n++) {
  if (n === num) continue;
  candidates.push(`${stem}${n}.${tld}`);
}

const active = [];
for (const d of candidates) {
  try {
    const ips = await resolve4(d);
    if (ips?.length) active.push({ domain: d, ip: ips[0] });
  } catch {}
}

const t0 = Date.now();
const fresh = active.filter((a) => !state.seen[a.domain]);
for (const a of active) state.seen[a.domain] ??= new Date().toISOString();
writeFileSync(STATE, JSON.stringify(state, null, 1));

async function panelLog(text) {
  try {
    await uFetch(`${PANEL}/api/activity`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {}
}

for (const a of fresh) {
  const note = `yeni aktif komsu domain (desen: ${stem}N.${tld}, ip: ${a.ip})`;
  appendFileSync(
    resolve(SCRIPT_DIR, "reports.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      source: "monitor",
      target: `https://${a.domain}/`,
      result: "active",
      note,
      ms: Date.now() - t0,
    }) + "\n"
  );
  await panelLog(`YENI DOMAIN: ${a.domain} (${a.ip}) — ${DOMAIN} komsusu, onay bekleniyor`);
  console.log(`YENI DOMAIN: ${a.domain} (${a.ip})`);
}
console.log(`SONUC: ${active.length} aktif / ${candidates.length} aday tarandi, ${fresh.length} yeni | ${stem}N.${tld} ±${SPAN} | ${Math.round((Date.now() - t0) / 1000)}sn`);
