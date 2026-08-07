import type { Page } from "playwright-core";
import type { BehaviorConfig } from "../util/persona.js";
import { tapMobile } from "../browser/mobileEmulation.js";
import { logger } from "../logger.js";
import { randInt, sleep } from "../util/time.js";

/**
 * On-site behaviour engine.
 *
 * Runs a configurable, persona-shaped behaviour set on the target site after
 * the organic click: dwell, percent-based scrolling, mouse wander, internal
 * link clicks, and an optional rival-comparison step on the SERP beforehand.
 * All timings are ranges — nothing here is a metronome.
 */

export interface SiteVisitOutcome {
  /** Total time spent on the target site (ms). */
  dwellMs: number;
  /** Internal (same-domain) links followed. */
  internalClicks: number;
  /** Pages touched on the target site (landing + internal). */
  pagesTouched: number;
}

function sameDomain(rawUrl: string, targetDomain: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    const target = targetDomain.replace(/^www\./, "").toLowerCase();
    return host === target || host.endsWith("." + target);
  } catch {
    return false;
  }
}

/** Smooth-ish scroll to a percentage of the document height. */
async function scrollToPercent(page: Page, pct: number, isMobile: boolean): Promise<void> {
  await page
    .evaluate(
      ({ pct }) => {
        const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const target = Math.floor(max * pct);
        const start = window.scrollY;
        const steps = 12 + Math.floor(Math.random() * 10);
        let i = 0;
        const tick = () => {
          i += 1;
          const t = i / steps;
          // ease-out so the motion does not look linear-robotic
          const y = start + (target - start) * (1 - Math.pow(1 - t, 2));
          window.scrollTo(0, y);
          if (i < steps) setTimeout(tick, 40 + Math.random() * 80);
        };
        tick();
      },
      { pct }
    )
    .catch(() => {});
  // Let the in-page animation finish.
  await sleep(isMobile ? randInt(700, 1400) : randInt(500, 1100));
}

async function mouseWander(page: Page, chance: number): Promise<void> {
  if (Math.random() > chance) return;
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const moves = randInt(2, 5);
  let x = randInt(100, viewport.width - 100);
  let y = randInt(100, viewport.height - 100);
  for (let i = 0; i < moves; i++) {
    x = Math.max(20, Math.min(viewport.width - 20, x + randInt(-250, 250)));
    y = Math.max(20, Math.min(viewport.height - 20, y + randInt(-180, 180)));
    await page.mouse.move(x, y, { steps: randInt(5, 14) }).catch(() => {});
    await sleep(randInt(150, 600));
  }
}

/** Collect same-domain anchors worth following (visible, http, not a hash link). */
async function pickInternalLink(page: Page, targetDomain: string): Promise<number> {
  return page
    .evaluate(() => {
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
      const current = location.href.split("#")[0];
      let eligible = 0;
      const chosen = (window as unknown as { __pbdPick?: number });
      const candidates: number[] = [];
      anchors.forEach((a, idx) => {
        const href = a.href;
        if (!href || !/^https?:/i.test(href)) return;
        if (href.split("#")[0] === current) return;
        const rect = a.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return;
        candidates.push(idx);
      });
      eligible = candidates.length;
      if (candidates.length) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
        chosen.__pbdPick = pick;
        // Mark the chosen anchor so the caller can re-locate it by attribute.
        anchors[pick]!.setAttribute("data-pbd-internal", "1");
      }
      return eligible;
    })
    .catch(() => 0);
}

async function clickMarkedInternalLink(
  page: Page,
  targetDomain: string,
  isMobile: boolean,
  navTimeoutMs: number
): Promise<boolean> {
  try {
    const anchor = page.locator("a[data-pbd-internal='1']").first();
    if ((await anchor.count()) === 0) return false;
    const href = await anchor.getAttribute("href");
    await anchor.scrollIntoViewIfNeeded({ timeout: 6_000 }).catch(() => {});
    await sleep(randInt(400, 1100));
    const box = await anchor.boundingBox();
    if (!box) return false;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const navPromise = page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: navTimeoutMs })
      .catch(() => null);
    if (isMobile) await tapMobile(page, x, y);
    else await page.mouse.click(x, y);
    await navPromise;
    await page.evaluate(() => {
      document.querySelector("a[data-pbd-internal='1']")?.removeAttribute("data-pbd-internal");
    }).catch(() => {});
    // Confirm we actually landed on the same domain (not an external jump).
    if (href && sameDomain(page.url(), targetDomain)) return true;
    return sameDomain(page.url(), targetDomain);
  } catch (err) {
    logger.debug({ err: String(err) }, "internal link click failed");
    return false;
  }
}

/**
 * Dwell on the current page: scroll waypoints (percent-based), mouse wander,
 * reading pauses. Returns ms actually spent.
 */
export async function dwellOnPage(
  page: Page,
  behavior: BehaviorConfig,
  opts: { isMobile?: boolean; budgetMs?: { min: number; max: number } } = {}
): Promise<number> {
  const started = Date.now();
  const min = opts.budgetMs?.min ?? behavior.dwellMinMs;
  const max = opts.budgetMs?.max ?? behavior.dwellMaxMs;
  const budget = randInt(min, Math.max(min, max));
  const waypoints = [...behavior.scrollWaypoints].sort((a, b) => a - b);

  // Initial "reading the top" pause.
  await sleep(randInt(1200, 3200));

  for (const wp of waypoints) {
    if (Date.now() - started >= budget) break;
    if (Math.random() > behavior.scrollReachChance) continue;
    await scrollToPercent(page, wp, !!opts.isMobile);
    if (!opts.isMobile) await mouseWander(page, behavior.mouseMoveChance);
    // Reading pause at each waypoint.
    await sleep(randInt(1500, 4500));
  }

  // Top off the remaining budget with idle dwell (user reading the end).
  const remaining = budget - (Date.now() - started);
  if (remaining > 0) {
    // Occasionally scroll back up a little, like a re-read.
    if (Math.random() < 0.35) {
      await scrollToPercent(page, 0.1 + Math.random() * 0.3, !!opts.isMobile);
    }
    await sleep(Math.max(0, remaining - 500));
  }
  return Date.now() - started;
}

/**
 * Full behaviour set on the target site after the organic click.
 *
 * Steps: landing dwell → internal link walk (chance-based, same domain only,
 * max N) with per-page dwell → exit per behavior.exitMode ("internal" forces
 * at least one internal hop when the walk did not happen).
 */
export async function runSiteVisit(
  page: Page,
  behavior: BehaviorConfig,
  targetDomain: string,
  opts: { isMobile?: boolean; navTimeoutMs?: number } = {}
): Promise<SiteVisitOutcome> {
  const navTimeout = opts.navTimeoutMs ?? 30_000;
  let dwellMs = 0;
  let internalClicks = 0;
  let pagesTouched = 1;

  dwellMs += await dwellOnPage(page, behavior, { isMobile: opts.isMobile });

  const il = behavior.internalLinks;
  const wantInternal =
    il.enabled && il.maxClicks > 0 && (Math.random() < il.chance || behavior.exitMode === "internal");

  if (wantInternal) {
    const maxClicks = Math.max(1, Math.min(il.maxClicks, randInt(1, il.maxClicks || 1)));
    for (let i = 0; i < maxClicks; i++) {
      const eligible = await pickInternalLink(page, targetDomain);
      if (eligible === 0) break;
      const ok = await clickMarkedInternalLink(page, targetDomain, !!opts.isMobile, navTimeout);
      if (!ok) break;
      internalClicks += 1;
      pagesTouched += 1;
      dwellMs += await dwellOnPage(page, behavior, {
        isMobile: opts.isMobile,
        budgetMs: { min: il.minStayMs, max: il.maxStayMs },
      });
      // exitMode "close": stop the walk early sometimes (natural bounce-out).
      if (behavior.exitMode === "close" && Math.random() < 0.4) break;
    }
  }

  return { dwellMs, internalClicks, pagesTouched };
}

/**
 * Rival comparison: before clicking the target, briefly open a competing
 * organic result and come back — a comparison-shopper signal. Best effort:
 * any failure just skips the step (the SERP must stay usable for the target
 * click).
 */
export async function rivalCompareStep(
  serpPage: Page,
  rival: { url: string; domain: string; anchorIndex: number },
  behavior: BehaviorConfig,
  opts: { isMobile?: boolean; navTimeoutMs?: number }
): Promise<void> {
  if (!behavior.rivalCompare.enabled) return;
  if (Math.random() > behavior.rivalCompare.chance) return;
  const { clickOrganicResult } = await import("../serp/finder.js");
  logger.info({ rival: rival.domain }, "rival compare: opening competitor result first");
  const landed = await clickOrganicResult(serpPage, { position: 0, ...rival, title: "" }, opts);
  if (!landed) return;
  await dwellOnPage(serpPage, behavior, {
    isMobile: opts.isMobile,
    budgetMs: { min: behavior.rivalCompare.minStayMs, max: behavior.rivalCompare.maxStayMs },
  });
  await serpPage.goBack({ waitUntil: "domcontentloaded", timeout: opts.navTimeoutMs ?? 30_000 }).catch(() => {});
  await sleep(randInt(800, 1800));
}
