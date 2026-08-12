import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { MultiloginDriver } from "../dist/antidetect/multilogin.js";
import { BrowserSession } from "../dist/browser/session.js";
import { prepareGoogleConsent, openSerp } from "../dist/serp/finder.js";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const config = loadConfig();
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const p = mapping.profiles.find((x) => x.name === (process.argv[2] || "PBD-01"));
const driver = new MultiloginDriver(process.env.MULTILOGIN_BASE_URL, mapping.folderId, process.env.MULTILOGIN_EMAIL, process.env.MULTILOGIN_PASSWORD, 1100);
const ws = await driver.startBrowser(p.id);
const session = await BrowserSession.attach(ws);
try {
  const page = session.page;
  await prepareGoogleConsent(session);
  await openSerp(page, config, "haberler").catch(() => {});
  console.log("url:", page.url().slice(0, 120));
  const info = await page.evaluate(() => {
    const frames = [...document.querySelectorAll("iframe")].map((f) => ({
      src: (f.getAttribute("src") ?? "").slice(0, 90),
      visible: f.getBoundingClientRect().width > 50,
    }));
    const ta = document.querySelector('textarea[name="g-recaptcha-response"], #g-recaptcha-response');
    const grec = document.querySelector(".g-recaptcha[data-sitekey]");
    return {
      title: document.title.slice(0, 80),
      frames,
      hasTextarea: !!ta,
      sitekey: grec?.getAttribute("data-sitekey")?.slice(0, 20) ?? null,
      forms: [...document.querySelectorAll("form")].map((f) => f.getAttribute("action")?.slice(0, 60)),
      bodySnippet: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 300),
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await page.screenshot({ path: "data/_dbg/wall-dump.jpg", type: "jpeg", quality: 70 }).catch(() => {});
} finally {
  await session.detach().catch(() => {});
  await driver.stopBrowser(p.id).catch(() => {});
}
console.log("BITTI");
