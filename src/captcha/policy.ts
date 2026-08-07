import type { AppConfig } from "../config.js";
import type { Store } from "../store/db.js";
import { logger } from "../logger.js";

/**
 * Solver economics — the policy gate in front of every paid solve.
 *
 * PBD skeleton of Detect's policy: the circuit-breaker / distrust-wave logic is
 * intentionally left out; what remains are the two gates that matter at PBD
 * scale (a handful of profiles, organic traffic only):
 *
 *  1) Budget: at most `maxSolvesPerHour` / `maxSolvesPerDay` paid solves.
 *  2) Per-wall attempts: one wall gets at most `maxAttemptsPerWall` paid
 *     attempts before the profile goes to vault cooldown.
 *
 * Counts live in the main pbd.sqlite (solver_calls table) so they survive
 * restarts.
 */

export interface SolveGate {
  ok: boolean;
  reason?: string;
  /** Paid attempts allowed on THIS wall (0 when ok=false). */
  maxAttempts: number;
}

export class SolverPolicy {
  constructor(
    private readonly store: Store,
    private readonly solver: AppConfig["solver"]
  ) {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS solver_calls (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        provider   TEXT NOT NULL,
        profile_id TEXT NOT NULL DEFAULT '',
        outcome    TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  private countSolvesSince(iso: string): number {
    const row = this.store.db
      .prepare(`SELECT COUNT(*) AS n FROM solver_calls WHERE created_at >= ?`)
      .get(iso) as { n: number };
    return row.n;
  }

  /**
   * Call once when a profile hits a /sorry wall, BEFORE any paid attempt.
   */
  shouldSolve(): SolveGate {
    if (!this.solver.enabled) return { ok: false, reason: "solver disabled", maxAttempts: 0 };
    if (!this.solver.twoCaptchaApiKey && !this.solver.capSolverApiKey) {
      return { ok: false, reason: "no solver API key configured", maxAttempts: 0 };
    }
    const now = new Date();
    const hourIso = new Date(now.getTime() - 60 * 60_000).toISOString();
    const dayIso = now.toISOString().slice(0, 10);
    if (this.countSolvesSince(hourIso) >= this.solver.maxSolvesPerHour) {
      return { ok: false, reason: "hourly solver budget exhausted", maxAttempts: 0 };
    }
    if (this.countSolvesSince(dayIso) >= this.solver.maxSolvesPerDay) {
      return { ok: false, reason: "daily solver budget exhausted", maxAttempts: 0 };
    }
    return { ok: true, maxAttempts: this.solver.maxAttemptsPerWall };
  }

  /** Record one paid solve attempt (budget accounting). */
  recordSolve(profileId: string, provider: string, outcome: "cleared" | "persisted" | "no_token"): void {
    try {
      this.store.db
        .prepare(`INSERT INTO solver_calls (provider, profile_id, outcome, created_at) VALUES (?, ?, ?, ?)`)
        .run(provider, profileId, outcome, new Date().toISOString());
    } catch (err) {
      logger.debug({ err: String(err) }, "solver_calls insert failed (ignored)");
    }
  }
}
