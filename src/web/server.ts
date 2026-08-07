import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AppConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { Engine } from "../engine.js";
import { quotaForDay, dayIndexFor } from "../calendar/ramp.js";
import { logger } from "../logger.js";

/**
 * Lightweight ops panel ("PBD Ops").
 *
 * Auth: HTTP Basic with PANEL_USER / PANEL_PASSWORD (default admin/pbd).
 * Views: Takvim (ramp + today's plan), Pozisyonlar (rank trend), Ziyaretler
 * (visit log), Sağlık (IP-trust vault). JSON API only — the static UI in
 * public/ consumes it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PanelDeps {
  config: AppConfig;
  store: Store;
  engine: Engine;
}

function basicAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const user = process.env.PANEL_USER ?? "admin";
  const pass = process.env.PANEL_PASSWORD ?? "pbd";
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const [u, p] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    if (u === user && p === pass) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="PBD Ops"');
  res.status(401).send("auth required");
}

export function startPanel(deps: PanelDeps): void {
  const { config, store, engine } = deps;
  const app = express();
  app.use(basicAuth);

  // Panel assets: dist/web/public next to the compiled server, src fallback for tsx dev.
  const candidates = [resolve(__dirname, "public"), resolve(__dirname, "../../src/web/public")];
  const publicDir = candidates.find((p) => existsSync(p));
  if (publicDir) app.use(express.static(publicDir));
  else logger.warn("panel public dir not found — API only");

  app.get("/api/overview", (_req, res) => {
    res.json({ engine: engine.status(), vault: store.ipTrust.summary() });
  });

  app.get("/api/calendar", (_req, res) => {
    const status = engine.status();
    const plan = engine.todayPlan().map((item) => ({
      ...item,
      done: engine.planDone(`${item.profileId}|${item.keyword}|${item.scheduledHour}`),
    }));
    // Next 10 ramp days for the calendar strip.
    const upcoming: Array<{ day: number; quota: number }> = [];
    for (let d = status.rampDay; d < status.rampDay + 10; d++) {
      upcoming.push({ day: d, quota: quotaForDay(d, config) });
    }
    res.json({ ...status, upcoming, plan });
  });

  app.get("/api/positions", (_req, res) => {
    const latest = store.latestPositions();
    // Attach a short trend (last 30 points) per keyword+domain.
    const withTrend = latest.map((p) => ({
      ...p,
      trend: store.positionTrend(p.keyword, p.domain, 30).map((t) => ({
        date: t.date,
        position: t.position,
      })),
    }));
    res.json({ positions: withTrend });
  });

  app.get("/api/visits", (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
    res.json({ visits: store.recentVisits(limit) });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ vault: store.ipTrust.summary(), profiles: store.ipTrust.list() });
  });

  const port = config.panel.port;
  app.listen(port, () => {
    logger.info({ port }, "PBD Ops panel listening");
  });
}
