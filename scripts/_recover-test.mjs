#!/usr/bin/env node
/** _recover-test.mjs — duvara git, recoverFromSorry'yi tam logla çalıştır. */
import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { Store } from "../dist/store/db.js";
import { SolverPolicy } from "../dist/captcha/policy.js";
import { recoverFromSorry, pageLooksLikeCaptcha } from "../dist/captcha/recovery.js";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";
import { BrowserSession } from "../dist/browser/session.js";
import { prepareGoogleConsent, openSerp } from "../dist/serp/finder.js";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const config = loadConfig();
config.solver.enabled = true;
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find((x) => x.name === (process.argv[2] || "PBD-01"));
const driver = new MultiloginDriver(process.env.MULTILOGIN_BASE_URL, mapping.folderId, process.env.MULTILOGIN_EMAIL, process.env.MULTILOGIN_PASSWORD, 1100);
const profile = { id: p.id, name: p.name, proxy: { host: "79.127.168.43", port: 50100, user: p.proxyLogin, password: "uDdliaN2SU", type: "HTTP" } };
const ws = await driver.startBrowser(p.id);
const session = await BrowserSession.attach(ws);
const store = new Store("./data");
const policy = new SolverPolicy(store, config.solver);
try {
  const page = session.page;
  await prepareGoogleConsent(session);
  await openSerp(page, config, "haberler").catch(() => {});
  console.log("duvar mı:", await pageLooksLikeCaptcha(page), "| url:", page.url().slice(0, 80));
  const r = await recoverFromSorry(page, config, profile, store.ipTrust, policy);
  console.log("RECOVERY:", JSON.stringify(r));
  console.log("son url:", page.url().slice(0, 100));
  await page.screenshot({ path: "data/_dbg/recover-after.jpg", type: "jpeg", quality: 70 }).catch(() => {});
} finally {
  await session.detach().catch(() => {});
  const stopped = await driver.stopBrowser(p.id).then(() => true).catch((e) => String(e));
  console.log("stopBrowser:", stopped === true ? "OK" : stopped);
  store.db.close();
}
console.log("BITTI");
