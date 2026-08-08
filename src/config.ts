import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const ConfigSchema = z.object({
  antidetect: z.object({
    /** "adspower" (Local API) or "multilogin" (Multilogin X Local API v2). */
    driver: z.enum(["adspower", "multilogin"]).default("adspower"),
    requestIntervalMs: z.number().int().positive().default(1100),
  }),
  google: z.object({
    domain: z.string(),
    hl: z.string(),
    gl: z.string(),
    num: z.number().int().positive(),
    uule: z.string().optional().default(""),
    extraParams: z.record(z.string()).default({}),
  }),
  location: z.object({
    country: z.string(),
    city: z.string().optional(),
  }),
  /** Target sites: the domains we push up the organic SERP. */
  sites: z
    .array(
      z.object({
        domain: z.string(),
        keywords: z.array(z.string()).min(1),
        /** Relative share of the daily quota (default 1). */
        weight: z.number().positive().default(1),
      })
    )
    .min(1),
  /** Day-by-day visit ramp. */
  ramp: z.object({
    /**
     * Ramp anchor (YYYY-MM-DD). Empty = first day the engine runs (persisted in
     * the DB on first tick, so restarts do not reset the ramp).
     */
    startDate: z.string().default(""),
    dayOneVisits: z.number().int().positive().default(20),
    plateauVisits: z.number().int().positive().default(100),
    rampDays: z.number().int().positive().default(8),
    /** Hard daily Google-search ceiling per profile/IP. */
    perIpDailyCap: z.number().int().positive().default(10),
    perProfileDailyCap: z.number().int().positive().default(10),
    /** Weighted activity window: peakStartHour..peakEndHour (25 = 01:00 next day). */
    peakStartHour: z.number().int().min(0).max(23).default(8),
    peakEndHour: z.number().int().min(1).max(28).default(25),
    /** Low-activity window (visits still possible, just rare). */
    quietStartHour: z.number().int().min(0).max(23).default(3),
    quietEndHour: z.number().int().min(0).max(23).default(7),
  }),
  engine: z.object({
    /** Max simultaneous profile browsers (small VPS: 1–2). */
    concurrency: z.number().int().positive().default(2),
    tickSeconds: z.number().int().positive().default(60),
    visitJitterMinMs: z.number().int().nonnegative().default(20_000),
    visitJitterMaxMs: z.number().int().nonnegative().default(90_000),
    navTimeoutMs: z.number().int().positive().default(45_000),
  }),
  profiles: z.object({
    /** Only antidetect profiles whose name starts with one of these prefixes are used. */
    prefixes: z.array(z.string()).default([]),
    /** Explicit profile ids — when non-empty this wins over prefixes. */
    ids: z.array(z.string()).default([]),
  }),
  behavior: z.object({
    /** Landing dwell range on the target page. */
    dwellMinMs: z.number().int().nonnegative().default(25_000),
    dwellMaxMs: z.number().int().nonnegative().default(70_000),
    /** Percent-based scroll waypoints (0..1 of page height). */
    scrollWaypoints: z.array(z.number().min(0).max(1)).default([0.25, 0.5, 0.75, 1]),
    /** Chance a waypoint is actually scrolled to (per waypoint). */
    scrollReachChance: z.number().min(0).max(1).default(0.75),
    mouseMoveChance: z.number().min(0).max(1).default(0.6),
    internalLinks: z
      .object({
        enabled: z.boolean().default(true),
        chance: z.number().min(0).max(1).default(0.4),
        maxClicks: z.number().int().nonnegative().default(2),
        minStayMs: z.number().int().nonnegative().default(10_000),
        maxStayMs: z.number().int().nonnegative().default(30_000),
      })
      .default({}),
    /** Optionally open a competing organic result briefly (comparison shopper signal). */
    rivalCompare: z
      .object({
        enabled: z.boolean().default(false),
        chance: z.number().min(0).max(1).default(0.15),
        minStayMs: z.number().int().nonnegative().default(8_000),
        maxStayMs: z.number().int().nonnegative().default(20_000),
      })
      .default({}),
    /** "close" = end on the target page; "internal" = leave via an internal link. */
    exitMode: z.enum(["close", "internal"]).default("close"),
    /** Hedef 1. sayfada yoksa insan gibi sayfalama ile derine bak. */
    deepSearch: z
      .object({
        enabled: z.boolean().default(true),
        maxPages: z.number().int().min(1).max(5).default(3),
      })
      .default({}),
    /** Derin aramada da yoksa: aynı oturumda sorguyu derinleştir (marka↔domain sinyali). */
    refineOnMiss: z
      .object({
        enabled: z.boolean().default(true),
        maxRefinements: z.number().int().min(1).max(3).default(2),
      })
      .default({}),
  }),
  solver: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(["2captcha", "capsolver", "auto"]).default("auto"),
    twoCaptchaApiKey: z.string().default(""),
    capSolverApiKey: z.string().default(""),
    /** Paid attempts allowed on ONE /sorry wall before cooldown. */
    maxAttemptsPerWall: z.number().int().positive().default(2),
    maxSolvesPerHour: z.number().int().positive().default(20),
    maxSolvesPerDay: z.number().int().positive().default(120),
  }),
  panel: z.object({
    port: z.number().int().positive().default(3080),
    /** Kanıt screenshot'ları bu kadar gün tutulur, sonra otomatik silinir. */
    evidenceRetentionDays: z.number().int().positive().default(14),
  }),
  output: z.object({
    dir: z.string(),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type SiteConfig = AppConfig["sites"][number];

interface RawFileConfig {
  [key: string]: unknown;
}

function loadDefaults(): RawFileConfig {
  const path = resolve(PROJECT_ROOT, "config", "default.json");
  return JSON.parse(readFileSync(path, "utf8")) as RawFileConfig;
}

/**
 * Merge config/default.json with environment variables. Env wins.
 * Secrets (API keys, panel password) live only in the environment / .env.
 */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const file = loadDefaults() as any;

  const merged = {
    antidetect: {
      driver: file.antidetect?.driver ?? "adspower",
      requestIntervalMs: file.antidetect?.requestIntervalMs ?? 1100,
    },
    google: {
      domain: file.google?.domain ?? "www.google.com",
      hl: file.google?.hl ?? "tr",
      gl: file.google?.gl ?? "tr",
      num: file.google?.num ?? 10,
      uule: file.google?.uule ?? "",
      extraParams: file.google?.extraParams ?? {},
    },
    location: {
      country: file.location?.country ?? "TR",
      city: file.location?.city,
    },
    sites: Array.isArray(file.sites) ? file.sites : [],
    ramp: {
      startDate: file.ramp?.startDate ?? "",
      dayOneVisits: file.ramp?.dayOneVisits ?? 20,
      plateauVisits: file.ramp?.plateauVisits ?? 100,
      rampDays: file.ramp?.rampDays ?? 8,
      perIpDailyCap: file.ramp?.perIpDailyCap ?? 10,
      perProfileDailyCap: file.ramp?.perProfileDailyCap ?? 10,
      peakStartHour: file.ramp?.peakStartHour ?? 8,
      peakEndHour: file.ramp?.peakEndHour ?? 25,
      quietStartHour: file.ramp?.quietStartHour ?? 3,
      quietEndHour: file.ramp?.quietEndHour ?? 7,
    },
    engine: {
      concurrency: file.engine?.concurrency ?? 2,
      tickSeconds: file.engine?.tickSeconds ?? 60,
      visitJitterMinMs: file.engine?.visitJitterMinMs ?? 20_000,
      visitJitterMaxMs: file.engine?.visitJitterMaxMs ?? 90_000,
      navTimeoutMs: file.engine?.navTimeoutMs ?? 45_000,
    },
    profiles: {
      prefixes: Array.isArray(file.profiles?.prefixes) ? file.profiles.prefixes : [],
      ids: Array.isArray(file.profiles?.ids) ? file.profiles.ids : [],
    },
    behavior: {
      dwellMinMs: file.behavior?.dwellMinMs ?? 25_000,
      dwellMaxMs: file.behavior?.dwellMaxMs ?? 70_000,
      scrollWaypoints: Array.isArray(file.behavior?.scrollWaypoints)
        ? file.behavior.scrollWaypoints
        : [0.25, 0.5, 0.75, 1],
      scrollReachChance: file.behavior?.scrollReachChance ?? 0.75,
      mouseMoveChance: file.behavior?.mouseMoveChance ?? 0.6,
      internalLinks: {
        enabled: file.behavior?.internalLinks?.enabled ?? true,
        chance: file.behavior?.internalLinks?.chance ?? 0.4,
        maxClicks: file.behavior?.internalLinks?.maxClicks ?? 2,
        minStayMs: file.behavior?.internalLinks?.minStayMs ?? 10_000,
        maxStayMs: file.behavior?.internalLinks?.maxStayMs ?? 30_000,
      },
      rivalCompare: {
        enabled: file.behavior?.rivalCompare?.enabled ?? false,
        chance: file.behavior?.rivalCompare?.chance ?? 0.15,
        minStayMs: file.behavior?.rivalCompare?.minStayMs ?? 8_000,
        maxStayMs: file.behavior?.rivalCompare?.maxStayMs ?? 20_000,
      },
      exitMode: file.behavior?.exitMode ?? "close",
      deepSearch: {
        enabled: file.behavior?.deepSearch?.enabled ?? true,
        maxPages: file.behavior?.deepSearch?.maxPages ?? 3,
      },
      refineOnMiss: {
        enabled: file.behavior?.refineOnMiss?.enabled ?? true,
        maxRefinements: file.behavior?.refineOnMiss?.maxRefinements ?? 2,
      },
    },
    solver: {
      enabled: file.solver?.enabled ?? false,
      provider: file.solver?.provider ?? "auto",
      twoCaptchaApiKey: process.env.TWOCAPTCHA_API_KEY ?? "",
      capSolverApiKey: process.env.CAPSOLVER_API_KEY ?? "",
      maxAttemptsPerWall: file.solver?.maxAttemptsPerWall ?? 2,
      maxSolvesPerHour: file.solver?.maxSolvesPerHour ?? 20,
      maxSolvesPerDay: file.solver?.maxSolvesPerDay ?? 120,
    },
    panel: {
      port: Number(process.env.PANEL_PORT ?? file.panel?.port ?? 3080),
      evidenceRetentionDays: Number(file.panel?.evidenceRetentionDays ?? 14),
    },
    output: {
      dir: process.env.OUTPUT_DIR || "./data",
    },
    ...overrides,
  };

  const parsed = ConfigSchema.parse(merged);
  // Resolve output dir to an absolute path against the project root.
  parsed.output.dir = resolve(PROJECT_ROOT, parsed.output.dir);
  return parsed;
}

export { PROJECT_ROOT };
