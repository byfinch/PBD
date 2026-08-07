import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { IpTrustStore } from "./ipTrust.js";

export type VisitStatus = "visited" | "missed" | "captcha" | "error" | "skipped";

export interface VisitRow {
  id: number;
  date: string;
  profileId: string;
  profileName: string;
  siteDomain: string;
  keyword: string;
  position: number | null;
  status: VisitStatus;
  dwellMs: number;
  internalClicks: number;
  error: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface PositionRow {
  id: number;
  date: string;
  keyword: string;
  domain: string;
  position: number | null;
  device: string;
  measuredAt: string;
}

/**
 * SQLite store backed by Node's built-in `node:sqlite` (no native build needed).
 * One database file (pbd.sqlite) holds operational state, the rank history and
 * the IP-trust vault.
 */
export class Store {
  readonly db: DatabaseSync;
  readonly ipTrust: IpTrustStore;

  constructor(outputDir: string) {
    mkdirSync(outputDir, { recursive: true });
    const dbPath = resolve(outputDir, "pbd.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.ipTrust = new IpTrustStore(this.db);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sites (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        domain     TEXT NOT NULL UNIQUE,
        weight     REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS keywords (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        keyword    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(site_id, keyword)
      );

      CREATE TABLE IF NOT EXISTS visits (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        date          TEXT NOT NULL,
        profile_id    TEXT NOT NULL,
        profile_name  TEXT NOT NULL DEFAULT '',
        site_domain   TEXT NOT NULL,
        keyword       TEXT NOT NULL,
        position      INTEGER,
        status        TEXT NOT NULL,
        dwell_ms      INTEGER NOT NULL DEFAULT 0,
        internal_clicks INTEGER NOT NULL DEFAULT 0,
        error         TEXT NOT NULL DEFAULT '',
        started_at    TEXT NOT NULL,
        finished_at   TEXT
      );

      CREATE TABLE IF NOT EXISTS positions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        date        TEXT NOT NULL,
        keyword     TEXT NOT NULL,
        domain      TEXT NOT NULL,
        position    INTEGER,
        device      TEXT NOT NULL DEFAULT 'desktop',
        measured_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_visits_date    ON visits(date);
      CREATE INDEX IF NOT EXISTS idx_visits_profile ON visits(profile_id, date);
      CREATE INDEX IF NOT EXISTS idx_positions_key  ON positions(keyword, domain, date);
    `);
  }

  // ── meta kv ─────────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  // ── sites & keywords (mirrored from config for query convenience) ──────

  syncSites(sites: Array<{ domain: string; keywords: string[]; weight: number }>): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      const siteStmt = this.db.prepare(
        `INSERT INTO sites (domain, weight, created_at) VALUES (?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET weight = excluded.weight`
      );
      const kwStmt = this.db.prepare(
        `INSERT INTO keywords (site_id, keyword, created_at) VALUES (?, ?, ?)
         ON CONFLICT(site_id, keyword) DO NOTHING`
      );
      for (const s of sites) {
        siteStmt.run(s.domain, s.weight, now);
        const row = this.db.prepare(`SELECT id FROM sites WHERE domain = ?`).get(s.domain) as { id: number };
        for (const kw of s.keywords) kwStmt.run(row.id, kw, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── visits ──────────────────────────────────────────────────────────────

  startVisit(input: {
    date: string;
    profileId: string;
    profileName: string;
    siteDomain: string;
    keyword: string;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO visits (date, profile_id, profile_name, site_domain, keyword, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'error', ?)`
      )
      .run(input.date, input.profileId, input.profileName, input.siteDomain, input.keyword, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  finishVisit(
    visitId: number,
    outcome: {
      status: VisitStatus;
      position?: number | null;
      dwellMs?: number;
      internalClicks?: number;
      error?: string;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE visits SET status = ?, position = ?, dwell_ms = ?, internal_clicks = ?, error = ?, finished_at = ?
         WHERE id = ?`
      )
      .run(
        outcome.status,
        outcome.position ?? null,
        outcome.dwellMs ?? 0,
        outcome.internalClicks ?? 0,
        (outcome.error ?? "").slice(0, 500),
        new Date().toISOString(),
        visitId
      );
  }

  /** Visits attempted today for a profile (any status except 'skipped'). */
  countVisitsToday(profileId: string, date: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM visits WHERE profile_id = ? AND date = ? AND status != 'skipped'`)
      .get(profileId, date) as { n: number };
    return row.n;
  }

  /** Total visits attempted today across all profiles. */
  countVisitsForDate(date: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM visits WHERE date = ? AND status != 'skipped'`)
      .get(date) as { n: number };
    return row.n;
  }

  recentVisits(limit = 200): VisitRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM visits ORDER BY id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      date: String(r.date),
      profileId: String(r.profile_id),
      profileName: String(r.profile_name ?? ""),
      siteDomain: String(r.site_domain),
      keyword: String(r.keyword),
      position: r.position == null ? null : Number(r.position),
      status: String(r.status) as VisitStatus,
      dwellMs: Number(r.dwell_ms ?? 0),
      internalClicks: Number(r.internal_clicks ?? 0),
      error: String(r.error ?? ""),
      startedAt: String(r.started_at),
      finishedAt: (r.finished_at as string) ?? null,
    }));
  }

  // ── positions (rank history) ────────────────────────────────────────────

  insertPosition(input: {
    date: string;
    keyword: string;
    domain: string;
    position: number | null;
    device: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO positions (date, keyword, domain, position, device, measured_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(input.date, input.keyword, input.domain, input.position, input.device, new Date().toISOString());
  }

  /** Position trend for a keyword+domain pair (oldest first). */
  positionTrend(keyword: string, domain: string, limit = 90): PositionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM positions WHERE keyword = ? AND domain = ? ORDER BY measured_at DESC LIMIT ?`
      )
      .all(keyword, domain, limit) as Record<string, unknown>[];
    return rows.reverse().map((r) => this.positionRowFromDb(r));
  }

  /** Latest measured position per keyword+domain pair. */
  latestPositions(): PositionRow[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM positions p
         JOIN (SELECT keyword, domain, MAX(measured_at) AS m FROM positions GROUP BY keyword, domain) latest
           ON latest.keyword = p.keyword AND latest.domain = p.domain AND latest.m = p.measured_at
         ORDER BY p.domain, p.keyword`
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.positionRowFromDb(r));
  }

  private positionRowFromDb(r: Record<string, unknown>): PositionRow {
    return {
      id: Number(r.id),
      date: String(r.date),
      keyword: String(r.keyword),
      domain: String(r.domain),
      position: r.position == null ? null : Number(r.position),
      device: String(r.device ?? "desktop"),
      measuredAt: String(r.measured_at),
    };
  }

  close(): void {
    this.db.close();
  }
}
