import type { AppConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { AntidetectProfile } from "../antidetect/client.js";

/**
 * Day-by-day ramp + daily visit planner.
 *
 * Quota ramps linearly from dayOneVisits (day 1) to plateauVisits (day
 * rampDays), then holds. The ramp anchor date is either config.ramp.startDate
 * or persisted in the DB on first run (restarts never reset the ramp).
 *
 * todaysPlan() is DETERMINISTIC for a given date: the engine and the panel can
 * call it any number of times and get the same plan, and a midnight restart
 * does not reshuffle the day.
 */

export interface PlannedVisit {
  profileId: string;
  profileName: string;
  keyword: string;
  /** Target site domain (the organic result we want to click). */
  targetDomain: string;
  /** Hour of day (0-23, local time) the visit becomes due. */
  scheduledHour: number;
}

// ── deterministic PRNG (mulberry32 over a string seed) ─────────────────────

function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── ramp math ───────────────────────────────────────────────────────────────

export function dateKey(d = new Date()): string {
  // Local date, not UTC — the ramp follows the operator's timezone.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Resolve the ramp anchor: config value wins, else persisted, else today (and persist). */
export function rampStartDate(store: Store, config: AppConfig): string {
  if (config.ramp.startDate) return config.ramp.startDate;
  const existing = store.getMeta("rampStartDate");
  if (existing) return existing;
  const today = dateKey();
  store.setMeta("rampStartDate", today);
  return today;
}

/** 1-based ramp day index for a date (day 1 = ramp start). */
export function dayIndexFor(date: string, startDate: string): number {
  const a = new Date(date + "T00:00:00").getTime();
  const b = new Date(startDate + "T00:00:00").getTime();
  return Math.max(1, Math.floor((a - b) / 86_400_000) + 1);
}

/** Total visits planned for a ramp day (linear ramp, then plateau). */
export function quotaForDay(dayIndex: number, config: AppConfig): number {
  const { dayOneVisits, plateauVisits, rampDays } = config.ramp;
  if (dayIndex >= rampDays) return plateauVisits;
  if (rampDays <= 1) return plateauVisits;
  const t = (dayIndex - 1) / (rampDays - 1);
  return Math.min(plateauVisits, Math.round(dayOneVisits + (plateauVisits - dayOneVisits) * t));
}

// ── hour distribution ───────────────────────────────────────────────────────

/**
 * Hour weight: quiet window (default 03-07) is rare, peak window
 * (default 08:00-01:00) is the bulk, the rest is moderate.
 */
export function hourWeight(hour: number, config: AppConfig): number {
  const { quietStartHour, quietEndHour, peakStartHour, peakEndHour } = config.ramp;
  if (hour >= quietStartHour && hour < quietEndHour) return 0.12;
  // peakEndHour may exceed 23 (25 = 01:00 next day); normalise to 0-23 range.
  const inPeak = peakEndHour <= 23
    ? hour >= peakStartHour && hour < peakEndHour
    : hour >= peakStartHour || hour < peakEndHour - 24;
  return inPeak ? 1 : 0.35;
}

/** Pick an hour from the weighted distribution. */
function sampleHour(rand: () => number, config: AppConfig): number {
  const weights: number[] = [];
  let total = 0;
  for (let h = 0; h < 24; h++) {
    const w = hourWeight(h, config);
    weights.push(w);
    total += w;
  }
  let pick = rand() * total;
  for (let h = 0; h < 24; h++) {
    pick -= weights[h]!;
    if (pick <= 0) return h;
  }
  return 23;
}

// ── plan builder ────────────────────────────────────────────────────────────

/**
 * Build today's visit plan: quota visits spread over the profile pool
 * (per-profile daily cap respected), keywords rotated per site weight, hours
 * sampled from the persona-friendly day curve.
 *
 * Returns [] when no profiles are available. The quota clamps down to
 * profiles × perProfileDailyCap when the pool is too small for the ramp day.
 */
export function todaysPlan(
  date: string,
  profiles: AntidetectProfile[],
  config: AppConfig,
  startDate: string
): PlannedVisit[] {
  if (!profiles.length) return [];
  const rand = mulberry32(hashSeed(`pbd:${date}`));

  const dayIndex = dayIndexFor(date, startDate);
  const rawQuota = quotaForDay(dayIndex, config);

  // Per-profile daily capacity (perProfileDailyCap mirrors the per-IP cap —
  // each profile carries its own IP).
  const cap = Math.min(config.ramp.perProfileDailyCap, config.ramp.perIpDailyCap);
  const capacity = profiles.length * cap;
  const quota = Math.min(rawQuota, capacity);

  // Shuffle the pool deterministically so the same profiles do not always get
  // the early slots.
  const pool = [...profiles];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }

  // Flatten sites into a weighted keyword rotation.
  const weightedKeywords: Array<{ keyword: string; domain: string }> = [];
  for (const site of config.sites) {
    const reps = Math.max(1, Math.round(site.weight));
    for (let r = 0; r < reps; r++) {
      for (const keyword of site.keywords) {
        weightedKeywords.push({ keyword, domain: site.domain });
      }
    }
  }
  if (!weightedKeywords.length) return [];

  const plan: PlannedVisit[] = [];
  const perProfileCount = new Map<string, number>();
  let kwCursor = Math.floor(rand() * weightedKeywords.length);

  while (plan.length < quota) {
    let progressed = false;
    for (const profile of pool) {
      if (plan.length >= quota) break;
      const count = perProfileCount.get(profile.id) ?? 0;
      if (count >= cap) continue;
      const kw = weightedKeywords[kwCursor % weightedKeywords.length]!;
      kwCursor += 1;
      plan.push({
        profileId: profile.id,
        profileName: profile.name,
        keyword: kw.keyword,
        targetDomain: kw.domain,
        scheduledHour: sampleHour(rand, config),
      });
      perProfileCount.set(profile.id, count + 1);
      progressed = true;
    }
    if (!progressed) break; // pool exhausted at caps
  }

  // Chronological order makes "due now" checks trivial.
  plan.sort((a, b) => a.scheduledHour - b.scheduledHour);
  return plan;
}
