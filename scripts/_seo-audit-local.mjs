#!/usr/bin/env node
/** _seo-audit-local.mjs — lokal IP'den (temiz) site: kapsam + rekabet haritası. */
import { chromium } from "playwright-core";

const QUERIES = ["site:milanbahisde.com", "site:rovbett.com", "milanbahis", "rovbet", "rovbett", "milanbahis giriş", "rovbet giriş", "milanbahis güncel giriş", "rovbet güncel giriş"];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({
  locale: "tr-TR",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
});
await ctx.addCookies([
  { name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" },
  { name: "SOCS", value: "CAESHAgBEhIaAB", domain: ".google.com", path: "/" },
]);
const page = await ctx.newPage();
try {
  for (const q of QUERIES) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=tr&gl=tr&num=10&filter=0&nfpr=1&pws=0`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500 + Math.random() * 1500);
    const data = await page.evaluate(() => {
      const stats = document.querySelector("#result-stats")?.textContent ?? "";
      const out = [];
      for (const a of Array.from(document.querySelectorAll('#rso a[href^="http"]'))) {
        const h = a.querySelector('h3, [role="heading"], [aria-level="3"]');
        if (!h) continue;
        if (a.closest("[data-text-ad], #tads, #tadsb, #tvcap, [data-pcu]")) continue;
        const href = a.href;
        if (!href || /google\.[^/]+\//.test(href)) continue;
        try {
          out.push({ domain: new URL(href).hostname.replace(/^www\./, ""), title: (h.textContent ?? "").trim().slice(0, 70) });
        } catch {}
        if (out.length >= 10) break;
      }
      return { stats, results: out, sorry: location.pathname.includes("/sorry/") };
    });
    console.log(`\n== ${q}${data.stats ? "  [" + data.stats.replace(/\s+/g, " ").slice(0, 50) + "]" : ""}${data.sorry ? "  (SORRY!)" : ""}`);
    data.results.forEach((r, i) => console.log(`  ${i + 1}. ${r.domain.padEnd(32)} ${r.title}`));
    await page.waitForTimeout(4000);
  }
} finally {
  await browser.close();
}
console.log("\n== BITTI");
