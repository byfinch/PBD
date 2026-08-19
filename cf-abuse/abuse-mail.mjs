#!/usr/bin/env node
/**
 * abuse-mail.mjs — hedef domain'in registrar (ve varsa hosting) abuse adresine
 * postfix uzerinden kanitli phishing sikayet maili gonderir.
 *
 *   node abuse-mail.mjs --target https://phish.example/ --official https://brand.com/ --brand Marka [--identity x@y] [--dry]
 *
 * Kanit: reports.jsonl satiri (source: "registrar" / "hosting").
 */
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve4 } from "node:dns/promises";
import { loadEnv, domainOf, pickIdentity, sendMail, registrarAbuse, hostingAbuse } from "./lib/mail.mjs";

loadEnv();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null).filter(Boolean));
const TARGET = args.target;
const OFFICIAL = args.official || "";
const BRAND = args.brand || "";
const DRY = !!args.dry;
if (!TARGET) {
  console.log("kullanim: node abuse-mail.mjs --target <phish-url> --official <url> --brand <ad> [--identity mail] [--dry]");
  process.exit(1);
}

const domain = domainOf(TARGET);
const identity = pickIdentity(args.identity);
const t0 = Date.now();

const reg = await registrarAbuse(domain);
let host = { emails: [] };
try {
  const [ip] = await resolve4(domain);
  if (ip) host = await hostingAbuse(ip);
} catch {}
// Cloudflare abuse'i zaten report.mjs kanaliyla gidiyor — tekrar gonderme
host.emails = host.emails.filter((e) => !/cloudflare/i.test(e));

console.log(`registrar abuse: ${reg.emails.join(", ") || "YOK"}${reg.error ? " (hata: " + reg.error + ")" : ""}`);
console.log(`hosting abuse: ${host.emails.join(", ") || "YOK"}${host.error ? " (hata: " + host.error + ")" : ""}`);

const body = (kind) => [
  `Hello abuse team,`,
  ``,
  `I am reporting an active phishing website hosted/registered under your responsibility.`,
  ``,
  `Phishing URL : ${TARGET}`,
  `Impersonated : ${OFFICIAL}${BRAND ? ` (${BRAND})` : ""}`,
  `Domain       : ${domain}`,
  ``,
  `The page imitates the official ${BRAND || "brand"} website and tricks users into submitting`,
  `their login credentials and personal information. It is an exact visual clone of the`,
  `legitimate service and is actively being distributed.`,
  ``,
  `Please suspend the ${kind === "registrar" ? "domain registration" : "hosting account"} as soon as possible.`,
  ``,
  `Reporter: ${identity.name} <${identity.email}>`,
  `Time (UTC): ${new Date().toISOString()}`,
].join("\r\n");

const rows = [];
async function fire(source, emails) {
  if (!emails.length) { console.log(`${source}: alici yok, atlaniyor`); return; }
  if (DRY) { console.log(`${source}: DRY — ${emails.join(", ")}`); return; }
  const r = await sendMail({
    from: `${identity.name} <${identity.email}>`,
    to: emails,
    subject: `Phishing report: ${domain}`,
    text: body(source),
  });
  console.log(`${source}: ${r.ok ? "gonderildi (queued)" : "HATA"} -> ${emails.join(", ")} ${r.out ? r.out.split("\n")[0] : ""}`);
  rows.push({ source, emails, ok: r.ok });
}

await fire("registrar", reg.emails);
await fire("hosting", host.emails);

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
      result: row.ok ? "sent" : "error",
      note: `abuse mail -> ${row.emails.join(", ")}`,
      ms: Date.now() - t0,
    }) + "\n"
  );
}
const okCount = rows.filter((r) => r.ok).length;
console.log(`SONUC: ${rows.length ? (okCount === rows.length ? "sent" : "kismi") : "alici-yok"} | ${domain} | ${rows.map((r) => r.source + ":" + r.emails.length).join(" ")} | ${Math.round((Date.now() - t0) / 1000)}sn`);
