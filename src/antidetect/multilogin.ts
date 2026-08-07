import { RateLimiter } from "../util/time.js";
import { logger } from "../logger.js";
import type { AntidetectClient, AntidetectProfile } from "./client.js";

/**
 * Multilogin X Local API driver (default http://localhost:35000, "Local API v2").
 *
 * Endpoint map (Multilogin X local API docs):
 *  - GET  /api/v1/folders                                → workspace folders
 *  - POST /api/v1/profile/search { query, folder_id }    → profile list
 *  - POST /api/v2/profile/f/{folderId}/p/{profileId}/start?automation_type=playwright
 *        → { data: { port } } — the profile's Chromium debugger port; the CDP
 *          websocket is then read from http://127.0.0.1:{port}/json/version.
 *  - POST /api/v2/profile/f/{folderId}/p/{profileId}/stop
 *
 * NOTE: this driver is written against the published API shape but has NOT been
 * verified against a live Multilogin install — field names may need a small
 * adjustment on first real run (check the logged response bodies).
 */

interface MlxEnvelope<T> {
  status?: { message?: string; http_code?: string };
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
    readonly path: string
  ) {
    super(`Multilogin ${path}: ${message}`);
    this.name = "MultiloginError";
  }
}

export class MultiloginDriver implements AntidetectClient {
  readonly driver = "multilogin" as const;
  private readonly limiter: RateLimiter;
  /** profileId → folderId (Multilogin start/stop URLs are folder-scoped). */
  private readonly folderByProfile = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly defaultFolderId: string,
    requestIntervalMs: number
  ) {
    this.limiter = new RateLimiter(requestIntervalMs);
  }

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
    opts: { params?: Record<string, string | number | boolean | undefined>; method?: "GET" | "POST"; body?: unknown } = {}
  ): Promise<T> {
    const method = opts.method ?? "GET";
    return this.limiter.schedule(async () => {
      const res = await fetch(this.buildUrl(path, opts.params), {
        method,
        headers: opts.body !== undefined ? { "Content-Type": "application/json" } : {},
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new MultiloginError(`HTTP ${res.status}: ${text.slice(0, 160)}`, path);
      }
      const json = (await res.json()) as MlxEnvelope<T>;
      const code = json.status?.http_code;
      if (code && code !== "OK" && code !== "200") {
        throw new MultiloginError(json.status?.message ?? `http_code=${code}`, path);
      }
      return json.data;
    });
  }

  async isUp(): Promise<boolean> {
    try {
      // Any cheap authenticated endpoint works as a liveness probe.
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
      method: "POST",
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

  /** Start the profile and return its CDP websocket endpoint. */
  async startBrowser(profileId: string): Promise<string> {
    const folderId = await this.folderFor(profileId);
    const started = await this.request<{ port?: number }>(
      `/api/v2/profile/f/${encodeURIComponent(folderId)}/p/${encodeURIComponent(profileId)}/start`,
      { method: "POST", params: { automation_type: "playwright", headless_mode: false } }
    );
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
    const folderId = await this.folderFor(profileId);
    await this.request<unknown>(
      `/api/v2/profile/f/${encodeURIComponent(folderId)}/p/${encodeURIComponent(profileId)}/stop`,
      { method: "POST" }
    );
  }
}
