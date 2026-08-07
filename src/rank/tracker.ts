import type { AppConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { AntidetectClient, AntidetectProfile } from "../antidetect/client.js";
import { BrowserSession } from "../browser/session.js";
import { openSerp, parseOrganicResults, findTarget, prepareGoogleConsent } from "../serp/finder.js";
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
  profile: AntidetectProfile
): Promise<MeasurementResult[]> {
  const today = dateKey();
  const out: MeasurementResult[] = [];
  const ws = await antidetect.startBrowser(profile.id);
  const session = await BrowserSession.attach(ws);
  try {
    await prepareGoogleConsent(session);
    for (const site of config.sites) {
      for (const keyword of site.keywords) {
        let position: number | null = null;
        try {
          const ok = await openSerp(session.page, config, keyword);
          if (ok && (await isRealSerp(session.page))) {
            const parsed = await parseOrganicResults(session.page);
            const hit = findTarget(parsed.results, site.domain);
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
