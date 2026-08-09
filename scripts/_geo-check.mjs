import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find(x=>x.name==="PBD-02");
const driver = new MultiloginDriver(process.env.MULTILOGIN_BASE_URL, mapping.folderId, process.env.MULTILOGIN_EMAIL, process.env.MULTILOGIN_PASSWORD, 1100);
const ws = await driver.startBrowser(p.id);
const browser = await chromium.connectOverCDP(ws, { timeout: 40000 });
try {
  const page = browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].newPage());
  // 1) Geolocation API ne donuyor
  await page.goto("https://www.google.com/?hl=tr&gl=tr", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  const bodyText = await page.evaluate(() => document.body.innerText);
  const m = bodyText.match(/(Ninnescah[^-]*|Türkiye|İstanbul|Kansas|[A-Za-zÇçĞğİıÖöŞşÜü ]+ - Cihazınızdan)/);
  console.log("footer konum:", m ? m[0].trim().slice(0, 80) : "bulunamadi");
  // 2) izin istenirse ne oluyor (block testi)
  const perm = await page.evaluate(async () => {
    try {
      const r = await navigator.permissions.query({ name: "geolocation" });
      return r.state;
    } catch (e) { return "sorgulanamadi"; }
  });
  console.log("geolocation izin durumu:", perm);
} finally {
  await browser.close().catch(() => {});
  await driver.stopBrowser(p.id).catch(() => {});
}
