#!/usr/bin/env node
/**
 * mlx-sorry-test.mjs — canli /sorry cozum testi.
 * Gercek driver (MultiloginDriver) + gercek recovery (recoverFromSorry) ile
 * bir profilde Google duvarini cozmeyi dener.
 * Kullanim: node scripts/mlx-sorry-test.mjs [PBD-08]
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { loadConfig } from "../dist/config.js";
import { Store } from "../dist/store/db.js";
import { SolverPolicy } from "../dist/captcha/policy.js";
import { recoverFromSorry, pageLooksLikeCaptcha, isRealSerp } from "../dist/captcha/recovery.js";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";

const name = process.argv[2] || "PBD-08";
const config = loadConfig();
config.solver.enabled = true;

const k2 = config.solver.twoCaptchaApiKey;
const kc = config.solver.capSolverApiKey;
console.log(`solver: provider=${config.solver.provider} 2captcha=${k2 ? "OK(" + k2.slice(0, 4) + "..)" : "YOK"} capsolver=${kc ? "OK(" + kc.slice(0, 4) + "..)" : "YOK"}`);
if (!k2 && !kc) {
  console.log("HATA: solver anahtari yok (.env)");
  process.exit(1);
}

const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find((x) => x.name === name);
if (!p) {
  console.log("profil yok:", name);
  process.exit(1);
}

const driver = new MultiloginDriver(
  process.env.MULTILOGIN_BASE_URL || "https://launcher.mlx.yt:45001",
  mapping.folderId,
  process.env.MULTILOGIN_EMAIL || "",
  process.env.MULTILOGIN_PASSWORD || "",
  1100
);

// proxy-seller kimligi (solver IP-eslesmesi icin)
const profile = {
  id: p.id,
  name: p.name,
  proxy: {
    host: "79.127.168.43",
    port: 50101,
    user: p.proxyLogin,
    password: "uDdliaN2SU",
    type: "SOCKS5",
  },
};

console.log(`== ${p.name} start`);
const ws = await driver.startBrowser(p.id);
console.log("cdp OK:", ws.slice(0, 60));

const browser = await chromium.connectOverCDP(ws, { timeout: 15000 });
const store = new Store("./data");
try {
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const res = await page.goto("https://www.google.com/search?q=ucak+bileti&hl=tr&gl=tr", {
    timeout: 45000,
    waitUntil: "domcontentloaded",
  });
  console.log(`google: http ${res?.status()} url: ${page.url().slice(0, 70)}`);

  const wall = await pageLooksLikeCaptcha(page);
  console.log("duvar var mi:", wall);
  if (!wall) {
    console.log("SONUC: duvar yok — IP temiz gorunuyor");
  } else {
    console.log("== cozum deneniyor (2-3 dk surebilir)...");
    const policy = new SolverPolicy(store, config.solver);
    const result = await recoverFromSorry(page, config, profile, store.ipTrust, policy);
    console.log("recovery:", JSON.stringify(result));
    const serp = await isRealSerp(page).catch(() => false);
    console.log(`SONUC: ${result.cleared && serp ? "DUVAR COZULDU" : "duvar duruyor"} — url: ${page.url().slice(0, 70)}`);
  }
} finally {
  await browser.close().catch(() => {});
  await driver.stopBrowser(p.id).catch(() => {});
  store.db.close();
}
console.log("== BITTI");
