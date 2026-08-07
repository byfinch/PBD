import { RateLimiter } from "../util/time.js";
import { logger } from "../logger.js";
import type { AntidetectClient, AntidetectProfile } from "./client.js";

interface AdsPowerWs {
  puppeteer: string;
  selenium: string;
}

interface StartResult {
  ws: AdsPowerWs;
  debug_port?: string;
  webdriver?: string;
}

interface ActiveResult {
  status: "Active" | "Inactive";
  ws?: AdsPowerWs;
  debug_port?: string;
}

interface UserProxyConfig {
  proxy_soft?: string;
  proxy_type?: string;
  proxy_host?: string;
  proxy_port?: string | number;
  proxy_user?: string;
  proxy_password?: string;
  proxy_url?: string;
}

interface ProfileSummary {
  user_id: string;
  serial_number: string;
  name: string;
  group_id: string;
  group_name: string;
  ip?: string;
  ip_country?: string;
  remark?: string;
  last_open_time?: string;
  user_proxy_config?: UserProxyConfig;
}

export class AdsPowerError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly path: string
  ) {
    super(`AdsPower ${path}: ${message} (code ${code})`);
    this.name = "AdsPowerError";
  }
}

interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

/**
 * Extra Chromium flags passed to the profile browser via AdsPower's launch_args
 * (appended to AdsPower's own args). Perf/stability only — no fingerprint impact.
 *
 * imagesEnabled=false is the resource diet, applied at the blink level: images
 * are never fetched/decoded, with ZERO per-request CDP cost (route interception
 * freezes renderers on heavy SERPs).
 */
const PERF_LAUNCH_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-background-networking",
  "--mute-audio",
  "--disable-features=Translate",
  "--blink-settings=imagesEnabled=false",
];

/**
 * AdsPower Local API driver.
 *
 * Contract (verified against a live install):
 *  - Auth is an `Authorization: Bearer <key>` header on every call. `/status` is exempt.
 *  - Errors return HTTP 200 with { code: -1, msg }, so we branch on the body's `code`.
 *  - Everything is serialised through a rate limiter; a "Too many request" body is retried.
 */
export class AdsPowerDriver implements AntidetectClient {
  readonly driver = "adspower" as const;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    requestIntervalMs: number
  ) {
    this.limiter = new RateLimiter(requestIntervalMs);
  }

  private headers(hasBody = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    if (hasBody) h["Content-Type"] = "application/json";
    return h;
  }

  private buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** One HTTP attempt, with a hard timeout so a wedged Local API can't stall for minutes. */
  private async fetchOnce<T>(
    path: string,
    opts: { params?: Record<string, string | number | undefined>; method: "GET" | "POST"; body?: unknown }
  ): Promise<ApiEnvelope<T>> {
    const url = this.buildUrl(path, opts.params);
    const res = await fetch(url, {
      method: opts.method,
      headers: this.headers(opts.body !== undefined),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    }
    return (await res.json()) as ApiEnvelope<T>;
  }

  private async request<T>(
    path: string,
    opts: { params?: Record<string, string | number | undefined>; method?: "GET" | "POST"; body?: unknown } = {}
  ): Promise<T> {
    const method = opts.method ?? "GET";
    // Hard total deadline: the rate-limiter queue (or repeated retries) must not
    // let a request hang forever while the Local API is wedged.
    const deadline = Date.now() + 60_000;
    let lastMsg = "unknown error";
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (Date.now() > deadline) throw new AdsPowerError("request deadline exceeded (60s)", -1, path);
      let json: ApiEnvelope<T>;
      try {
        json = await this.limiter.schedule(() => this.fetchOnce<T>(path, { params: opts.params, method, body: opts.body }));
        if (Date.now() > deadline) throw new Error("request deadline exceeded (60s)");
      } catch (err) {
        const msg = String(err);
        if (msg.includes("deadline exceeded")) throw new AdsPowerError("request deadline exceeded (60s)", -1, path);
        // 4xx (except 429) is a client error — retrying cannot help.
        if (/HTTP 4(?!29)\d/.test(msg)) throw new AdsPowerError(msg, -1, path);
        lastMsg = `network error: ${msg}`;
        logger.warn({ path, attempt, err: msg }, "AdsPower request failed at transport");
        continue;
      }
      if (json.code === 0) return json.data;
      lastMsg = json.msg;
      if (/too many request/i.test(json.msg ?? "")) {
        // The Local API's per-second budget may be drained by something outside
        // this client — limiter spacing alone is not enough; back off harder.
        await new Promise((r) => setTimeout(r, 2500 * attempt));
        continue;
      }
      throw new AdsPowerError(json.msg, json.code, path);
    }
    throw new AdsPowerError(`retries exhausted: ${lastMsg}`, -1, path);
  }

  /** Liveness probe. Returns true if the Local API answers. */
  async isUp(): Promise<boolean> {
    try {
      const res = await fetch(this.buildUrl("/status"), { signal: AbortSignal.timeout(5000) });
      const json = (await res.json()) as ApiEnvelope<unknown>;
      return json.code === 0;
    } catch {
      return false;
    }
  }

  private async listRawProfiles(): Promise<ProfileSummary[]> {
    const out: ProfileSummary[] = [];
    for (let page = 1; page <= 50; page++) {
      const data = await this.request<{ list: ProfileSummary[]; page: number; page_size: number }>("/api/v1/user/list", {
        params: { page, page_size: 100 },
      });
      const list = data.list ?? [];
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }

  async listProfiles(): Promise<AntidetectProfile[]> {
    const raw = await this.listRawProfiles();
    return raw.map((p) => {
      const c = p.user_proxy_config;
      let proxy: AntidetectProfile["proxy"];
      if (c?.proxy_host && c.proxy_port !== undefined && c.proxy_port !== "") {
        const rawType = (c.proxy_type || "http").toLowerCase();
        const type: NonNullable<AntidetectProfile["proxy"]>["type"] = rawType.includes("socks5")
          ? "SOCKS5"
          : rawType.includes("socks4")
            ? "SOCKS4"
            : rawType === "https"
              ? "HTTPS"
              : "HTTP";
        proxy = {
          host: c.proxy_host,
          port: Number(c.proxy_port),
          user: c.proxy_user || undefined,
          password: c.proxy_password || undefined,
          type,
          exitIp: p.ip,
        };
      }
      return { id: p.user_id, name: p.name || p.user_id, proxy };
    });
  }

  private async browserActive(userId: string): Promise<ActiveResult> {
    return this.request<ActiveResult>("/api/v1/browser/active", { params: { user_id: userId } });
  }

  private async startBrowserRaw(userId: string): Promise<StartResult> {
    // last_opened_tabs=0: do not reopen previous SERP when profile starts.
    // open_tabs=1: skip AdsPower junk tabs. ip_tab=0: no proxy-check first tab.
    const params = {
      user_id: userId,
      headless: 0,
      open_tabs: 1,
      ip_tab: 0,
      last_opened_tabs: 0,
    };
    try {
      // launch_args: AdsPower appends these to its own Chromium command line.
      return await this.request<StartResult>("/api/v1/browser/start", {
        params: { ...params, launch_args: JSON.stringify(PERF_LAUNCH_ARGS) },
      });
    } catch (err) {
      // Older Local API builds may reject launch_args — never block a profile
      // open on perf flags; retry once without them.
      logger.warn({ userId, err: String(err) }, "browser/start with launch_args failed — retrying without extra args");
      return await this.request<StartResult>("/api/v1/browser/start", { params });
    }
  }

  /**
   * Return a live CDP websocket endpoint for the profile, re-using the running
   * browser if it is already Active, otherwise launching it.
   */
  async startBrowser(profileId: string): Promise<string> {
    const active = await this.browserActive(profileId).catch((err) => {
      logger.warn({ err: String(err) }, "browserActive check failed");
      return null;
    });
    if (active?.status === "Active" && active.ws?.puppeteer) {
      logger.info({ profileId }, "AdsPower profile already active — re-attaching");
      return active.ws.puppeteer;
    }
    const started = await this.startBrowserRaw(profileId);
    if (!started.ws?.puppeteer) {
      throw new AdsPowerError("browser/start returned no ws.puppeteer endpoint", -1, "/api/v1/browser/start");
    }
    return started.ws.puppeteer;
  }

  async stopBrowser(profileId: string): Promise<void> {
    // clean=1 so AdsPower does not keep a dirty session snapshot.
    await this.request<unknown>("/api/v1/browser/stop", {
      params: { user_id: profileId, clean: 1 },
    });
  }
}
