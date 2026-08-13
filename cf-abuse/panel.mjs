#!/usr/bin/env node
/**
 * cf-abuse panel — bagimsiz sikayet paneli (PBD panelinden ayrik).
 * Port: 3090 (env PANEL_PORT ile degisir). Login: PANEL_USER/PANEL_PASSWORD.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import express from "express";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG = resolve(SCRIPT_DIR, "reports.jsonl");
const PORT = Number(process.env.PANEL_PORT ?? 3090);
const USER = process.env.PANEL_USER ?? "admin";
const PASS = process.env.PANEL_PASSWORD ?? "pbd2026";

const sessions = new Set();
const activity = [];
let running = null;

function log(text) {
  activity.push({ ts: new Date().toISOString(), text });
  if (activity.length > 200) activity.splice(0, activity.length - 200);
}

const app = express();
app.use(express.json({ limit: "128kb" }));

app.post("/api/login", (req, res) => {
  const { u, p } = req.body ?? {};
  if (u === USER && p === PASS) {
    const t = createHash("sha256").update(randomBytes(32)).digest("hex");
    sessions.add(t);
    res.setHeader("Set-Cookie", `cfa_sess=${t}; HttpOnly; Path=/; SameSite=Strict`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});
app.post("/api/logout", (req, res) => {
  const m = (req.headers.cookie ?? "").match(/cfa_sess=([^;]+)/);
  if (m) sessions.delete(decodeURIComponent(m[1]));
  res.setHeader("Set-Cookie", "cfa_sess=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.use(express.static(resolve(SCRIPT_DIR, "public")));

app.use((req, res, next) => {
  const m = (req.headers.cookie ?? "").match(/cfa_sess=([^;]+)/);
  if (m && sessions.has(decodeURIComponent(m[1]))) return next();
  res.status(401).json({ error: "auth" });
});

app.use("/evidence", express.static(resolve(SCRIPT_DIR, "evidence"), { fallthrough: false }));

app.get("/api/state", (_req, res) => {
  const reports = [];
  if (existsSync(LOG)) {
    for (const line of readFileSync(LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { reports.push(JSON.parse(line)); } catch {}
    }
  }
  res.json({ running, activity: activity.slice(-60), reports: reports.reverse().slice(0, 200) });
});

app.post("/api/report", (req, res) => {
  if (running) return res.status(409).json({ error: `zaten calisiyor: ${running}` });
  const { target, official, brand } = req.body ?? {};
  if (!target || !official) return res.status(400).json({ error: "sahte url + resmi url gerekli" });
  running = target;
  log(`>> sikayet basladi: ${target} (${brand || "-"})`);
  const ch = spawn("node", [resolve(SCRIPT_DIR, "report.mjs"), "--target", target, "--official", official, "--brand", brand ?? ""], { cwd: SCRIPT_DIR });
  ch.stdout.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => log(l.trim())));
  ch.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => log("[!] " + l.trim().slice(0, 140))));
  ch.on("close", () => { log(`>> bitti: ${target}`); running = null; });
  res.json({ started: true });
});

app.listen(PORT, () => console.log(`cf-abuse panel: http://localhost:${PORT} (${USER})`));
