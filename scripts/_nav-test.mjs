import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find(x => x.name === (process.argv[2] || "PBD-02"));
const driver = new MultiloginDriver(process.env.MULTILOGIN_BASE_URL, mapping.folderId, process.env.MULTILOGIN_EMAIL, process.env.MULTILOGIN_PASSWORD, 1100);
const ws = await driver.startBrowser(p.id);
console.log("start OK");
const browser = await chromium.connectOverCDP(ws, { timeout: 40000 });
const page = browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].newPage());
page.on("crash", () => console.log("!! PAGE CRASH"));
for (const url of ["about:blank", "https://example.com", "https://www.google.com/?hl=tr"]) {
  try {
    const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(url, "->", r?.status() ?? "blank");
  } catch (e) {
    console.log(url, "-> CRASH:", String(e).split("\n")[0].slice(0, 70));
    break;
  }
}
await browser.close().catch(() => {});
await driver.stopBrowser(p.id).catch(() => {});
console.log("BITTI");
