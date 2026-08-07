import { createHash } from "node:crypto";
import { Agent, fetch as uFetch } from "undici";
import { RateLimiter } from "../util/time.js";
import { logger } from "../logger.js";
import type { AntidetectClient, AntidetectProfile } from "./client.js";

/**
 * Multilogin X launcher driver — verified against a live MLX agent (2026-08).
 *
 * Verified API shape:
 *  - Auth: POST https://api.multilogin.com/user/signin
 *      body { email, password: md5(password) } → { data: { token } }
 *      The Bearer token is required on EVERY launcher call; it expires in ~30
 *      min, so it is cached and refreshed proactively / on 401.
 *  - Start: GET {base}/api/v2/profile/f/{folderId}/p/{profileId}/start
 *      ?automation_type=playwright&headless_mode=false
 *      → { data: { port: "44901" (string!), ... }, status: { error_code: "" } }
 *      CDP http endpoint is then http://127.0.0.1:{port}/json/version.
 *  - Stop:  GET {base}/api/v1/profile/stop/p/{profileId}   (v1 base, no folder!)
 *  - While the Mimic core downloads (first launch), start answers
 *      error_code CORE_DOWNLOADING_STARTED / http_code 500 — poll until ready.
 *  - Envelope: { status: { error_code: string, http_code: number, message },
 *                data: ... } — an empty error_code means success.
 *
 * The launcher serves a self-signed cert on https://launcher.mlx.yt:45001
 * (loopback alias), so launcher calls go through an undici agent with
 * rejectUnauthorized=false. The cloud API keeps normal TLS verification.
 */

const CLOUD_SIGNIN_URL = "https://api.multilogin.com/user/signin";
const TOKEN_TTL_MS = 25 * 60 * 1000; // refresh before the 30-min expiry
const CORE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const CORE_DOWNLOAD_POLL_MS = 15_000;

interface MlxEnvelope<T> {
  status?: { error_code?: string; http_code?: number | string; message?: string };
  data: T;
}

interface MlxFolder {
  folder_id: string;
  name?: string;
}

interface MlxProfile {
  id: string;
  name: string;
  folder_id: string;
  proxy?: {
    type?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  };
}

export class MultiloginError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly errorCode?: string
  ) {
    super(`Multilogin ${path}: ${message}`);
    this.name = "MultiloginError";
  }
}

export class MultiloginDriver implements AntidetectClient {
  readonly driver = "multilogin" as const;
  private readonly limiter: RateLimiter;
  /** profileId → folderId (start URLs are folder-scoped). */
  private readonly folderByProfile = new Map<string, string>();
  /** The launcher cert is self-signed (loopback alias) — skip verification. */
  private readonly insecureTls = new Agent({ connect: { rejectUnauthorized: false } });
  private token: string | null = null;
  private tokenAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly defaultFolderId: string,
    private readonly email: string,
    private readonly password: string,
    requestIntervalMs: number
  ) {
    this.limiter = new RateLimiter(requestIntervalMs);
  }

  // ---------------------------------------------------------------- auth ---

  private async signin(): Promise<string> {
    const res = await fetch(CLOUD_SIGNIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        email: this.email,
        password: createHash("md5").update(this.password).digest("hex"),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => null)) as MlxEnvelope<{ token?: string }> | null;
    const token = json?.data?.token;
    if (!res.ok || !token) {
      throw new MultiloginError(`signin failed (HTTP ${res.status})`, "/user/signin");
    }
    this.token = token;
    this.tokenAt = Date.now();
    return token;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() - this.tokenAt < TOKEN_TTL_MS) return this.token;
    return this.signin();
  }

  // ------------------------------------------------------------- request ---

  private buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async request<T>(
    path: string,
    opts: { params?: Record<string, string | number | boolean | undefined>; body?: unknown; retried?: boolean } = {}
  ): Promise<T> {
    const method = opts.body !== undefined ? "POST" : "GET";
    return this.limiter.schedule(async () => {
      const token = await this.getToken();
      const res = await uFetch(this.buildUrl(path, opts.params), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        dispatcher: this.insecureTls,
        signal: AbortSignal.timeout(180_000), // first start may download the core
      });
      const json = (await res.json().catch(() => null)) as MlxEnvelope<T> | null;

      // Expired/invalid token → one refresh + retry.
      if ((res.status === 401 || res.status === 403) && !opts.retried) {
        logger.warn({ path, status: res.status }, "multilogin token rejected, refreshing");
        this.token = null;
        return this.request<T>(path, { ...opts, retried: true });
      }

      const errorCode = json?.status?.error_code ?? "";
      if (!res.ok || errorCode) {
        const message = json?.status?.message ?? `HTTP ${res.status}`;
        throw new MultiloginError(errorCode ? `${errorCode}: ${message}` : message, path, errorCode || undefined);
      }
      return (json as MlxEnvelope<T>).data;
    });
  }

  // ----------------------------------------------------------------- api ---

  async isUp(): Promise<boolean> {
    try {
      await this.request<MlxFolder[]>("/api/v1/folders");
      return true;
    } catch {
      return false;
    }
  }

  private async resolveFolderId(): Promise<string> {
    if (this.defaultFolderId) return this.defaultFolderId;
    const folders = await this.request<MlxFolder[]>("/api/v1/folders").catch(() => [] as MlxFolder[]);
    const first = folders[0];
    if (!first) throw new MultiloginError("no workspace folders found", "/api/v1/folders");
    return first.folder_id;
  }

  async listProfiles(): Promise<AntidetectProfile[]> {
    const folderId = await this.resolveFolderId();
    const data = await this.request<{ profiles?: MlxProfile[] } | MlxProfile[]>("/api/v1/profile/search", {
      body: { query: "", folder_id: folderId, limit: 200, offset: 0 },
    });
    const list = Array.isArray(data) ? data : (data.profiles ?? []);
    return list.map((p) => {
      this.folderByProfile.set(p.id, p.folder_id || folderId);
      let proxy: AntidetectProfile["proxy"];
      if (p.proxy?.host && p.proxy.port) {
        const rawType = (p.proxy.type || "http").toLowerCase();
        proxy = {
          host: p.proxy.host,
          port: Number(p.proxy.port),
          user: p.proxy.username || undefined,
          password: p.proxy.password || undefined,
          type: rawType.includes("socks5")
            ? "SOCKS5"
            : rawType.includes("socks4")
              ? "SOCKS4"
              : rawType === "https"
                ? "HTTPS"
                : "HTTP",
        };
      }
      return { id: p.id, name: p.name || p.id, proxy };
    });
  }

  private async folderFor(profileId: string): Promise<string> {
    const known = this.folderByProfile.get(profileId);
    if (known) return known;
    // Populate the cache (also validates connectivity) then fall back to default.
    await this.listProfiles().catch((err) => logger.warn({ err: String(err) }, "multilogin profile refresh failed"));
    return this.folderByProfile.get(profileId) ?? this.resolveFolderId();
  }

  private async rawStart(profileId: string, folderId: string): Promise<{ port: string }> {
    return this.request<{ port?: string | number }>(
      `/api/v2/profile/f/${encodeURIComponent(folderId)}/p/${encodeURIComponent(profileId)}/start`,
      { params: { automation_type: "playwright", headless_mode: false } }
    ).then((d) => ({ port: String(d?.port ?? "") }));
  }

  /** Start the profile and return its CDP websocket endpoint. */
  async startBrowser(profileId: string): Promise<string> {
    const folderId = await this.folderFor(profileId);

    // First-ever launch triggers a Mimic core download — poll until it is done.
    const deadline = Date.now() + CORE_DOWNLOAD_TIMEOUT_MS;
    let started: { port: string } | null = null;
    for (;;) {
      try {
        started = await this.rawStart(profileId, folderId);
        break;
      } catch (err) {
        const code = err instanceof MultiloginError ? err.errorCode : undefined;
        if (code?.includes("CORE_DOWNLOADING") && Date.now() < deadline) {
          logger.info({ profileId }, "mimic core downloading, waiting");
          await new Promise((r) => setTimeout(r, CORE_DOWNLOAD_POLL_MS));
          continue;
        }
        if (code === "PROFILE_ALREADY_RUNNING") {
          // Stale browser process from a crashed run — stop and retry once.
          logger.warn({ profileId }, "profile already running, stopping stale browser");
          await this.stopBrowser(profileId).catch(() => {});
          await new Promise((r) => setTimeout(r, 5_000));
          started = await this.rawStart(profileId, folderId);
          break;
        }
        throw err;
      }
    }

    if (!started?.port) {
      throw new MultiloginError("profile start returned no debugger port", "/api/v2/profile/start");
    }
    // The debugger port speaks the plain DevTools HTTP protocol; the websocket
    // URL lives at /json/version (webSocketDebuggerUrl).
    const version = (await (
      await fetch(`http://127.0.0.1:${started.port}/json/version`, { signal: AbortSignal.timeout(10_000) })
    ).json()) as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) {
      throw new MultiloginError(`no webSocketDebuggerUrl on port ${started.port}`, "/json/version");
    }
    return version.webSocketDebuggerUrl;
  }

  async stopBrowser(profileId: string): Promise<void> {
    // Verified: stop lives on the v1 base and is NOT folder-scoped.
    await this.request<unknown>(`/api/v1/profile/stop/p/${encodeURIComponent(profileId)}`);
  }
}
