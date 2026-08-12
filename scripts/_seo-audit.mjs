#!/usr/bin/env node
/** _seo-audit.mjs — site: index kapsamı + marka SERP rekabet haritası. */
import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { Store } from "../dist/store/db.js";
import { SolverPolicy } from "../dist/captcha/policy.js";
import { recoverFromSorry, pageLooksLikeCaptcha } from "../dist/captcha/recovery.js";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";
import { BrowserSession } from "../dist/browser/session.js";
import { prepareGoogleConsent, openSerp, parseOrganicResults } from "../dist/serp/finder.js";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const name = process.argv[2] || "PBD-01";
const QUERIES = ["site:milanbahisde.com", "site:rovbett.com", "milanbahis", "rovbet", "rovbett", "milanbahis giriş", "rovbet giriş"];

const config = loadConfig();
config.solver.enabled = true;
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find((x) => x.name === name);
const driver = new MultiloginDriver(process.env.MULTILOGIN_BASE_URL, mapping.folderId, process.env.MULTILOGIN_EMAIL, process.env.MULTILOGIN_PASSWORD, 1100);
const profile = { id: p.id, name: p.name, proxy: { host: "79.127.168.43", port: 50100, user: p.proxyLogin, password: "uDdliaN2SU", type: "HTTP" } };

const ws = await driver.startBrowser(p.id);
const session = await BrowserSession.attach(ws);
const store = new Store("./data");
const policy = new SolverPolicy(store, config.solver);
try {
  const page = session.page;
  await prepareGoogleConsent(session);
  for (const q of QUERIES) {
    let ok = await openSerp(page, config, q).catch(() => false);
    if (!ok || (await pageLooksLikeCaptcha(page))) {
      const r = await recoverFromSorry(page, config, profile, store.ipTrust, policy);
      if (r.cleared) ok = await openSerp(page, config, q).catch(() => false);
    }
    if (!ok || (await pageLooksLikeCaptcha(page))) { console.log(`\n== ${q} -> DUVAR, atlandı`); continue; }
    const parsed = await parseOrganicResults(page);
    // site: sorgularında tahmini sonuç sayısını da çek
    const stats = await page.evaluate(() => document.querySelector("#result-stats")?.textContent ?? "").catch(() => "");
    console.log(`\n== ${q} ${stats ? "(" + stats.slice(0, 60) + ")" : ""}`);
    for (const r of parsed.results.slice(0, 10)) console.log(`  ${r.position}. ${r.domain}  ${r.title.slice(0, 60)}`);
    await new Promise((s) => setTimeout(s, 5000));
  }
} finally {
  await session.detach().catch(() => {});
  await driver.stopBrowser(p.id).catch(() => {});
  store.db.close();
}
console.log("\n== BITTI");
