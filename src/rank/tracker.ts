import type { AppConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { AntidetectClient, AntidetectProfile } from "../antidetect/client.js";
import { BrowserSession } from "../browser/session.js";
import { openSerp, parseOrganicResults, findTarget, prepareGoogleConsent, goToNextSerpPage } from "../serp/finder.js";
import { isRealSerp } from "../captcha/recovery.js";
import { dateKey } from "../calendar/ramp.js";
import { logger } from "../logger.js";

/**
 * Daily rank tracker.
 *
 * Measures the target domain's organic position for every configured keyword
 * WITHOUT clicking anything (pure observation pass) and appends to the
 * positions table. One profile is enough — positions do not depend on the
 * profile, only on locale/proxy, so a single clean profile keeps the IP budget
 * flat.
 */

export interface MeasurementResult {
  keyword: string;
  domain: string;
  position: number | null;
}

/** Measure all keywords once and persist. Returns per-keyword outcomes. */
export async function measureAllPositions(
  config: AppConfig,
  store: Store,
  antidetect: AntidetectClient,
  profile: AntidetectProfile,
  sites: Array<{ domain: string; keywords: string[] }>
): Promise<MeasurementResult[]> {
  const today = dateKey();
  const out: MeasurementResult[] = [];
  const ws = await antidetect.startBrowser(profile.id);
  const session = await BrowserSession.attach(ws);
  try {
    await prepareGoogleConsent(session);
    for (const site of sites) {
      for (const keyword of site.keywords) {
        let position: number | null = null;
        try {
          const ok = await openSerp(session.page, config, keyword);
          if (ok && (await isRealSerp(session.page))) {
            // Derin ölçüm: site tıklanabilir menzile yaklaşıyor mu görmek için
            // deepSearch.maxPages'e kadar sayfala (tıklama yok, sadece bakış).
            let pageNum = 1;
            let parsed = await parseOrganicResults(session.page);
            let hit = findTarget(parsed.results, site.domain);
            while (!hit && config.behavior.deepSearch.enabled && pageNum < config.behavior.deepSearch.maxPages) {
              const prevCount = parsed.results.length;
              const moved = await goToNextSerpPage(session.page, { navTimeoutMs: config.engine.navTimeoutMs });
              if (!moved) break;
              pageNum++;
              const re = await parseOrganicResults(session.page);
              if (re.empty) break;
              if (re.results.length <= prevCount) {
                for (const r of re.results) r.position = (pageNum - 1) * 10 + r.position;
              }
              parsed = re;
              hit = findTarget(parsed.results, site.domain);
            }
            position = hit?.position ?? null;
            logger.info({ keyword, domain: site.domain, position }, "rank measured");
          } else {
            logger.warn({ keyword }, "rank measurement: SERP blocked or empty — recording null");
          }
        } catch (err) {
          logger.warn({ keyword, err: String(err) }, "rank measurement failed");
        }
        store.insertPosition({ date: today, keyword, domain: site.domain, position, device: "desktop" });
        out.push({ keyword, domain: site.domain, position });
      }
    }
  } finally {
    await session.detach();
    await antidetect.stopBrowser(profile.id).catch((err) => {
      logger.warn({ err: String(err) }, "rank tracker: stopBrowser failed");
    });
  }
  return out;
}
