import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AppConfig } from "../config.js";
import type { Store } from "../store/db.js";
import { Engine, recentActivity, effectiveSitesList } from "../engine.js";
import { quotaForDay, dayIndexFor } from "../calendar/ramp.js";
import { measureAllPositions } from "../rank/tracker.js";
import { logger } from "../logger.js";

/**
 * PBD Ops panel — JSON API + static terminal UI.
 *
 * Auth: styled login page → POST /api/login → HttpOnly session cookie
 * (PANEL_USER / PANEL_PASSWORD, default admin/pbd). Sessions are in-memory;
 * a restart simply means logging in again.
 *
 * API:
 *   GET  /api/overview          engine status + vault + solver + evidence usage
 *   GET  /api/activity          live event ring (newest last)
 *   GET  /api/calendar          ramp plan + upcoming days
 *   GET  /api/visits            ?page&per&status&domain&profile — server-paged
 *   GET  /api/sites             panel-managed sites (DB = source of truth)
 *   POST /api/sites             { domain, keywords[], weight }
 *   PUT  /api/sites/:id         { weight?, keywords? }  (keywords = full replace)
 *   DELETE /api/sites/:id
 *   POST /api/engine            { enabled: bool } — persisted master switch
 *   POST /api/run               { domain, keyword? } — manual trigger
 *   POST /api/track             one position-measurement pass (async)
 *   GET  /api/positions         rank trends
 *   GET  /api/health            profile trust + performance stats
 *   GET  /evidence/:file        visit screenshots (auth'd)
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PanelDeps {
  config: AppConfig;
  store: Store;
  engine: Engine;
}

const sessions = new Set<string>();

function cookieToken(req: express.Request): string {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "pbd_sess") return decodeURIComponent(v.join("="));
  }
  return "";
}

export function startPanel(deps: PanelDeps): void {
  const { config, store, engine } = deps;
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // ── auth ────────────────────────────────────────────────────────────────
  app.post("/api/login", (req, res) => {
    const user = process.env.PANEL_USER ?? "admin";
    const pass = process.env.PANEL_PASSWORD ?? "pbd";
    const { u, p } = (req.body ?? {}) as { u?: string; p?: string };
    if (u === user && p === pass) {
      const token = createHash("sha256").update(randomBytes(32)).digest("hex");
      sessions.add(token);
      res.setHeader("Set-Cookie", `pbd_sess=${token}; HttpOnly; Path=/; SameSite=Strict`);
      res.json({ ok: true });
      return;
    }
    res.status(401).json({ ok: false });
  });

  app.post("/api/logout", (req, res) => {
    sessions.delete(cookieToken(req));
    res.setHeader("Set-Cookie", "pbd_sess=; HttpOnly; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  // Statik arayüz herkese açık (içinde veri yok; asıl veri /api ve /evidence
  // arkasında korumalı). Auth duvarı onlardan ÖNCE değil, SONRA gelir.
  const candidates = [resolve(__dirname, "public"), resolve(__dirname, "../../src/web/public")];
  const publicDir = candidates.find((p) => existsSync(p));
  if (publicDir) app.use(express.static(publicDir));
  else logger.warn("panel public dir not found — API only");

  // Everything below requires a session.
  app.use((req, res, next) => {
    if (sessions.has(cookieToken(req))) return next();
    res.status(401).json({ error: "auth required" });
  });

  // Evidence screenshots (auth'lu).
  const evidenceDir = resolve(config.output.dir, "evidence");
  app.use("/evidence", express.static(evidenceDir, { fallthrough: false, maxAge: "1h" }));

  // ── dashboard ───────────────────────────────────────────────────────────
  app.get("/api/overview", (_req, res) => {
    res.json({
      engine: engine.status(),
      vault: store.ipTrust.summary(),
      solver: store.solverStats(),
      activity: recentActivity().slice(-40),
    });
  });

  app.get("/api/activity", (_req, res) => {
    res.json({ activity: recentActivity() });
  });

  app.get("/api/calendar", (_req, res) => {
    const status = engine.status();
    const plan = engine.todayPlan().map((item) => ({
      ...item,
      done: engine.planDone(`${item.profileId}|${item.keyword}|${item.scheduledHour}`),
    }));
    const upcoming: Array<{ day: number; quota: number }> = [];
    for (let d = status.rampDay; d < status.rampDay + 10; d++) {
      upcoming.push({ day: d, quota: quotaForDay(d, config) });
    }
    res.json({ ...status, upcoming, plan });
  });

  // ── visits (server-side pagination) ─────────────────────────────────────
  app.get("/api/visits", (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const per = Math.min(100, Math.max(5, Number(req.query.per ?? 20)));
    const { rows, total } = store.visitsPage({
      page,
      per,
      status: typeof req.query.status === "string" && req.query.status ? req.query.status : undefined,
      domain: typeof req.query.domain === "string" && req.query.domain ? req.query.domain : undefined,
      profile: typeof req.query.profile === "string" && req.query.profile ? req.query.profile : undefined,
    });
    res.json({ rows, total, page, pages: Math.max(1, Math.ceil(total / per)) });
  });

  // ── sites management ────────────────────────────────────────────────────
  app.get("/api/sites", (_req, res) => {
    res.json({ sites: store.listSites() });
  });

  app.post("/api/sites", (req, res) => {
    const body = (req.body ?? {}) as { domain?: string; keywords?: string[]; weight?: number };
    const domain = String(body.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const keywords = Array.isArray(body.keywords) ? body.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
    if (!domain || !keywords.length) {
      res.status(400).json({ error: "domain ve en az bir keyword gerekli" });
      return;
    }
    const site = store.addSite(domain, keywords, Math.max(0.1, Number(body.weight ?? 1)));
    logger.info({ domain, keywords }, "site added via panel");
    res.json({ site });
  });

  app.put("/api/sites/:id", (req, res) => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as { weight?: number; keywords?: string[] };
    const input: { weight?: number; keywords?: string[] } = {};
    if (body.weight !== undefined) input.weight = Math.max(0.1, Number(body.weight));
    if (Array.isArray(body.keywords)) {
      input.keywords = body.keywords.map((k) => String(k).trim()).filter(Boolean);
      if (!input.keywords.length) {
        res.status(400).json({ error: "keyword listesi boş olamaz" });
        return;
      }
    }
    store.updateSite(id, input);
    res.json({ sites: store.listSites() });
  });

  app.delete("/api/sites/:id", (req, res) => {
    store.deleteSite(Number(req.params.id));
    res.json({ sites: store.listSites() });
  });

  // ── engine control ──────────────────────────────────────────────────────
  app.post("/api/engine", (req, res) => {
    const enabled = Boolean((req.body ?? {}).enabled);
    engine.setEnabled(enabled);
    res.json({ enabled: engine.isEnabled(), running: engine.status().running });
  });

  app.post("/api/run", (req, res) => {
    const { domain, keyword } = (req.body ?? {}) as { domain?: string; keyword?: string };
    if (!domain) {
      res.status(400).json({ error: "domain gerekli" });
      return;
    }
    const scheduled = engine.runNow(domain, keyword);
    res.json({ scheduled });
  });

  app.post("/api/track", (_req, res) => {
    // Fire-and-forget: one measurement pass over all keywords.
    void (async () => {
      const antidetect = engine.antidetectClient;
      const all = await antidetect.listProfiles().catch(() => []);
      const profile = all[0];
      if (!profile) return;
      const results = await measureAllPositions(config, store, antidetect, profile, effectiveSitesList(store, config)).catch((err) => {
        logger.warn({ err: String(err) }, "track pass failed");
        return [];
      });
      logger.info({ measured: results.length }, "manual track pass done");
    })();
    res.json({ started: true });
  });

  // ── positions / health ──────────────────────────────────────────────────
  app.get("/api/positions", (_req, res) => {
    const latest = store.latestPositions();
    const withTrend = latest.map((p) => ({
      ...p,
      trend: store.positionTrend(p.keyword, p.domain, 30).map((t) => ({
        date: t.date,
        position: t.position,
      })),
    }));
    res.json({ positions: withTrend });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ vault: store.ipTrust.summary(), profiles: store.ipTrust.list(), stats: store.profileStats() });
  });

  const port = config.panel.port;
  app.listen(port, () => {
    logger.info({ port }, "PBD Ops panel listening");
  });
}
