#!/usr/bin/env node
/** _track-one.mjs — tek profil, tek domain, istenen sorgularda derin pozisyon taraması.
 *  Kullanım: node scripts/_track-one.mjs PBD-01 fergiohousegiris.com "fergiohouse" "fergiohouse giriş" */
import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { Store } from "../dist/store/db.js";
import { SolverPolicy } from "../dist/captcha/policy.js";
import { recoverFromSorry, pageLooksLikeCaptcha } from "../dist/captcha/recovery.js";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";
import { BrowserSession } from "../dist/browser/session.js";
import { applyMobileEmulation } from "../dist/browser/mobileEmulation.js";
import { prepareGoogleConsent, openSerp, parseOrganicResults, findTarget, goToNextSerpPage } from "../dist/serp/finder.js";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const name = process.argv[2] || "PBD-01";
const MOBILE = process.argv.includes("--mobile");
const DOMAIN = process.argv[3];
const KEYWORDS = process.argv.slice(4).filter((a) => a !== "--mobile");
if (!DOMAIN || !KEYWORDS.length) { console.log("kullanım: _track-one.mjs <profil> <domain> <kw...>"); process.exit(1); }
const MAXP = 10;

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
  if (MOBILE) await applyMobileEmulation(page);
  await prepareGoogleConsent(session);
  for (const kw of KEYWORDS) {
    let position = null;
    let ok = await openSerp(page, config, kw).catch(() => false);
    if (!ok || (await pageLooksLikeCaptcha(page))) {
      const r = await recoverFromSorry(page, config, profile, store.ipTrust, policy);
      if (r.cleared) ok = await openSerp(page, config, kw).catch(() => false);
    }
    if (ok && !(await pageLooksLikeCaptcha(page))) {
      let pageNum = 1;
      let parsed = await parseOrganicResults(page);
      let hit = findTarget(parsed.results, DOMAIN);
      while (!hit && pageNum < MAXP) {
        const prev = parsed.results.length;
        const moved = await goToNextSerpPage(page, { navTimeoutMs: config.engine.navTimeoutMs });
        if (!moved) break;
        pageNum++;
        const re = await parseOrganicResults(page);
        if (re.empty) break;
        if (re.results.length <= prev) for (const r of re.results) r.position = (pageNum - 1) * 10 + r.position;
        parsed = re;
        hit = findTarget(parsed.results, DOMAIN);
      }
      position = hit?.position ?? null;
      if (hit) console.log(`  [${kw}] bulunan: ${hit.url.slice(0, 80)}`);
    }
    console.log(`${kw} -> ${position ? "POZ " + position : "YOK (top " + MAXP * 10 + "+)"}${ok ? "" : " (duvar)"}`);
    store.insertPosition({ date: new Date().toISOString().slice(0, 10), keyword: kw, domain: DOMAIN, position, device: "desktop" });
    await new Promise((s) => setTimeout(s, 4000));
  }
} finally {
  await session.detach().catch(() => {});
  await driver.stopBrowser(p.id).catch(() => {});
  store.db.close();
}
console.log("== BITTI");
