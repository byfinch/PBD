import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { AdsPowerDriver } from "./adspower.js";
import { MultiloginDriver } from "./multilogin.js";

/**
 * Driver-neutral view of an antidetect profile (AdsPower user / Multilogin profile).
 */
export interface AntidetectProfile {
  id: string;
  name: string;
  /** Proxy the profile is configured with (for solver IP-match + vault). */
  proxy?: {
    host: string;
    port: number;
    user?: string;
    password?: string;
    type: "HTTP" | "HTTPS" | "SOCKS4" | "SOCKS5";
    /** Last checked exit IP (logs only). */
    exitIp?: string;
  };
}

/**
 * The one contract the engine depends on. Implementations: AdsPower Local API
 * (default) and Multilogin X Local API v2 (localhost:35000).
 */
export interface AntidetectClient {
  readonly driver: "adspower" | "multilogin";
  /** Liveness probe. */
  isUp(): Promise<boolean>;
  /** All profiles visible to this driver. */
  listProfiles(): Promise<AntidetectProfile[]>;
  /**
   * Launch the profile's browser (or re-attach if already running) and return
   * a CDP websocket endpoint Playwright can connectOverCDP to.
   */
  startBrowser(profileId: string): Promise<string>;
  /** Stop the profile's browser. */
  stopBrowser(profileId: string): Promise<void>;
}

/** Build the configured driver. */
export function createAntidetectClient(config: AppConfig): AntidetectClient {
  if (config.antidetect.driver === "multilogin") {
    const baseUrl = process.env.MULTILOGIN_BASE_URL ?? "http://localhost:35000";
    const folderId = process.env.MULTILOGIN_FOLDER_ID ?? "";
    logger.info({ baseUrl }, "antidetect driver: multilogin");
    return new MultiloginDriver(baseUrl, folderId, config.antidetect.requestIntervalMs);
  }
  const baseUrl = process.env.ADSPOWER_BASE_URL ?? "http://local.adspower.net:50325";
  const apiKey = process.env.ADSPOWER_API_KEY ?? "";
  logger.info({ baseUrl }, "antidetect driver: adspower");
  return new AdsPowerDriver(baseUrl, apiKey, config.antidetect.requestIntervalMs);
}

/**
 * Pick the working profile pool from the driver list using config filters:
 * explicit ids win, then name prefixes.
 */
export function selectProfiles(all: AntidetectProfile[], config: AppConfig): AntidetectProfile[] {
  const { ids, prefixes } = config.profiles;
  if (ids.length) {
    const wanted = new Set(ids);
    return all.filter((p) => wanted.has(p.id));
  }
  if (prefixes.length) {
    return all.filter((p) => prefixes.some((pre) => p.name.startsWith(pre)));
  }
  return all;
}
