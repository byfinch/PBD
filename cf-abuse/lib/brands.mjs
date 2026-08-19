/**
 * lib/brands.mjs — marka kayitlari (brands.json) + resolver link cozumu.
 * panel.mjs ve resolver.mjs tarafindan kullanilir.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, request as uRequest } from "undici";

const SCRIPT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRANDS = resolve(SCRIPT_DIR, "brands.json");
const tls = new Agent({ connect: { rejectUnauthorized: false } });

export const loadBrands = () => {
  try { return JSON.parse(readFileSync(BRANDS, "utf8")); } catch { return { brands: [] }; }
};
export const saveBrands = (b) => writeFileSync(BRANDS, JSON.stringify(b, null, 1));
export const BRANDS_PATH = BRANDS;

export function brandByName(name) {
  const n = String(name || "").toLowerCase();
  return loadBrands().brands.find((b) => b.name.toLowerCase() === n) || null;
}

export function brandOfficialUrl(name) {
  const b = brandByName(name);
  return b?.officialDomain ? `https://${b.officialDomain}/` : "";
}

/**
 * resolverUrl'yi coz: 3xx zinciri (maks 5 hop) + 200 sayfadaki meta-refresh/js yonlendirme.
 * Donus: { ok, host, chain, status, note } — ok=false ise host guvenilmez (bot korumasi vb).
 */
export async function httpResolve(resolverUrl) {
  const SHORTENERS = /^(dub\.sh|csvera\.link|bit\.ly|tinyurl\.com|t\.co|cutt\.ly|shorturl\.at)$/i;
  let url = resolverUrl;
  const chain = [];
  let status = 0;
  try {
    for (let hop = 0; hop < 5; hop++) {
      const host = new URL(url).hostname;
      chain.push(host);
      const r = await uRequest(url, {
        method: "GET", dispatcher: tls, maxRedirections: 0,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(10000),
      });
      status = r.statusCode;
      if (status >= 300 && status < 400 && r.headers.location) {
        url = new URL(r.headers.location, url).toString();
        await r.body.dump().catch(() => {});
        continue;
      }
      if (status === 200) {
        const html = (await r.body.text()).slice(0, 60000);
        // meta-refresh veya js location yonlendirmesi
        const m = html.match(/url\s*=\s*(https?:\/\/[^"'>\s]+)/i)
          || html.match(/location\.href\s*=\s*["'](https?:\/\/[^"']+)["']/i)
          || html.match(/window\.location(?:\.replace)?\(["']?(https?:\/\/[^"')]+)/i);
        if (m) { url = m[1]; continue; }
        // kisa-link servisi kendi sayfasini verdiyse cozulemedi say
        if (SHORTENERS.test(host)) return { ok: false, host, chain, status, note: "kisaltici ana sayfasi (js-render gerekli)" };
        return { ok: true, host: host.replace(/^www\./, ""), chain, status };
      }
      await r.body.dump().catch(() => {});
      return { ok: false, host, chain, status, note: `http ${status} (bot korumasi olabilir)` };
    }
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (SHORTENERS.test(host)) return { ok: false, host, chain, status, note: "hop limiti, kisalticide kaldi" };
    return { ok: true, host, chain, status };
  } catch (e) {
    return { ok: false, host: chain[chain.length - 1] || "", chain, status, note: String(e.message || e).slice(0, 80) };
  }
}

/** Ekle/guncelle — resolverUrl verildiyse hemen cozmeye calisir. */
export function upsertBrand({ name, resolverUrl, officialDomain }) {
  const store = loadBrands();
  const n = String(name || "").trim();
  const hit = store.brands.find((b) => b.name.toLowerCase() === n.toLowerCase());
  if (hit) {
    if (resolverUrl) hit.resolverUrl = resolverUrl;
    if (officialDomain !== undefined) hit.officialDomain = officialDomain;
    hit.lastResolved = new Date().toISOString();
    saveBrands(store);
    return { entry: hit, created: false };
  }
  const entry = { name: n, resolverUrl: resolverUrl || "", officialDomain: officialDomain || "", lastResolved: new Date().toISOString() };
  store.brands.push(entry);
  saveBrands(store);
  return { entry, created: true };
}

export function removeBrand(name) {
  const store = loadBrands();
  const before = store.brands.length;
  store.brands = store.brands.filter((b) => b.name.toLowerCase() !== String(name || "").toLowerCase());
  saveBrands(store);
  return before - store.brands.length;
}
