#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { Store } from "./store/db.js";
import { createAntidetectClient, selectProfiles } from "./antidetect/client.js";
import { Engine, runVisitOnce, type EngineDeps } from "./engine.js";
import { startPanel } from "./web/server.js";
import { measureAllPositions } from "./rank/tracker.js";
import { dateKey, rampStartDate, todaysPlan } from "./calendar/ramp.js";
import { logger } from "./logger.js";

/**
 * PBD — organic SERP SEO-signal automation.
 *
 * Commands:
 *   web          start the ops panel + scheduler loop
 *   visit --once run a single trial visit (next due plan item, or forced)
 *   track        one rank-measurement pass over all keywords (no clicks)
 *   profiles     list the antidetect profile pool
 */

function makeDeps(): EngineDeps {
  const config = loadConfig();
  const store = new Store(config.output.dir);
  const antidetect = createAntidetectClient(config);
  return { config, store, antidetect };
}

const program = new Command();
program.name("pbd").description("Organic SERP SEO-signal automation").version("0.1.0");

program
  .command("web")
  .description("Start the ops panel + scheduler loop")
  .action(async () => {
    const deps = makeDeps();
    const engine = new Engine(deps);
    await engine.init();
    engine.start();
    startPanel({ ...deps, engine });
    logger.info({ port: deps.config.panel.port }, "PBD running — panel + engine");
    // Keep the process alive; graceful shutdown on signals.
    const shutdown = () => {
      engine.stop();
      deps.store.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("visit")
  .description("Run visits")
  .option("--once", "run exactly one visit (next due plan item)")
  .option("--profile <id>", "force a specific profile id")
  .option("--keyword <kw>", "force a specific keyword")
  .option("--site <domain>", "force a specific target domain")
  .action(async (opts: { once?: boolean; profile?: string; keyword?: string; site?: string }) => {
    const deps = makeDeps();
    const engine = new Engine(deps);
    await engine.init();

    const all = await deps.antidetect.listProfiles();
    const pool = selectProfiles(all, deps.config);
    if (!pool.length) {
      logger.error("no antidetect profiles matched config.profiles filters");
      process.exit(1);
    }

    // Default: first item of today's plan; flags override any part of it.
    const startDate = rampStartDate(deps.store, deps.config);
    const plan = todaysPlan(dateKey(), pool, deps.config, startDate);
    const base = plan[0];
    const profile = opts.profile ? pool.find((p) => p.id === opts.profile) : pool.find((p) => p.id === base?.profileId);
    const site = deps.config.sites.find((s) => s.domain === opts.site) ?? deps.config.sites[0]!;
    const keyword = opts.keyword ?? base?.keyword ?? site.keywords[0]!;
    if (!profile) {
      logger.error({ profile: opts.profile }, "profile not found in pool");
      process.exit(1);
    }

    const item = {
      profileId: profile.id,
      profileName: profile.name,
      keyword,
      targetDomain: opts.site ?? base?.targetDomain ?? site.domain,
      scheduledHour: new Date().getHours(),
    };
    logger.info({ item }, "running single trial visit");
    await runVisitOnce(deps, item, profile);
    deps.store.close();
    process.exit(0);
  });

program
  .command("track")
  .description("Measure organic positions for all keywords (no clicks)")
  .action(async () => {
    const deps = makeDeps();
    const all = await deps.antidetect.listProfiles();
    const pool = selectProfiles(all, deps.config);
    const profile = pool[0];
    if (!profile) {
      logger.error("no antidetect profiles available for tracking");
      process.exit(1);
    }
    const results = await measureAllPositions(deps.config, deps.store, deps.antidetect, profile);
    for (const r of results) {
      logger.info({ keyword: r.keyword, domain: r.domain, position: r.position }, "position");
    }
    deps.store.close();
    process.exit(0);
  });

program
  .command("profiles")
  .description("List the antidetect profile pool")
  .action(async () => {
    const deps = makeDeps();
    const up = await deps.antidetect.isUp();
    if (!up) {
      logger.error({ driver: deps.antidetect.driver }, "antidetect local API is not reachable");
      process.exit(1);
    }
    const all = await deps.antidetect.listProfiles();
    const pool = selectProfiles(all, deps.config);
    for (const p of pool) {
      logger.info({ id: p.id, name: p.name, proxy: p.proxy ? `${p.proxy.type}://${p.proxy.host}:${p.proxy.port}` : "—" }, "profile");
    }
    logger.info({ total: all.length, pooled: pool.length }, "pool");
    deps.store.close();
    process.exit(0);
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err: String(err) }, "fatal");
  process.exit(1);
});
