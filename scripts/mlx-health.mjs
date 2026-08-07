#!/usr/bin/env node
/**
 * mlx-health.mjs — 10 MLX profili için saglik turu.
 * Her profil icin: start -> CDP baglan -> ip-api.com/json -> exit IP dogrula -> stop.
 * Kullanim: node scripts/mlx-health.mjs   (PBD kok dizininden; .env okunur)
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Agent, fetch as uFetch } from "undici";
import { chromium } from "playwright-core";

const BASE = process.env.MULTILOGIN_BASE_URL || "https://launcher.mlx.yt:45001";
const EMAIL = process.env.MULTILOGIN_EMAIL || "";
const PASSWORD = process.env.MULTILOGIN_PASSWORD || "";

// .env varsa yukle (dotenv'siz, basit parse)
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const email = process.env.MULTILOGIN_EMAIL || EMAIL;
const password = process.env.MULTILOGIN_PASSWORD || PASSWORD;
const base = process.env.MULTILOGIN_BASE_URL || BASE;
if (!email || !password) {
  console.error("MULTILOGIN_EMAIL/PASSWORD yok (.env)");
  process.exit(1);
}

const tls = new Agent({ connect: { rejectUnauthorized: false } });
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const folderId = mapping.folderId;

async function signin() {
  const res = await uFetch("https://api.multilogin.com/user/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: createHash("md5").update(password).digest("hex") }),
  });
  const j = await res.json();
  if (!j?.data?.token) throw new Error("signin failed: " + JSON.stringify(j).slice(0, 150));
  return j.data.token;
}

async function api(token, path, params) {
  const url = new URL(path, base);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await uFetch(url, { headers: { Authorization: `Bearer ${token}` }, dispatcher: tls });
  const j = await res.json().catch(() => null);
  return { http: res.status, code: j?.status?.error_code ?? "", msg: j?.status?.message ?? "", data: j?.data };
}

async function startProfile(token, p) {
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    const r = await api(token, `/api/v2/profile/f/${folderId}/p/${p.id}/start`, {
      automation_type: "playwright",
      headless_mode: "false",
    });
    if (r.data?.port) return String(r.data.port);
    if (r.code.includes("CORE_DOWNLOADING") && Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 15000));
      continue;
    }
    if (r.code === "PROFILE_ALREADY_RUNNING") {
      await api(token, `/api/v1/profile/stop/p/${p.id}`);
      await new Promise((s) => setTimeout(s, 5000));
      continue;
    }
    throw new Error(`start: ${r.code || r.msg || "HTTP " + r.http}`);
  }
}

async function checkProfile(token, p) {
  const port = await startProfile(token, p);
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const res = await page.goto("http://ip-api.com/json/?fields=status,query,country,city", {
      timeout: 45000,
      waitUntil: "domcontentloaded",
    });
    const text = await page.evaluate(() => document.body.innerText);
    const info = JSON.parse(text);
    const match = info.query === p.exitIp;
    return {
      ok: match && info.status === "success",
      detail: `${info.query} ${info.country}/${info.city} http:${res?.status()}${match ? "" : " BEKLENEN:" + p.exitIp}`,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await api(token, `/api/v1/profile/stop/p/${p.id}`).catch(() => {});
  }
}

const token = await signin();
console.log(`token OK — ${mapping.profiles.length} profil, folder ${folderId}`);
let okCount = 0;
for (const p of mapping.profiles) {
  try {
    const r = await checkProfile(token, p);
    if (r.ok) okCount++;
    console.log(`${r.ok ? "OK  " : "FAIL"} ${p.name} (${p.os}) ${r.detail}`);
  } catch (err) {
    console.log(`FAIL ${p.name} (${p.os}) ${String(err).slice(0, 140)}`);
  }
}
console.log(`OZET: ${okCount}/${mapping.profiles.length} profil temiz`);
