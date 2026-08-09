import type { Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import type { BrowserSession } from "../browser/session.js";
import { tapMobile } from "../browser/mobileEmulation.js";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";

/**
 * Organic SERP finder.
 *
 * Opens the keyword SERP, parses ALL organic results (never ads), and locates
 * the target domain with its position. This module deliberately knows nothing
 * about ad parsing — PBD's only ad-related logic is SKIPPING ad containers so
 * they never leak into organic positions.
 */

const CONSENT_ACCEPT_LABELS = ["Tümünü kabul et", "Tümünü Kabul Et", "Kabul et", "Accept all", "Kabul Et"];

export interface OrganicResult {
  /** 1-based position among ORGANIC results only (ads excluded). */
  position: number;
  url: string;
  domain: string;
  title: string;
  /**
   * Index into the page's organic-anchor list at parse time — used by
   * clickOrganicResult to re-locate the same anchor in the live DOM.
   */
  anchorIndex: number;
}

export interface SerpParseResult {
  results: OrganicResult[];
  /** True when the SERP markup did not look like a results page at all. */
  empty: boolean;
}

export function buildSerpUrl(config: AppConfig, keyword: string, start = 0): string {
  const u = new URL(`https://${config.google.domain}/search`);
  u.searchParams.set("q", keyword);
  u.searchParams.set("hl", config.google.hl);
  u.searchParams.set("gl", config.google.gl);
  u.searchParams.set("nfpr", "1");
  u.searchParams.set("filter", "0");
  u.searchParams.set("ie", "UTF-8");
  u.searchParams.set("oe", "UTF-8");
  // Personalisation off + consistent inputs across profiles.
  if (!("pws" in config.google.extraParams)) u.searchParams.set("pws", "0");
  for (const [k, v] of Object.entries(config.google.extraParams)) u.searchParams.set(k, v);
  if (config.google.num > 0) u.searchParams.set("num", String(config.google.num));
  if (config.google.uule) u.searchParams.set("uule", config.google.uule);
  if (start > 0) u.searchParams.set("start", String(start));
  return u.toString();
}

/** Pre-seed a consent cookie so google.com doesn't bounce us to consent.google.com. */
export async function prepareGoogleConsent(session: BrowserSession): Promise<void> {
  const domains = [".google.com", ".google.com.tr"];
  const cookies = domains.flatMap((domain) => [
    { name: "CONSENT", value: "YES+cb", domain, path: "/" },
    { name: "SOCS", value: "CAESHAgBEhIaAB", domain, path: "/" },
  ]);
  try {
    await session.context.addCookies(cookies);
  } catch (err) {
    logger.debug({ err: String(err) }, "could not pre-seed consent cookies (continuing)");
  }
}

export async function tryDismissConsent(page: Page): Promise<boolean> {
  if (!page.url().includes("consent.google.")) {
    // Some consent walls are inlined; check for the accept button anyway but don't force it.
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (!/devam etmeden önce|before you continue/i.test(bodyText)) return false;
  }
  for (const label of CONSENT_ACCEPT_LABELS) {
    try {
      const btn = page.getByRole("button", { name: label, exact: false }).first();
      if (await btn.count()) {
        await btn.click({ timeout: 5000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
        logger.info({ label }, "dismissed Google consent interstitial");
        return true;
      }
    } catch {
      /* try next label */
    }
  }
  return false;
}

/**
 * Parse every organic result on the current SERP.
 *
 * Organic anchor pattern: `#rso a[href^="http"]` wrapping an <h3>. Ad cards are
 * excluded by container: [data-text-ad], #tads/#tadsb/#tvcap, [data-pcu]
 * (shopping/pla) and Google-redirect wrappers (/url?q=, /aclk).
 */
export async function parseOrganicResults(page: Page): Promise<SerpParseResult> {
  const raw = await page
    .evaluate(() => {
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('#rso a[href^="http"]'));
      const out: Array<{ url: string; title: string; anchorIndex: number }> = [];
      let organicIndex = 0;
      for (const a of anchors) {
        // Must wrap a heading — that is the organic result title link.
        // Desktop uses <h3>; the mobile SERP uses role="heading"/aria-level divs.
        const headingEl = a.querySelector('h3, [role="heading"], [aria-level="3"]');
        if (!headingEl) continue;
        const href = a.href;
        if (!href || href.includes("google.")) {
          // Skip google-internal links (cached/translated variants).
          if (!href || /^https?:\/\/(www\.)?google\./i.test(href)) continue;
        }
        if (href.includes("/aclk") || href.includes("/url?")) continue;
        // Ad containers — never counted as organic.
        if (a.closest("[data-text-ad], #tads, #tadsb, #tvcap, [data-pcu]")) continue;
        const title = headingEl.textContent?.trim() ?? "";
        out.push({ url: href, title, anchorIndex: organicIndex });
        organicIndex += 1;
      }
      // Dedupe by URL (Google sometimes repeats the same link in a card).
      const seen = new Set<string>();
      const deduped = out.filter((r) => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });
      const empty = !document.querySelector("#rso, #search");
      return { results: deduped, empty };
    })
    .catch((err) => {
      logger.warn({ err: String(err) }, "organic SERP parse failed");
      return { results: [], empty: true };
    });

  const results: OrganicResult[] = raw.results.map((r, i) => {
    let domain = "";
    try {
      domain = new URL(r.url).hostname.replace(/^www\./, "");
    } catch {
      /* keep empty */
    }
    return { position: i + 1, url: r.url, domain, title: r.title, anchorIndex: r.anchorIndex };
  });
  return { results, empty: raw.empty };
}

/**
 * Find the target domain among organic results. Subdomains count
 * ("blog.example.com" matches target "example.com").
 */
export function findTarget(results: OrganicResult[], targetDomain: string): OrganicResult | null {
  const target = targetDomain.replace(/^www\./, "").toLowerCase();
  for (const r of results) {
    const d = r.domain.toLowerCase();
    if (d === target || d.endsWith("." + target)) return r;
  }
  return null;
}

/**
 * Click an organic result like a human: scroll it into view, small settle,
 * then click (mouse on desktop, tap on mobile). Returns the landing Page
 * (same tab; Google organic links navigate in place) or null if the
 * navigation never happened.
 */
export async function clickOrganicResult(
  page: Page,
  result: OrganicResult,
  opts: { isMobile?: boolean; navTimeoutMs?: number } = {}
): Promise<Page | null> {
  const navTimeout = opts.navTimeoutMs ?? 45_000;
  try {
    // Index yerine URL ile bul: parse'daki filtre seti ile locator seti birebir
    // ayni olmak zorunda degil; href eslesmesi her zaman dogru anchor'u verir.
    const handles = await page.$$('#rso a[href^="http"]');
    let handle = null;
    const wanted = result.url;
    for (const h of handles) {
      const href = await h.getAttribute("href");
      if (!href) continue;
      if (href === wanted || href.split("#")[0] === wanted.split("#")[0]) {
        handle = h;
        break;
      }
    }
    if (!handle) {
      // Gevşek fallback: ayni origin+path
      const base = wanted.split("?")[0] ?? wanted;
      for (const h of handles) {
        const href = (await h.getAttribute("href")) ?? "";
        if (base && href.split("?")[0] === base) {
          handle = h;
          break;
        }
      }
    }
    if (!handle) {
      logger.warn({ url: result.url }, "organic anchor not found by href");
      return null;
    }
    await handle.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
    await sleep(400 + Math.random() * 900);

    const box = await handle.boundingBox();
    if (!box) {
      logger.warn("organic anchor has no bounding box");
      return null;
    }
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height / 2;

    const navPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: navTimeout }).catch(() => null);
    if (opts.isMobile) {
      await tapMobile(page, x, y);
    } else {
      await page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 8) });
      await sleep(120 + Math.random() * 300);
      await page.mouse.click(x, y);
    }
    const nav = await navPromise;
    // Yeniden yönlendirme bildirimi (google.com/url?q=...): insan gibi
    // sayfadaki hedef bağlantıya tıkla.
    if (/google\.[^/]+\/url\?/i.test(page.url())) {
      const links = await page.$$('a[href^="http"]');
      for (const h of links) {
        const href = (await h.getAttribute("href")) ?? "";
        if (!href) continue;
        try {
          if (/google\./i.test(new URL(href).hostname)) continue;
        } catch {
          continue;
        }
        const nav2 = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: navTimeout }).catch(() => null);
        await h.click().catch(() => {});
        await nav2;
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        break;
      }
    }
    // google.com/amp/s/... = AMP viewer; /url? bildiriminden çıkamadıysak da — "landi" sayilmaz.
    const stillGoogle = (u: string) => /google\.[^/]+\/(search|amp\/s|url\?)/i.test(u);
    if (stillGoogle(page.url())) {
      logger.warn({ url: result.url, landed: page.url() }, "click did not leave Google (SERP or AMP viewer)");
      return null;
    }
    if (!nav && !page.url().startsWith(result.url.split("?")[0] ?? result.url)) {
      if (/google\.[^/]+\/search/i.test(page.url())) {
        logger.warn({ url: result.url }, "click did not leave the SERP");
        return null;
      }
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    return page;
  } catch (err) {
    logger.warn({ err: String(err) }, "organic result click failed");
    return null;
  }
}

/**
 * Convenience: navigate to the keyword SERP and wait for result markup.
 * Consent handling is the caller's job (engine does it once per session);
 * captcha detection/recovery is also the caller's job.
 */
export async function openSerp(page: Page, config: AppConfig, keyword: string): Promise<boolean> {
  const url = buildSerpUrl(config, keyword);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.engine.navTimeoutMs });
  await tryDismissConsent(page);
  const found = await page
    .waitForSelector("#search, #rso, #main, #center_col", { timeout: 12_000 })
    .then(() => true)
    .catch(() => false);
  // Let lazy result blocks settle before parsing.
  await sleep(800 + Math.random() * 1200);
  return found;
}

/**
 * Human-like SERP pagination: scroll to the bottom, then click the "next"
 * (desktop: a#pnnext) or "more results" (mobile append) control. Returns true
 * when the SERP grew/moved — the caller re-parses. A false return means there
 * is no next page (end of results).
 */
export async function goToNextSerpPage(
  page: Page,
  opts: { isMobile?: boolean; navTimeoutMs?: number } = {}
): Promise<boolean> {
  try {
    // Okur gibi: önce yarıya, sonra dibe kaydır.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.7)).catch(() => {});
    await sleep(700 + Math.random() * 900);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(900 + Math.random() * 1200);

    const before = page.url();
    let btn = page.locator("a#pnnext").first();
    if ((await btn.count()) === 0) {
      btn = page
        .locator(
          'a:has-text("Sonraki"), a:has-text("Next"), a:has-text("Daha fazla sonuç"), a:has-text("More results"), [role="button"]:has-text("Daha fazla")'
        )
        .first();
    }
    if ((await btn.count()) === 0) return false;

    await btn.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await sleep(400 + Math.random() * 700);
    const navP = page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: opts.navTimeoutMs ?? 30_000 })
      .catch(() => null);
    await btn.click({ timeout: 5_000 }).catch(() => {});
    await navP;
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await sleep(800 + Math.random() * 1200);
    if (page.url() !== before) return true; // desktop: yeni sayfa
    // mobil "daha fazla sonuç": navigasyon yok, liste uzar
    await page.waitForSelector("#rso", { timeout: 8_000 }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
