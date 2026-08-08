import type { AppConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { AntidetectClient, AntidetectProfile } from "../antidetect/client.js";
import { BrowserSession } from "../browser/session.js";
import { applyMobileEmulation } from "../browser/mobileEmulation.js";
import { prepareGoogleConsent, openSerp, parseOrganicResults, clickOrganicResult } from "../serp/finder.js";
import { pageLooksLikeCaptcha, recoverFromSorry } from "../captcha/recovery.js";
import { SolverPolicy } from "../captcha/policy.js";
import { behaviorForProfile } from "../util/persona.js";
import { runSiteVisit } from "../behavior/siteVisit.js";
import { dateKey } from "../calendar/ramp.js";
import { logActivity, type EngineDeps } from "../engine.js";
import { logger } from "../logger.js";
import { jitterDelay, randInt, sleep } from "../util/time.js";

/**
 * Isınma ziyareti: hedef siteden BAĞIMSIZ, nötr bir sorgu + rastgele organik
 * tık + doğal gezinme. Amaç IP/profil güveni inşası ve rehabilitasyonu.
 *
 * Hedefli ziyaretlerden önce günlük kota kadar koşar (engine.tick karar verir).
 * Nötr sorgudaki captcha çözümü bile güvene yazar; duvar kalırsa profil
 * standart cooldown'a girer.
 */

function pickQuery(config: AppConfig, profileName: string): string {
  const pool = config.warmup.queries;
  const seed = [...(profileName + dateKey())].reduce((a, c) => a + c.charCodeAt(0), 0);
  return pool[seed % pool.length] ?? "haberler";
}

export async function runWarmupVisit(deps: EngineDeps, profile: AntidetectProfile, mobile: boolean): Promise<void> {
  const { config, store, antidetect } = deps;
  const query = pickQuery(config, profile.name || profile.id);
  const today = dateKey();
  const visitId = store.startVisit({
    date: today,
    profileId: profile.id,
    profileName: profile.name,
    siteDomain: "(isinma)",
    keyword: query,
  });

  const policy = new SolverPolicy(store, config.solver);
  const personaBehavior = behaviorForProfile(config.behavior, profile.name || profile.id);

  let session: BrowserSession | null = null;
  let browserStarted = false;
  try {
    await jitterDelay(config.engine.visitJitterMinMs, config.engine.visitJitterMaxMs);
    logActivity(`[${profile.name}] ısınma: "${query}"`);
    const ws = await antidetect.startBrowser(profile.id);
    browserStarted = true;
    session = await BrowserSession.attach(ws);
    const page = session.page;

    if (mobile) await applyMobileEmulation(page);
    await prepareGoogleConsent(session);

    const serpReady = await openSerp(page, config, query).catch(() => false);
    if (!serpReady || (await pageLooksLikeCaptcha(page))) {
      const recovery = await recoverFromSorry(page, config, profile, store.ipTrust, policy);
      if (!recovery.cleared) {
        store.finishVisit(visitId, { status: "captcha", error: recovery.reason ?? "captcha wall" });
        return;
      }
      await openSerp(page, config, query).catch(() => {});
      if (await pageLooksLikeCaptcha(page)) {
        store.ipTrust.markSolverFailed(profile.id, "hard re-wall (warmup)", { maxCooldownMinutes: 60 });
        store.finishVisit(visitId, { status: "captcha", error: "hard re-wall after solve" });
        return;
      }
    }

    const parsed = await parseOrganicResults(page);
    if (parsed.empty || !parsed.results.length) {
      store.finishVisit(visitId, { status: "error", error: "SERP markup not recognised" });
      return;
    }

    // İnsan gibi: ilk 3 sonuçtan birini seç (haber/ansiklopedi fark etmez).
    const pick = parsed.results[randInt(0, Math.min(2, parsed.results.length - 1))]!;
    await sleep(randInt(2_000, 6_000));
    const landed = await clickOrganicResult(page, pick, {
      isMobile: mobile,
      navTimeoutMs: config.engine.navTimeoutMs,
    });
    if (!landed) {
      store.finishVisit(visitId, { status: "error", position: pick.position, error: "organic click failed" });
      return;
    }

    const visit = await runSiteVisit(landed, personaBehavior, pick.domain, {
      isMobile: mobile,
      navTimeoutMs: config.engine.navTimeoutMs,
    });
    store.finishVisit(visitId, {
      status: "visited",
      position: pick.position,
      dwellMs: visit.dwellMs,
      internalClicks: visit.internalClicks,
    });
    store.ipTrust.markClean(profile.id);
    logActivity(`[${profile.name}] ısınma TAMAM — "${query}" → ${pick.domain} (${Math.round(visit.dwellMs / 1000)}sn)`);
  } catch (err) {
    const errMsg = (err instanceof Error ? err.message : String(err)) || "unknown";
    logger.warn({ err: errMsg, profile: profile.name }, "warmup visit failed");
    store.finishVisit(visitId, { status: "error", error: errMsg });
  } finally {
    if (session) await session.detach();
    if (browserStarted) await antidetect.stopBrowser(profile.id).catch(() => {});
  }
}
