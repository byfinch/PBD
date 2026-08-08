#!/usr/bin/env node
/**
 * mlx-serp-dom.mjs — mobil SERP DOM tani.
 * PBD-05 (android) ile "milanbahisde.com" sorgusunu acar, organik sonuclarin
 * DOM yapisini dokmek icin aday anchor'lari inceler.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";

try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find((x) => x.name === (process.argv[2] || "PBD-05"));
const driver = new MultiloginDriver(
  process.env.MULTILOGIN_BASE_URL || "https://launcher.mlx.yt:45001",
  mapping.folderId,
  process.env.MULTILOGIN_EMAIL || "",
  process.env.MULTILOGIN_PASSWORD || "",
  1100
);

console.log("== start", p.name);
const ws = await driver.startBrowser(p.id);
const browser = await chromium.connectOverCDP(ws, { timeout: 15000 });
try {
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const url = "https://www.google.com/search?q=" + encodeURIComponent(process.argv[3] || "milanbahisde.com") + "&hl=tr&gl=tr&num=10";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);
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
    const anchors = Array.from(document.querySelectorAll('a[href^="http"]')).slice(0, 40);
    for (const a of anchors) {
      const href = a.href;
      if (/google\.|gstatic/.test(href)) continue;
      const h3 = a.querySelector("h3");
      const heading = a.querySelector('[role="heading"], [aria-level]');
      const text = (a.textContent || "").trim().slice(0, 60);
      if (!text) continue;
      out.candidates.push({
        href: href.slice(0, 50),
        hasH3: !!h3,
        hasHeading: !!heading,
        cls: (a.getAttribute("class") || "").slice(0, 40),
        parentCls: (a.parentElement?.getAttribute("class") || "").slice(0, 40),
        inRso: !!(rso && rso.contains(a)),
        text,
      });
      if (out.candidates.length >= 12) break;
    }
    return out;
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 2600));
} finally {
  await browser.close().catch(() => {});
  await driver.stopBrowser(p.id).catch(() => {});
}
console.log("== BITTI");
