#!/usr/bin/env node
/**
 * mlx-flow-probe.mjs — engine akisini birebir tekrarlar:
 * start -> applyMobileEmulation -> consent -> openSerp -> parseOrganicResults
 * ve parse sonucunu dokmek. Amaç: engine'in neden "1. sayfada yok" dedigini gormek.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";
import { BrowserSession } from "../dist/browser/session.js";
import { applyMobileEmulation } from "../dist/browser/mobileEmulation.js";
import { prepareGoogleConsent, openSerp, parseOrganicResults, findTarget } from "../dist/serp/finder.js";

try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const name = process.argv[2] || "PBD-01";
const query = process.argv[3] || "milanbahisde.com";
const config = loadConfig();
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find((x) => x.name === name);
const driver = new MultiloginDriver(
  process.env.MULTILOGIN_BASE_URL || "https://launcher.mlx.yt:45001",
  mapping.folderId,
  process.env.MULTILOGIN_EMAIL || "",
  process.env.MULTILOGIN_PASSWORD || "",
  1100
);

console.log("== start", name);
const ws = await driver.startBrowser(p.id);
const session = await BrowserSession.attach(ws);
try {
  const page = session.page;
  await applyMobileEmulation(page);
  await prepareGoogleConsent(session);
  const ok = await openSerp(page, config, query);
  console.log("openSerp:", ok, "| url:", page.url().slice(0, 80));

  const parsed = await parseOrganicResults(page);
  console.log("empty:", parsed.empty, "| sonuc sayisi:", parsed.results.length);
  for (const r of parsed.results.slice(0, 6)) {
    console.log(`  [${r.position}] ${r.domain} | ${r.title.slice(0, 40)}`);
  }
  const t = findTarget(parsed.results, "milanbahisde.com");
  console.log("findTarget:", t ? `POZ ${t.position}` : "NULL");

  if (!parsed.results.length) {
    const dom = await page.evaluate(() => ({
      hasRso: !!document.querySelector("#rso"),
      anchors: document.querySelectorAll('#rso a[href^="http"]').length,
      withHeading: document.querySelectorAll('#rso a[href^="http"] h3, #rso a[href^="http"] [role="heading"]').length,
      bodyStart: (document.body?.innerText || "").slice(0, 150),
    }));
    console.log("DOM ozet:", JSON.stringify(dom));
  }
} finally {
  await session.detach().catch(() => {});
  await driver.stopBrowser(p.id).catch(() => {});
}
console.log("== BITTI");
