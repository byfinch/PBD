import type { Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { sleep, randInt } from "../util/time.js";

/**
 * Oturum-içi trend ısınması (Detect kalıbı, sade port).
 *
 * Marka keyword'ünden ÖNCE, aynı oturumda: google.com aç → canlı "Trend olan
 * aramalar" listesini aç → rastgele bir trende GERÇEK tık → trend SERP'inde
 * kısa doğal davranış (kaydırma/bekleme). Trend listesi yoksa nötr havuzdan
 * bir sorguya düşer.
 *
 * Amaç: marka araması asla "soğuk" gitmesin — Google her oturumu önce sıradan
 * bir kullanıcı gibi görsün.
 */

const NAV_NOISE =
  /trend olan|trending searches|trends for you|koyu tema|ayarlar|gizlilik|şartlar|reklam|işletme|hakkında|oturum|giriş yap|images|haritalar|haberler|videolar|daha fazla|maps|news|shopping|finance|gmail|search labs|all\b/i;

/** Ana sayfadaki canlı trend adaylarını topla. */
async function listHomepageTrends(page: Page): Promise<string[]> {
  return page
    .evaluate((noiseSrc) => {
      const noise = new RegExp(noiseSrc, "i");
      const out: string[] = [];
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/search?"], a[href*="/search%3F"]'))) {
        const text = (a.textContent ?? "").trim();
        if (text.length < 4 || text.length > 60) continue;
        if (noise.test(text)) continue;
        if (!out.includes(text)) out.push(text);
        if (out.length >= 10) break;
      }
      return out;
    }, NAV_NOISE.source)
    .catch(() => [] as string[]);
}

export interface TrendWarmupResult {
  ok: boolean;
  trend: string;
  method: "live-trend" | "pool" | "none";
}

export async function sessionTrendWarmup(
  page: Page,
  config: AppConfig,
  opts: { isMobile?: boolean } = {}
): Promise<TrendWarmupResult> {
  const navTimeout = config.engine.navTimeoutMs;
  try {
    await page.goto(`https://www.google.com/?hl=tr&gl=tr`, { waitUntil: "domcontentloaded", timeout: navTimeout });
    await sleep(1_200 + Math.random() * 1_500);

    // Trend listesi çoğu zaman arama kutusuna odaklanınca açılır (desktop);
    // mobilde genelde zaten görünür.
    const box = page.locator('textarea[name="q"], input[name="q"]').first();
    if (await box.count()) {
      await box.click({ timeout: 4_000 }).catch(() => {});
      await sleep(900 + Math.random() * 900);
    }

    const trends = await listHomepageTrends(page);
    if (trends.length) {
      const trend = trends[randInt(0, trends.length - 1)]!;
      logger.info({ trend }, "session warm-up: live homepage trend");
      // Gerçek tık — link metniyle bul.
      const link = page.locator('a:has-text("' + trend.replace(/"/g, "") + '")').first();
      const navP = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: navTimeout }).catch(() => null);
      if (await link.count()) {
        await link.click({ timeout: 5_000 }).catch(() => {});
      } else {
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(trend)}&hl=tr&gl=tr`, {
          waitUntil: "domcontentloaded",
          timeout: navTimeout,
        });
      }
      await navP;
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      // Trend SERP'inde kısa doğal davranış: 1-2 kaydırma + bekleme.
      await sleep(randInt(3_000, 7_000));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5)).catch(() => {});
      await sleep(randInt(2_000, 5_000));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await sleep(randInt(2_000, 5_000));
      return { ok: true, trend, method: "live-trend" };
    }

    // Canlı trend yoksa nötr havuzdan bir sorgu.
    const pool = config.warmup.queries;
    if (pool.length) {
      const soft = pool[randInt(0, pool.length - 1)]!;
      logger.info({ soft }, "session warm-up: pool fallback");
      await page.goto(`https://www.google.com/search?q=${encodeURIComponent(soft)}&hl=tr&gl=tr`, {
        waitUntil: "domcontentloaded",
        timeout: navTimeout,
      });
      await sleep(randInt(4_000, 9_000));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6)).catch(() => {});
      await sleep(randInt(2_000, 4_000));
      return { ok: true, trend: soft, method: "pool" };
    }
    return { ok: false, trend: "", method: "none" };
  } catch (err) {
    logger.warn({ err: String(err) }, "session trend warm-up failed (non-fatal)");
    return { ok: false, trend: "", method: "none" };
  }
}
