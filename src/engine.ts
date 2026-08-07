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
  try {
    // Pre-visit jitter: nothing starts on a clock edge.
    await jitterDelay(config.engine.visitJitterMinMs, config.engine.visitJitterMaxMs);

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
      const recovery = await recoverFromSorry(page, config, profile, store.ipTrust, policy);
      if (!recovery.cleared) {
        store.finishVisit(visitId, { status: "captcha", error: recovery.reason ?? "captcha wall" });
        return;
      }
      // Recovered — reload the keyword SERP for a clean parse.
      await openSerp(page, config, item.keyword).catch(() => {});
    }

    if (!(await pageLooksLikeCaptcha(page))) {
      store.ipTrust.markClean(profile.id);
    }

    const parsed = await parseOrganicResults(page);
    if (parsed.empty) {
      store.finishVisit(visitId, { status: "error", error: "SERP markup not recognised" });
      return;
    }

    const target = findTarget(parsed.results, item.targetDomain);
    if (!target) {
      logger.info({ keyword: item.keyword, domain: item.targetDomain }, "target not on SERP — miss recorded");
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
      store.finishVisit(visitId, { status: "error", position: target.position, error: "organic click failed" });
      return;
    }

    const visit = await runSiteVisit(landed, personaBehavior, item.targetDomain, {
      isMobile: mobile,
      navTimeoutMs: config.engine.navTimeoutMs,
    });

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
    logger.info(
      { keyword: item.keyword, domain: item.targetDomain, position: target.position, dwellMs: visit.dwellMs, internalClicks: visit.internalClicks },
      "visit completed"
    );
  } catch (err) {
    logger.warn({ err: String(err), profile: profile.name }, "visit failed");
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
  private profiles: AntidetectProfile[] = [];
  private startDate = "";
  private running = false;
  private active = 0;
  /** Plan items already attempted today: `${profileId}|${keyword}|${hour}`. */
  private readonly doneKeys = new Set<string>();
  private readonly inFlight = new Set<string>();
  private doneDate = "";

  constructor(private readonly deps: EngineDeps) {}

  async init(): Promise<void> {
    const { config, store, antidetect } = this.deps;
    store.syncSites(config.sites);
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
    logger.info(
      { profiles: this.profiles.length, startDate: this.startDate, driver: antidetect.driver },
      "engine initialised"
    );
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
  }

  status(): EngineStatus {
    const { config, store } = this.deps;
    const today = dateKey();
    const plan = this.currentPlan();
    const dayIndex = this.startDate ? dayIndexFor(today, this.startDate) : 1;
    return {
      running: this.running,
      driver: this.deps.antidetect.driver,
      date: today,
      rampDay: dayIndex,
      todayQuota: quotaForDay(dayIndex, config),
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
    return todaysPlan(dateKey(), this.profiles, this.deps.config, this.startDate);
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
