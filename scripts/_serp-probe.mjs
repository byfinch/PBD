import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";
import { BrowserSession } from "../dist/browser/session.js";
import { prepareGoogleConsent, openSerp } from "../dist/serp/finder.js";
import { pageLooksLikeCaptcha } from "../dist/captcha/recovery.js";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const config = loadConfig();
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find(x => x.name === (process.argv[2] || "PBD-02"));
const driver = new MultiloginDriver(process.env.MULTILOGIN_BASE_URL, mapping.folderId, process.env.MULTILOGIN_EMAIL, process.env.MULTILOGIN_PASSWORD, 1100);
const ws = await driver.startBrowser(p.id);
const session = await BrowserSession.attach(ws);
try {
  const page = session.page;
  await prepareGoogleConsent(session);
  const ok = await openSerp(page, config, "milanbahis");
  console.log("openSerp:", ok);
  console.log("url:", page.url());
  console.log("title:", await page.title().catch(() => "?"));
  console.log("captcha?", await pageLooksLikeCaptcha(page));
  const txt = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  console.log("body[0:600]:", JSON.stringify(txt.slice(0, 600)));
  console.log("rso:", await page.evaluate(() => !!document.querySelector("#rso")));
  await page.screenshot({ path: "data/_dbg/serp-probe.jpg", type: "jpeg", quality: 60 }).catch(() => {});
} finally {
  await session.detach().catch(() => {});
  await driver.stopBrowser(p.id).catch(() => {});
}
console.log("BITTI");
