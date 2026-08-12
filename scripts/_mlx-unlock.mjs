import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const EMAIL = process.env.MULTILOGIN_EMAIL;
const PASS = process.env.MULTILOGIN_PASSWORD;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const shot = (n) => page.screenshot({ path: `data/_dbg/mlx-${n}.png` }).catch(() => {});
try {
  await page.goto("https://app.multilogin.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(4000);
  console.log("url:", page.url());
  console.log("title:", await page.title());
  await shot("1-landing");
  // Login form doldur
  const email = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
  const pass = page.locator('input[type="password"]').first();
  if (await email.count()) {
    await email.fill(EMAIL);
    await pass.fill(PASS);
    await shot("2-filled");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null),
      page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Giriş")').first().click(),
    ]);
    await page.waitForTimeout(6000);
  }
  console.log("login sonrası url:", page.url());
  await shot("3-after-login");
  // Browser profilleri sekmesine geç (Mobile sekmesi boş)
  await page.locator('text=Browser').first().click().catch(() => {});
  await page.waitForTimeout(4000);
  console.log("browser tab url:", page.url());
  await shot("4-profiles");
  // API çağrılarını yakala — unlock/lock endpoint'ini bulmak için
  page.on("request", (r) => {
    if (/multilogin|bpds/i.test(r.url()) && !/\.(js|css|png|svg|woff)/.test(r.url()))
      console.log("REQ", r.method(), r.url().slice(0, 160));
  });
  page.on("response", (r) => {
    if (/multilogin|bpds/i.test(r.url()) && !/\.(js|css|png|svg|woff)/.test(r.url()))
      console.log("RES", r.status(), r.url().slice(0, 160));
  });
  // PBD-08 satırını bul
  const row = page.locator('tr[data-testid="browser-profile-row"]', { hasText: "PBD-08" }).first();
  if (await row.count()) {
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.hover();
    await page.waitForTimeout(1500);
    await shot("5-row-hover");
    await row.locator('button:has(mat-icon), [class*=menu], [class*=action]').last().click().catch(async () => {
      await row.locator('td').last().click().catch(() => {});
    });
    await page.waitForTimeout(1500);
    await shot("6-menu");
    // "Start headless" → kilit diyaloğu / unlock çağrısı tetikler mi?
    await page.locator('text=Start headless').first().click().catch(() => {});
    await page.waitForTimeout(6000);
    await shot("7-after-start");
    const overlay = await page.evaluate(() => {
      const m = document.querySelector('.cdk-overlay-container');
      return m ? m.textContent?.slice(0, 500) : "";
    });
    console.log("overlay:", JSON.stringify(overlay));
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log("body:", JSON.stringify(bodyText));
  } else {
    console.log("PBD-08 listede bulunamadı — body snippet:");
    console.log((await page.evaluate(() => document.body.innerText)).slice(0, 800));
  }
} finally {
  await browser.close().catch(() => {});
}
console.log("BITTI");
