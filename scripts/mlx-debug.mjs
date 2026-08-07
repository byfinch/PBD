#!/usr/bin/env node
/**
 * mlx-debug.mjs — iki profilde derin tanı.
 *  PBD-01: crash'in nerede oldugunu event'lerle yakala (page crash / disconnect)
 *  PBD-08: google /sorry sayfasinin icerigini dogrula
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Agent, fetch as uFetch } from "undici";
import { chromium } from "playwright-core";

try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const email = process.env.MULTILOGIN_EMAIL || "";
const password = process.env.MULTILOGIN_PASSWORD || "";
const base = process.env.MULTILOGIN_BASE_URL || "https://launcher.mlx.yt:45001";
const tls = new Agent({ connect: { rejectUnauthorized: false } });
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));

async function signin() {
  const res = await uFetch("https://api.multilogin.com/user/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: createHash("md5").update(password).digest("hex") }),
  });
  return (await res.json()).data.token;
}

async function api(token, path, params) {
  const url = new URL(path, base);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await uFetch(url, { headers: { Authorization: `Bearer ${token}` }, dispatcher: tls });
  const j = await res.json().catch(() => null);
  return { code: j?.status?.error_code ?? "", data: j?.data };
}

async function startProfile(token, p) {
  for (;;) {
    const r = await api(token, `/api/v2/profile/f/${mapping.folderId}/p/${p.id}/start`, {
      automation_type: "playwright",
      headless_mode: "false",
    });
    if (r.data?.port) return String(r.data.port);
    if (r.code.includes("CORE_DOWNLOADING")) {
      await new Promise((s) => setTimeout(s, 15000));
      continue;
    }
    if (r.code === "PROFILE_ALREADY_RUNNING") {
      await api(token, `/api/v1/profile/stop/p/${p.id}`);
      await new Promise((s) => setTimeout(s, 5000));
      continue;
    }
    throw new Error("start: " + r.code);
  }
}

const token = await signin();

// --- FAZ 1: PBD-01 crash tani ---
const p1 = mapping.profiles.find((x) => x.name === "PBD-01");
console.log("== FAZ 1: PBD-01 adim adim");
{
  const port = await startProfile(token, p1);
  console.log("start OK port", port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  browser.on("disconnected", () => console.log("!! browser disconnected"));
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("crash", () => console.log("!! PAGE CRASH"));
  page.on("close", () => console.log("!! page closed"));
  page.on("console", (m) => console.log("console:", m.text().slice(0, 80)));

  for (const url of ["about:blank", "https://example.com", "https://api.ipify.org?format=json"]) {
    try {
      const r = await page.goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });
      console.log(`goto ${url} -> ${r?.status()}`);
      if (url.includes("ipify")) console.log("body:", (await page.evaluate(() => document.body.innerText)).slice(0, 80));
    } catch (e) {
      console.log(`goto ${url} FAILED: ${String(e).split("\n")[0].slice(0, 100)}`);
      break;
    }
  }
  await browser.close().catch(() => {});
  await api(token, `/api/v1/profile/stop/p/${p1.id}`).catch(() => {});
  await new Promise((s) => setTimeout(s, 6000));
}

// --- FAZ 2: PBD-08 sorry icerigi ---
const p8 = mapping.profiles.find((x) => x.name === "PBD-08");
console.log("== FAZ 2: PBD-08 google sorry icerigi");
{
  const port = await startProfile(token, p8);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    const r = await page.goto("https://www.google.com/search?q=ucak+bileti&hl=tr&gl=tr", {
      timeout: 45000,
      waitUntil: "domcontentloaded",
    });
    console.log("status:", r?.status(), "final url:", page.url().slice(0, 90));
    const body = await page.evaluate(() => document.body.innerText);
    console.log("body ilk 250:", body.replace(/\n+/g, " | ").slice(0, 250));
  } catch (e) {
    console.log("google goto FAILED:", String(e).split("\n")[0].slice(0, 100));
  }
  await browser.close().catch(() => {});
  await api(token, `/api/v1/profile/stop/p/${p8.id}`).catch(() => {});
}
console.log("== BITTI");
