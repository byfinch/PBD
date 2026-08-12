#!/usr/bin/env node
/**
 * _trust-warmup.mjs — profil güven rehabilitasyonu (bet/marka sorgusu YOK).
 *
 * Tek uzun oturum: google ana sayfa → trend gezintisi → nötr havuz sorguları
 * → nötr organik sonuca tık + sitede dwell → ana sayfaya dönüş. Duvar çıkarsa
 * 2 turlu solver döngüsüyle çözülür; çözüm sonrası nötr aktivite devam eder
 * (GOOGLE_ABUSE_EXEMPTION çalışsın diye). Çıkışta nötr probe ile raporlar:
 * sonuç CLEAN (güvenli) ya da WALL (hâlâ sıcak).
 *
 * Kullanım: node scripts/_trust-warmup.mjs PBD-01 [tur sayısı]
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { Store } from "../dist/store/db.js";
import { SolverPolicy } from "../dist/captcha/policy.js";
import { recoverFromSorry, pageLooksLikeCaptcha } from "../dist/captcha/recovery.js";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";
import { BrowserSession } from "../dist/browser/session.js";
import { prepareGoogleConsent, openSerp, parseOrganicResults, clickOrganicResult, scrollToTop, typeSearch } from "../dist/serp/finder.js";
import { sessionTrendWarmup } from "../dist/serp/trendWarmup.js";
import { dwellOnPage, runSiteVisit } from "../dist/behavior/siteVisit.js";
import { behaviorForProfile } from "../dist/util/persona.js";
import { randInt, sleep } from "../dist/util/time.js";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const name = process.argv[2] || "PBD-01";
const ROUNDS = Math.max(2, Number(process.argv[3]) || 4);

const config = loadConfig();
config.solver.enabled = true;
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find((x) => x.name === name);
const driver = new MultiloginDriver(process.env.MULTILOGIN_BASE_URL, mapping.folderId, process.env.MULTILOGIN_EMAIL, process.env.MULTILOGIN_PASSWORD, 1100);
const profile = { id: p.id, name: p.name, proxy: { host: "79.127.168.43", port: 50100, user: p.proxyLogin, password: "uDdliaN2SU", type: "HTTP" } };
const persona = behaviorForProfile(config.behavior, p.name);

const ws = await driver.startBrowser(p.id);
const session = await BrowserSession.attach(ws);
const store = new Store("./data");
const policy = new SolverPolicy(store, config.solver);
const page = session.page;

const goHome = async () => {
  await page.goto(`https://${config.google.domain}/?hl=tr&gl=tr`, { waitUntil: "domcontentloaded", timeout: config.engine.navTimeoutMs }).catch(() => {});
  await sleep(randInt(1_500, 3_500));
};

/** Duvar dalı: engine'deki 2 turlu döngünün aynısı. */
const ensureClear = async (q) => {
  for (let round = 0; round < 2 && (await pageLooksLikeCaptcha(page)); round++) {
    console.log(`  duvar (tur ${round + 1}) — solver devrede`);
    const recovery = await recoverFromSorry(page, config, profile, store.ipTrust, policy);
    if (!recovery.cleared) return false;
    console.log(`  duvar çözüldü${recovery.hadWall ? "" : " (yanlış pozitifti)"}`);
    await openSerp(page, config, q).catch(() => {});
    if (await pageLooksLikeCaptcha(page)) await sleep(randInt(15_000, 25_000));
    await openSerp(page, config, q).catch(() => {});
  }
  return !(await pageLooksLikeCaptcha(page));
};

let outcome = "FAIL";
try {
  await prepareGoogleConsent(session);

  // 1) Trend gezintisi (ısınma)
  const warm = await sessionTrendWarmup(page, config, {});
  console.log(`trend ısınması: "${warm.trend}" (${warm.method})`);

  // 2) Nötr sorgu turları
  const pool = [...config.warmup.queries];
  for (let round = 0; round < ROUNDS; round++) {
    const q = pool[randInt(0, pool.length - 1)];
    console.log(`tur ${round + 1}/${ROUNDS}: "${q}"`);
    await scrollToTop(page);
    let ok = await typeSearch(page, q, { navTimeoutMs: config.engine.navTimeoutMs }).catch(() => false);
    if (!ok) ok = await openSerp(page, config, q).catch(() => false);
    if (!(await ensureClear(q))) {
      console.log("  duvar aşılamadı — güvenli rehab ile kapanış");
      await goHome();
      await dwellOnPage(page, persona, { budgetMs: { min: 30_000, max: 60_000 } });
      outcome = "WALL";
      break;
    }
    const parsed = await parseOrganicResults(page);
    if (!parsed.empty && parsed.results.length) {
      await dwellOnPage(page, persona, { budgetMs: { min: 8_000, max: 18_000 } });
      // Nötr organik tık + sitede dwell (her turda değil, insan gibi)
      if (Math.random() < 0.7) {
        const pick = parsed.results[randInt(0, Math.min(3, parsed.results.length - 1))];
        await sleep(randInt(1_500, 3_500));
        const landed = await clickOrganicResult(page, pick, { navTimeoutMs: config.engine.navTimeoutMs });
        if (landed && !/google\./.test(landed.url())) {
          const v = await runSiteVisit(landed, persona, pick.domain, { navTimeoutMs: config.engine.navTimeoutMs });
          console.log(`  nötr tık → ${pick.domain} (${Math.round(v.dwellMs / 1000)}sn dwell)`);
        } else {
          console.log("  tık gerçekleşmedi (sessiz geçti)");
        }
      }
    }
    await goHome();
    await dwellOnPage(page, persona, { budgetMs: { min: 5_000, max: 12_000 } });
    if (round === ROUNDS - 1) outcome = "CLEAN?";
  }

  // 3) Probe: nötr sorgu duvarsız geçiyor mu?
  if (outcome !== "WALL") {
    const probe = "hava durumu istanbul";
    console.log(`probe: "${probe}"`);
    const ok = await openSerp(page, config, probe).catch(() => false);
    const wall = await pageLooksLikeCaptcha(page);
    outcome = ok && !wall ? "CLEAN" : "WALL";
    console.log(`PROBE SONUCU: ${outcome}`);
    await goHome();
  }
} finally {
  for (const other of session.context.pages()) {
    if (other !== page) await other.close().catch(() => {});
  }
  await page.goto("about:blank").catch(() => {});
  await session.detach().catch(() => {});
  await driver.stopBrowser(p.id).catch(() => {});
  store.db.close();
}
console.log(`== BITTI: ${name} -> ${outcome}`);
