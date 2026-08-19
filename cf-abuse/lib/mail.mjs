/**
 * lib/mail.mjs — giden mail (postfix) + RDAP abuse-contact yardimcilari.
 * feed.mjs ve abuse-mail.mjs tarafindan kullanilir.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fetch as uFetch } from "undici";

const PBD = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function loadEnv() {
  for (const line of readFileSync(`${PBD}/.env`, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

export function domainOf(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

export function loadIdentities() {
  return JSON.parse(readFileSync(resolve(PBD, "cf-abuse/identities.json"), "utf8"));
}

export function pickIdentity(email) {
  const all = loadIdentities();
  if (email) {
    const hit = all.find((x) => x.email === email);
    if (hit) return hit;
    return { name: email.split("@")[0], email };
  }
  return all[Math.floor(Math.random() * all.length)];
}

// VPS: /opt/postfix altinda ozel kurulum; baska ortamda sistem sendmail'i.
const SENDMAIL_CANDIDATES = [
  { bin: "/opt/postfix/root/usr/sbin/sendmail.postfix", args: ["-C", "/opt/postfix/etc/postfix/main.cf"] },
  { bin: "/usr/sbin/sendmail", args: [] },
  { bin: "/usr/lib/sendmail", args: [] },
];

function sendmailCmd() {
  if (process.env.SENDMAIL_PATH) return { bin: process.env.SENDMAIL_PATH, args: [] };
  for (const c of SENDMAIL_CANDIDATES) if (existsSync(c.bin)) return c;
  throw new Error("sendmail bulunamadi");
}

/** Mail gonder. Donus: {ok, out} — sendmail cikis kodu 0 ise ok. */
export async function sendMail({ from, to, subject, text }) {
  const tos = Array.isArray(to) ? to : [to];
  const cmd = sendmailCmd();
  const msg = [
    `From: ${from}`, `To: ${tos.join(", ")}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
    "", text, "",
  ].join("\r\n");
  return await new Promise((res) => {
    const p = spawn(cmd.bin, [...cmd.args, "-t"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => res({ ok: false, out: String(e) }));
    p.on("close", (code) => res({ ok: code === 0, out: out.slice(0, 300) }));
    p.stdin.write(msg);
    p.stdin.end();
  });
}

// ---- RDAP ----

function vcardEmail(ent) {
  const vc = ent?.vcardArray?.[1];
  if (!Array.isArray(vc)) return null;
  for (const row of vc) {
    if (row?.[0] === "email") return String(row[3] || "").trim() || null;
  }
  return null;
}

function collectAbuse(ent, acc) {
  if (!ent) return;
  const roles = ent.roles || [];
  if (roles.includes("abuse")) {
    const em = vcardEmail(ent);
    if (em) acc.add(em.toLowerCase());
  }
  for (const sub of ent.entities || []) collectAbuse(sub, acc);
}

async function rdapJson(url) {
  const r = await uFetch(url, { headers: { "User-Agent": "pbd-abuse/1.0" }, maxRedirections: 5 });
  if (r.status !== 200) throw new Error(`rdap ${r.status}`);
  return await r.json();
}

/** Domain kayit otoritesi (registrar) abuse e-postalari. */
export async function registrarAbuse(domain) {
  const acc = new Set();
  try {
    const j = await rdapJson(`https://rdap.org/domain/${domain}`);
    for (const ent of j.entities || []) collectAbuse(ent, acc);
    // bazi RDAP yanitlarinda abuse registrar'in notices/remarks'inda olur — atla, entity yeterli
  } catch (e) {
    return { emails: [], error: String(e.message || e) };
  }
  return { emails: [...acc] };
}

/** IP blogu (hosting) abuse e-postalari. */
export async function hostingAbuse(ip) {
  const acc = new Set();
  try {
    const j = await rdapJson(`https://rdap.org/ip/${ip}`);
    for (const ent of j.entities || []) collectAbuse(ent, acc);
  } catch (e) {
    return { emails: [], error: String(e.message || e) };
  }
  return { emails: [...acc] };
}
