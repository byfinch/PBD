#!/usr/bin/env node
/**
 * mlx-serp-dom.mjs v2 — mobil SERP DOM tani (solver'li).
 * Duvar cikarsa once recovery ile cozer, sonra gercek SERP'in DOM'unu dokmek
 * icin aday anchor'lari listeler.
 * Kullanim: node scripts/mlx-serp-dom.mjs [PBD-01] [sorgu]
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { loadConfig } from "../dist/config.js";
import { Store } from "../dist/store/db.js";
import { SolverPolicy } from "../dist/captcha/policy.js";
import { recoverFromSorry, pageLooksLikeCaptcha } from "../dist/captcha/recovery.js";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";

try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const name = process.argv[2] || "PBD-01";
const query = process.argv[3] || "milanbahisde.com";
const config = loadConfig();
config.solver.enabled = true;

const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find((x) => x.name === name);
const driver = new MultiloginDriver(
  process.env.MULTILOGIN_BASE_URL || "https://launcher.mlx.yt:45001",
  mapping.folderId,
  process.env.MULTILOGIN_EMAIL || "",
  process.env.MULTILOGIN_PASSWORD || "",
  1100
);
const profile = {
  id: p.id,
  name: p.name,
  proxy: { host: "79.127.168.43", port: 50100, user: p.proxyLogin, password: "uDdliaN2SU", type: "HTTP" },
};

console.log("== start", name);
const ws = await driver.startBrowser(p.id);
const browser = await chromium.connectOverCDP(ws, { timeout: 15000 });
const store = new Store("./data");
try {
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=tr&gl=tr&num=10`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);

  if (await pageLooksLikeCaptcha(page)) {
    console.log("== duvar var — cozuluyor...");
    const policy = new SolverPolicy(store, config.solver);
    const r = await recoverFromSorry(page, config, profile, store.ipTrust, policy);
    console.log("recovery:", JSON.stringify(r));
    if (r.cleared) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2500);
    }
  }
  console.log("final url:", page.url().slice(0, 90));

  const info = await page.evaluate(() => {
    const rso = document.querySelector("#rso");
    const out = {
      hasRso: !!rso,
      hasSearch: !!document.querySelector("#search"),
      h3Count: document.querySelectorAll("h3").length,
      rsoAnchors: rso ? rso.querySelectorAll('a[href^="http"]').length : 0,
      candidates: [],
    };
    for (const a of Array.from(document.querySelectorAll('a[href^="http"]')).slice(0, 60)) {
      const href = a.href;
      if (/google\.|gstatic/.test(href)) continue;
      const text = (a.textContent || "").trim().slice(0, 55);
      if (!text) continue;
      out.candidates.push({
        href: href.slice(0, 45),
        hasH3: !!a.querySelector("h3"),
        headingInfo: (() => {
          const h = a.querySelector('h3, [role="heading"], [aria-level]');
          return h ? `${h.tagName}|role=${h.getAttribute("role")}|aria-level=${h.getAttribute("aria-level")}|cls=${(h.getAttribute("class")||"").slice(0,25)}` : "";
        })(),
        cls: (a.getAttribute("class") || "").slice(0, 35),
        inRso: !!(rso && rso.contains(a)),
        text,
      });
      if (out.candidates.length >= 14) break;
    }
    return out;
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 3000));
} finally {
  await browser.close().catch(() => {});
  await driver.stopBrowser(p.id).catch(() => {});
  store.db.close();
}
console.log("== BITTI");
