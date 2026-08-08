import { mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import type { AppConfig } from "./config.js";
import type { Store } from "./store/db.js";
import type { AntidetectClient, AntidetectProfile } from "./antidetect/client.js";
import { selectProfiles } from "./antidetect/client.js";
import { BrowserSession } from "./browser/session.js";
import { applyMobileEmulation } from "./browser/mobileEmulation.js";
import { prepareGoogleConsent, openSerp, parseOrganicResults, findTarget, clickOrganicResult } from "./serp/finder.js";
import { pageLooksLikeCaptcha, recoverFromSorry } from "./captcha/recovery.js";
import { SolverPolicy } from "./captcha/policy.js";
import { behaviorForProfile } from "./util/persona.js";
import { runSiteVisit, rivalCompareStep } from "./behavior/siteVisit.js";
import { dateKey, rampStartDate, todaysPlan, quotaForDay, dayIndexFor, type PlannedVisit } from "./calendar/ramp.js";
import { isInCooldown } from "./store/ipTrust.js";
import { logger } from "./logger.js";
import { jitterDelay, randInt, sleep } from "./util/time.js";

// ── live activity feed (panel "şu an ne oluyor" terminali) ─────────────────

export interface ActivityEvent {
  ts: string;
  text: string;
}

const activityRing: ActivityEvent[] = [];
const ACTIVITY_MAX = 150;

export function logActivity(text: string): void {
  activityRing.push({ ts: new Date().toISOString(), text });
  if (activityRing.length > ACTIVITY_MAX) activityRing.splice(0, activityRing.length - ACTIVITY_MAX);
  logger.info(text);
}

export function recentActivity(): ActivityEvent[] {
  return [...activityRing];
}

// ── evidence snapshots ─────────────────────────────────────────────────────

function evidenceDir(config: AppConfig): string {
  const dir = resolve(config.output.dir, "evidence");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** JPEG screenshot, best-effort — evidence must never crash a visit. */
async function snap(page: Page, config: AppConfig, visitId: number, kind: "serp" | "land" | "fail"): Promise<string> {
  try {
    const name = `${visitId}-${kind}.jpg`;
    await page.screenshot({ path: resolve(evidenceDir(config), name), type: "jpeg", quality: 55 });
    return name;
  } catch (err) {
    logger.warn({ err: String(err), kind }, "evidence screenshot failed");
    return "";
  }
}

/**
 * Main engine: reads the ramp plan, runs due visits on antidetect profiles.
 *
 * One visit = open profile → consent → keyword SERP → (captcha recovery if
 * walled) → find target in organic results → click → on-site behaviour set →
 * close. Target absent from the SERP = "missed" record (no click, no retry
 * storm — the rank tracker will keep watching it).
 *
 * Guards: per-IP daily cap, visit jitter, IP-trust vault cooldowns, and a
 * hard concurrency cap (small VPS: 1-2 browsers).
 */

export interface EngineDeps {
  config: AppConfig;
  store: Store;
  antidetect: AntidetectClient;
}

export interface EngineStatus {
  running: boolean;
  enabled: boolean;
  driver: string;
  date: string;
  rampDay: number;
  todayQuota: number;
  planned: number;
  completed: number;
  visitsToday: number;
  activeBrowsers: number;
  profiles: number;
}

function isMobileProfile(p: AntidetectProfile): boolean {
  return /mobile|android|iphone/i.test(p.name);
}

/**
 * Run one planned visit end-to-end. Shared by the engine loop and the
 * `visit --once` CLI command. Never throws — the outcome lands in the DB.
 */
export async function runVisitOnce(deps: EngineDeps, item: PlannedVisit, profile: AntidetectProfile): Promise<void> {
  const { config, store, antidetect } = deps;
  const today = dateKey();
  const visitId = store.startVisit({
    date: today,
    profileId: profile.id,
    profileName: profile.name,
    siteDomain: item.targetDomain,
    keyword: item.keyword,
  });

  const policy = new SolverPolicy(store, config.solver);
  const mobile = isMobileProfile(profile);
  const personaBehavior = behaviorForProfile(config.behavior, profile.name || profile.id);

  let session: BrowserSession | null = null;
  let browserStarted = false;
  const ev: { serpShot?: string; landShot?: string; failShot?: string; landedUrl?: string } = {};
  try {
    // Pre-visit jitter: nothing starts on a clock edge.
    await jitterDelay(config.engine.visitJitterMinMs, config.engine.visitJitterMaxMs);

    logActivity(`[${profile.name}] ziyaret başladı — "${item.keyword}" → ${item.targetDomain}`);
    const ws = await antidetect.startBrowser(profile.id);
    browserStarted = true;
    session = await BrowserSession.attach(ws);
    const page = session.page;

    if (mobile) await applyMobileEmulation(page);
    await prepareGoogleConsent(session);

    const serpReady = await openSerp(page, config, item.keyword).catch((err) => {
      logger.warn({ err: String(err) }, "SERP navigation failed");
      return false;
    });

    if (!serpReady || (await pageLooksLikeCaptcha(page))) {
      ev.failShot = await snap(page, config, visitId, "fail");
      store.setVisitEvidence(visitId, ev);
      logActivity(`[${profile.name}] captcha duvarı — solver devrede`);
      const recovery = await recoverFromSorry(page, config, profile, store.ipTrust, policy);
      if (!recovery.cleared) {
        logActivity(`[${profile.name}] captcha çözülemedi: ${recovery.reason ?? "duvar"}`);
        store.finishVisit(visitId, { status: "captcha", error: recovery.reason ?? "captcha wall" });
        return;
      }
      logActivity(`[${profile.name}] captcha çözüldü, SERP yenileniyor`);
      // Recovered — reload the keyword SERP for a clean parse.
      await openSerp(page, config, item.keyword).catch(() => {});
    }

    if (!(await pageLooksLikeCaptcha(page))) {
      store.ipTrust.markClean(profile.id);
    }

    const parsed = await parseOrganicResults(page);
    if (parsed.empty) {
      ev.failShot = await snap(page, config, visitId, "fail");
      store.setVisitEvidence(visitId, ev);
      store.finishVisit(visitId, { status: "error", error: "SERP markup not recognised" });
      return;
    }

    // SERP kanıtı her durumda (hit ya da miss) — hedefin göründüğü/görünmediği an.
    ev.serpShot = await snap(page, config, visitId, "serp");
    store.setVisitEvidence(visitId, ev);

    const target = findTarget(parsed.results, item.targetDomain);
    if (!target) {
      logActivity(`[${profile.name}] hedef SERP'te yok — miss ("${item.keyword}" / ${item.targetDomain})`);
      store.finishVisit(visitId, { status: "missed" });
      // The miss still told us the SERP state — keep it as a rank observation.
      store.insertPosition({ date: today, keyword: item.keyword, domain: item.targetDomain, position: null, device: mobile ? "mobile" : "desktop" });
      return;
    }

    // Optional comparison-shopper step: open a rival result first, come back.
    if (config.behavior.rivalCompare.enabled) {
      const rival = parsed.results.find((r) => r.domain !== target.domain && r.position < target.position);
      if (rival) {
        await rivalCompareStep(page, rival, personaBehavior, {
          isMobile: mobile,
          navTimeoutMs: config.engine.navTimeoutMs,
        });
        // After going back the anchors may have shifted — re-parse for safety.
        const reparsed = await parseOrganicResults(page);
        const reHit = findTarget(reparsed.results, item.targetDomain);
        if (reHit) target.anchorIndex = reHit.anchorIndex;
      }
    }

    // Human-ish pause on the SERP before clicking (reading the snippet).
    await sleep(randInt(2_000, 6_000));

    const landed = await clickOrganicResult(page, target, {
      isMobile: mobile,
      navTimeoutMs: config.engine.navTimeoutMs,
    });
    if (!landed) {
      ev.failShot = await snap(page, config, visitId, "fail");
      store.setVisitEvidence(visitId, ev);
      store.finishVisit(visitId, { status: "error", position: target.position, error: "organic click failed" });
      return;
    }

    logActivity(`[${profile.name}] tıklandı (poz ${target.position}) — site davranışı çalışıyor`);
    const visit = await runSiteVisit(landed, personaBehavior, item.targetDomain, {
      isMobile: mobile,
      navTimeoutMs: config.engine.navTimeoutMs,
    });

    // Varış kanıtı: son URL (yönlendirme zincirinin ucu) + sayfa görüntüsü.
    ev.landedUrl = landed.url();
    ev.landShot = await snap(landed, config, visitId, "land");
    store.setVisitEvidence(visitId, ev);

    store.finishVisit(visitId, {
      status: "visited",
      position: target.position,
      dwellMs: visit.dwellMs,
      internalClicks: visit.internalClicks,
    });
    store.insertPosition({
      date: today,
      keyword: item.keyword,
      domain: item.targetDomain,
      position: target.position,
      device: mobile ? "mobile" : "desktop",
    });
    logActivity(
      `[${profile.name}] ZİYARET TAMAM — "${item.keyword}" poz ${target.position}, ${Math.round(visit.dwellMs / 1000)}sn kalma, ${visit.internalClicks} iç tık → ${ev.landedUrl.slice(0, 80)}`
    );
  } catch (err) {
    logger.warn({ err: String(err), profile: profile.name }, "visit failed");
    if (session) {
      ev.failShot = await snap(session.page, config, visitId, "fail");
      store.setVisitEvidence(visitId, ev);
    }
    logActivity(`[${profile.name}] HATA: ${String(err).slice(0, 120)}`);
    store.finishVisit(visitId, { status: "error", error: String(err) });
  } finally {
    if (session) await session.detach();
    if (browserStarted) {
      await antidetect.stopBrowser(profile.id).catch((err) => {
        logger.warn({ err: String(err) }, "stopBrowser failed");
      });
    }
  }
}

export class Engine {
  private timer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private profiles: AntidetectProfile[] = [];
  private startDate = "";
  private running = false;
  private active = 0;
  /** Plan items already attempted today: `${profileId}|${keyword}|${hour}`. */
  private readonly doneKeys = new Set<string>();
  private readonly inFlight = new Set<string>();
  private doneDate = "";

  constructor(private readonly deps: EngineDeps) {}

  /** Panel endpoints sometimes need the driver (manual track pass). */
  get antidetectClient(): AntidetectClient {
    return this.deps.antidetect;
  }

  async init(): Promise<void> {
    const { config, store, antidetect } = this.deps;
    // DB is the source of truth for sites once the panel manages them; config
    // only seeds an empty DB (so panel deletions are never resurrected).
    if (!store.listSites().length) store.syncSites(config.sites);
    this.startDate = rampStartDate(store, config);
    const all = await antidetect.listProfiles().catch((err) => {
      logger.warn({ err: String(err) }, "antidetect listProfiles failed — engine will retry each tick");
      return [] as AntidetectProfile[];
    });
    this.profiles = selectProfiles(all, config);
    // Seed the vault with the pool so the panel shows every profile.
    for (const p of this.profiles) {
      store.ipTrust.upsertMeta({
        profileId: p.id,
        name: p.name,
        device: isMobileProfile(p) ? "mobile" : "desktop",
        proxyHost: p.proxy?.host ?? "",
      });
    }
    this.cleanupEvidence();
    this.cleanupTimer = setInterval(() => this.cleanupEvidence(), 6 * 3600 * 1000);
    logger.info(
      { profiles: this.profiles.length, startDate: this.startDate, driver: antidetect.driver },
      "engine initialised"
    );
  }

  /** Delete evidence files older than the retention window (disk hygiene). */
  private cleanupEvidence(): void {
    const { config, store } = this.deps;
    const days = config.panel.evidenceRetentionDays;
    const stale = store.oldEvidence(days);
    if (!stale.length) return;
    const dir = resolve(config.output.dir, "evidence");
    let freed = 0;
    for (const row of stale) {
      for (const name of [row.serpShot, row.landShot, row.failShot]) {
        if (!name) continue;
        try {
          unlinkSync(resolve(dir, name));
          freed++;
        } catch {
          /* already gone */
        }
      }
    }
    store.clearEvidencePaths(stale.map((r) => r.id));
    logger.info({ rows: stale.length, files: freed, retentionDays: days }, "evidence cleanup done");
  }

  /** Sites the engine works on: panel-managed DB rows win, config is fallback. */
  private effectiveSites(): Array<{ domain: string; keywords: string[]; weight: number }> {
    const dbSites = this.deps.store.listSites();
    if (dbSites.length) return dbSites.map((s) => ({ domain: s.domain, keywords: s.keywords, weight: s.weight }));
    return this.deps.config.sites;
  }

  private effectiveConfig(): AppConfig {
    return { ...this.deps.config, sites: this.effectiveSites() };
  }

  /** Persisted on/off — the panel toggle; default is OFF. */
  isEnabled(): boolean {
    return this.deps.store.getMeta("engine_enabled") === "1";
  }

  setEnabled(enabled: boolean): void {
    this.deps.store.setMeta("engine_enabled", enabled ? "1" : "0");
    if (enabled) this.start();
    else this.stop();
    logActivity(enabled ? ">> motor BAŞLATILDI (panel)" : ">> motor DURDURULDU (panel)");
  }

  /**
   * Manual run from the panel: schedule visits for one site (one keyword or
   * all), right now, still under caps/cooldown/concurrency guards.
   */
  runNow(domain: string, keyword?: string): number {
    const site = this.effectiveSites().find((s) => s.domain === domain);
    if (!site) return 0;
    const keywords = keyword ? [keyword] : site.keywords;
    const { config, store } = this.deps;
    const today = dateKey();
    let scheduled = 0;

    for (const kw of keywords) {
      const profile = this.profiles
        .filter((p) => {
          const trust = store.ipTrust.get(p.id);
          if (trust && isInCooldown(trust)) return false;
          return store.countVisitsToday(p.id, today) < config.ramp.perIpDailyCap;
        })
        // Least-used eligible profile first.
        .sort((a, b) => store.countVisitsToday(a.id, today) - store.countVisitsToday(b.id, today))[0];
      if (!profile) break;

      const key = `manual|${profile.id}|${kw}|${Date.now()}`;
      this.inFlight.add(key);
      this.active += 1;
      scheduled++;
      logActivity(`>> manuel tetik: ${domain} / "${kw}" → ${profile.name}`);
      void runVisitOnce(this.deps, {
        profileId: profile.id,
        profileName: profile.name,
        keyword: kw,
        targetDomain: domain,
        scheduledHour: new Date().getHours(),
      }, profile)
        .catch((err) => logger.warn({ err: String(err) }, "manual visit crashed"))
        .finally(() => {
          this.inFlight.delete(key);
          this.active -= 1;
        });
      // One visit per keyword per manual trigger is enough signal.
    }
    return scheduled;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tickMs = this.deps.config.engine.tickSeconds * 1000;
    this.timer = setInterval(() => void this.tickSafe(), tickMs);
    void this.tickSafe();
    logger.info({ tickSeconds: this.deps.config.engine.tickSeconds }, "engine started");
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  status(): EngineStatus {
    const { config, store } = this.deps;
    const today = dateKey();
    const plan = this.currentPlan();
    const dayIndex = this.startDate ? dayIndexFor(today, this.startDate) : 1;
    return {
      running: this.running,
      enabled: this.isEnabled(),
      driver: this.deps.antidetect.driver,
      date: today,
      rampDay: dayIndex,
      todayQuota: quotaForDay(dayIndex, this.effectiveConfig()),
      planned: plan.length,
      completed: this.doneKeys.size,
      visitsToday: store.countVisitsForDate(today),
      activeBrowsers: this.active,
      profiles: this.profiles.length,
    };
  }

  todayPlan(): PlannedVisit[] {
    return this.currentPlan();
  }

  planDone(key: string): boolean {
    return this.doneKeys.has(key);
  }

  static planKey(item: PlannedVisit): string {
    return `${item.profileId}|${item.keyword}|${item.scheduledHour}`;
  }

  private currentPlan(): PlannedVisit[] {
    if (!this.profiles.length || !this.startDate) return [];
    return todaysPlan(dateKey(), this.profiles, this.effectiveConfig(), this.startDate);
  }

  private async tickSafe(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      logger.warn({ err: String(err) }, "engine tick failed");
    }
  }

  private async tick(): Promise<void> {
    const { config, store } = this.deps;
    const today = dateKey();
    if (this.doneDate !== today) {
      // New day: reset the in-memory completion set (DB keeps the history).
      this.doneKeys.clear();
      this.doneDate = today;
    }

    // Profiles may appear after boot (antidetect app was down) — refresh lazily.
    if (!this.profiles.length) {
      const all = await this.deps.antidetect.listProfiles().catch(() => [] as AntidetectProfile[]);
      this.profiles = selectProfiles(all, config);
      if (!this.profiles.length) return;
    }

    const plan = this.currentPlan();
    const nowHour = new Date().getHours();

    for (const item of plan) {
      if (this.active >= config.engine.concurrency) break;
      const key = Engine.planKey(item);
      if (this.doneKeys.has(key) || this.inFlight.has(key)) continue;
      if (item.scheduledHour > nowHour) continue;

      const profile = this.profiles.find((p) => p.id === item.profileId);
      if (!profile) {
        this.doneKeys.add(key);
        continue;
      }

      // Per-IP / per-profile daily cap (counts real attempts from the DB, so it
      // survives restarts).
      if (store.countVisitsToday(profile.id, today) >= config.ramp.perIpDailyCap) {
        this.doneKeys.add(key);
        continue;
      }

      // Vault: cooling profiles rest until next_retry_at.
      const trust = store.ipTrust.get(profile.id);
      if (trust && isInCooldown(trust)) {
        this.doneKeys.add(key);
        continue;
      }

      this.inFlight.add(key);
      this.active += 1;
      void runVisitOnce(this.deps, item, profile)
        .catch((err) => logger.warn({ err: String(err) }, "visit task crashed"))
        .finally(() => {
          this.inFlight.delete(key);
          this.doneKeys.add(key);
          this.active -= 1;
        });
    }
  }
}
