#!/usr/bin/env node
/**
 * feed.mjs — hedef URL'yi phishing feed'lerine bildirir.
 *
 *   node feed.mjs --target https://phish.example/ [--official https://brand.com/] [--brand Marka] [--identity x@y]
 *
 * Kanallar: urlscan.io (public), VirusTotal v3, APWG (mail), CRDF (mail).
 * Kanit: reports.jsonl satirlari (source: "urlscan" | "vt" | "apwg" | "crdf").
 */
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetch as uFetch } from "undici";
import { loadEnv, domainOf, pickIdentity, sendMail } from "./lib/mail.mjs";

loadEnv();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null).filter(Boolean));
const TARGET = args.target;
const OFFICIAL = args.official || "";
const BRAND = args.brand || "";
if (!TARGET) {
  console.log("kullanim: node feed.mjs --target <phish-url> [--official <url>] [--brand <ad>] [--identity mail]");
  process.exit(1);
}
const domain = domainOf(TARGET);
const identity = pickIdentity(args.identity);
const t0 = Date.now();
const rows = [];

async function feedUrlscan() {
  const key = process.env.URLSCAN_API_KEY;
  if (!key) return console.log("urlscan: API key yok, atlaniyor");
  try {
    const r = await uFetch("https://urlscan.io/api/v1/scan/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "API-Key": key },
      body: JSON.stringify({ url: TARGET, visibility: "public", tags: ["phishing", BRAND].filter(Boolean) }),
    });
    const j = await r.json().catch(() => null);
    if (r.status === 200 && j?.uuid) {
      console.log(`urlscan: submitted uuid=${j.uuid}`);
      rows.push({ source: "urlscan", result: "submitted", note: `uuid=${j.uuid} ${j.result || ""}` });
    } else {
      console.log(`urlscan: HATA ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
      rows.push({ source: "urlscan", result: "error", note: `http ${r.status}` });
    }
  } catch (e) {
    console.log(`urlscan: HATA ${e.message}`);
    rows.push({ source: "urlscan", result: "error", note: String(e.message).slice(0, 120) });
  }
}

async function feedVt() {
  const key = process.env.VT_API_KEY;
  if (!key) return console.log("vt: API key yok, atlaniyor");
  try {
    const r = await uFetch("https://www.virustotal.com/api/v3/urls", {
      method: "POST",
      headers: { "x-apikey": key, "Content-Type": "application/x-www-form-urlencoded" },
      body: `url=${encodeURIComponent(TARGET)}`,
    });
    const j = await r.json().catch(() => null);
    const id = j?.data?.id;
    if ((r.status === 200 || r.status === 201) && id) {
      console.log(`vt: submitted analysis=${id}`);
      rows.push({ source: "vt", result: "submitted", note: `analysis=${id}` });
    } else {
      console.log(`vt: HATA ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
      rows.push({ source: "vt", result: "error", note: `http ${r.status}` });
    }
  } catch (e) {
    console.log(`vt: HATA ${e.message}`);
    rows.push({ source: "vt", result: "error", note: String(e.message).slice(0, 120) });
  }
}

async function feedMail(source, to) {
  const text = [
    `Phishing URL report`,
    ``,
    `Phishing URL : ${TARGET}`,
    `Impersonated : ${OFFICIAL}${BRAND ? ` (${BRAND})` : ""}`,
    `Domain       : ${domain}`,
    ``,
    `Active phishing page impersonating the official ${BRAND || "brand"} website,`,
    `harvesting user credentials. Please add to your blocklist/feed.`,
    ``,
    `Reporter: ${identity.name} <${identity.email}>`,
    `Time (UTC): ${new Date().toISOString()}`,
  ].join("\r\n");
  const r = await sendMail({ from: `${identity.name} <${identity.email}>`, to, subject: `Phishing report: ${domain}`, text });
  console.log(`${source}: ${r.ok ? "gonderildi (queued)" : "HATA"} -> ${to}`);
  rows.push({ source, result: r.ok ? "sent" : "error", note: `mail -> ${to}` });
}

await feedUrlscan();
await feedVt();
await feedMail("apwg", "reportphishing@apwg.org");
await feedMail("crdf", "reportphishing@crdf.fr");

for (const row of rows) {
  appendFileSync(
    resolve(SCRIPT_DIR, "reports.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      source: row.source,
      identity: identity.email,
      target: TARGET,
      official: OFFICIAL,
      brand: BRAND,
      result: row.result,
      note: row.note,
      ms: Date.now() - t0,
    }) + "\n"
  );
}
const okc = rows.filter((r) => r.result !== "error").length;
console.log(`SONUC: ${okc}/${rows.length} kanal ok | ${domain} | ${rows.map((r) => r.source + ":" + r.result).join(" ")} | ${Math.round((Date.now() - t0) / 1000)}sn`);
