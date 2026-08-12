import type { Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import type { AntidetectProfile } from "../antidetect/client.js";
import type { IpTrustStore, TrustCookie } from "../store/ipTrust.js";
import { SolverPolicy } from "./policy.js";
import { solveRecaptchaMulti, reportIncorrect } from "./solver.js";
import { logger } from "../logger.js";
import { randInt, sleep } from "../util/time.js";

/**
 * Google /sorry recovery, PBD skeleton.
 *
 * Flow: detect wall → policy gate → extract sitekey + one-shot data-s →
 * solveRecaptchaMulti → submit token via in-page callback/form → confirm the
 * real SERP → vault marks (markSolved / markSolverFailed).
 *
 * Deliberately simpler than Detect's recovery: no image-captcha OCR path, no
 * provider circuit breaker, no full-GET fallback. Those can be ported back if
 * live runs show the simple path is not enough.
 */

/** Google data-s ages hard — a token older than this is discarded, not submitted. */
const DATA_S_MAX_WAIT_MS = 90_000;
const SOLVE_TIMEOUT_MS = 150_000;

/** /sorry/ URL or visible unusual-traffic wall. */
export async function pageLooksLikeCaptcha(page: Page): Promise<boolean> {
  if (page.url().includes("/sorry/")) return true;
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      if (/unusual traffic|olağan dışı trafik|olagan disi trafik|robot değilim|i'?m not a robot/.test(text)) return true;
      if (document.querySelector('form[action*="sorry"]')) return true;
      if (document.querySelector('input[name="captcha"]')) return true;
      if (document.querySelector('.g-recaptcha, iframe[src*="recaptcha/api2"], iframe[src*="/recaptcha/"]')) return true;
      return false;
    });
  } catch {
    // During navigation evaluate can throw — treat as still blocked (never false-success).
    return true;
  }
}

/** Strict success: off /sorry/ AND no captcha wall visible. */
export async function isRealSerp(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("/sorry/")) return false;
  if (!/google\.[^/]+\/search/i.test(url) && !url.includes("/search?")) {
    if (!/google\./i.test(url)) return false;
  }
  return !(await pageLooksLikeCaptcha(page));
}

interface RecaptchaPageParams {
  key: string | null;
  dataS: string | null;
  enterprise: boolean;
  callback: string | null;
  formFields: Record<string, string>;
}

/** Pull sitekey, one-shot data-s, and form fields from the sorry page. */
async function extractRecaptchaParams(page: Page): Promise<RecaptchaPageParams> {
  return page.evaluate(() => {
    const el = document.querySelector(".g-recaptcha") as HTMLElement | null;
    const iframe = document.querySelector('iframe[src*="recaptcha"]') as HTMLIFrameElement | null;
    let key = el?.getAttribute("data-sitekey") ?? null;
    if (!key && iframe) {
      const m = iframe.src.match(/[?&]k=([^&]+)/);
      if (m) key = decodeURIComponent(m[1]!);
    }
    let dataS = el?.getAttribute("data-s") ?? null;
    if (!dataS && iframe) {
      const m = iframe.src.match(/[?&]s=([^&]+)/);
      if (m) dataS = decodeURIComponent(m[1]!);
    }
    const iframeSrc = iframe?.src ?? "";
    const enterprise =
      /recaptcha\/enterprise/i.test(iframeSrc) ||
      (/google\.(com|com\.tr)/i.test(location.hostname) && /\/sorry\//i.test(location.pathname));

    const form = (document.getElementById("captcha-form") ||
      document.querySelector('form[action*="index"], form[action*="sorry"], form')) as HTMLFormElement | null;
    const formFields: Record<string, string> = {};
    if (form) {
      const inputs = form.querySelectorAll("input, textarea, select");
      for (let i = 0; i < inputs.length; i++) {
        const inp = inputs[i] as HTMLInputElement;
        const name = inp.name || inp.id;
        if (!name) continue;
        if (inp.type === "submit" || inp.type === "button" || inp.type === "image") continue;
        formFields[name] = inp.value ?? "";
      }
    }
    return {
      key,
      dataS,
      enterprise,
      callback: el?.getAttribute("data-callback") ?? null,
      formFields,
    };
  });
}

/** Inject the token and fire the widget callback / submit the captcha form. */
async function submitToken(page: Page, token: string, callback: string | null): Promise<boolean> {
  const submitted = await page
    .evaluate(
      ({ t, cbName }: { t: string; cbName: string | null }) => {
        const form = (document.getElementById("captcha-form") ||
          document.querySelector('form[action*="index"], form[action*="sorry"], form')) as HTMLFormElement | null;

        const setTokenOn = (ta: HTMLTextAreaElement | HTMLInputElement) => {
          ta.value = t;
          if ("innerHTML" in ta) (ta as HTMLTextAreaElement).innerHTML = t;
          ta.setAttribute("value", t);
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
        };

        const nodes = document.querySelectorAll(
          'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea[id*="g-recaptcha-response"], input[name="g-recaptcha-response"]'
        );
        if (nodes.length) {
          nodes.forEach((n) => setTokenOn(n as HTMLTextAreaElement));
        } else if (form) {
          const ta = document.createElement("textarea");
          ta.name = "g-recaptcha-response";
          ta.id = "g-recaptcha-response";
          ta.style.display = "none";
          form.appendChild(ta);
          setTokenOn(ta);
        }

        if (cbName) {
          const fn = (window as unknown as Record<string, unknown>)[cbName];
          if (typeof fn === "function") {
            try {
              (fn as (tok: string) => void)(t);
              return "callback";
            } catch {
              /* fall through */
            }
          }
        }

        const btn = document.querySelector(
          '#captcha-form input[type="submit"], #captcha-form button[type="submit"], #recaptcha-submit'
        ) as HTMLElement | null;
        if (btn) {
          btn.click();
          return "click";
        }
        if (form) {
          form.submit();
          return "submit";
        }
        return false;
      },
      { t: token, cbName: callback }
    )
    .catch(() => false as const);

  if (!submitted) return false;
  logger.info({ via: submitted }, "submitted captcha token via in-page callback/form");
  await sleep(4_000);
  // Callback formu GÖNDERMEYEBİLİR (sadece submit butonunu açar): hâlâ
  // duvardaysak submit butonuna/form'a düş.
  if (!(await isRealSerp(page))) {
    const kicked = await page
      .evaluate(() => {
        const btn = document.querySelector(
          '#captcha-form input[type="submit"], #captcha-form button[type="submit"], #recaptcha-submit, form[action*="sorry"] input[type="submit"], form[action*="index"] input[type="submit"]'
        ) as HTMLElement | null;
        if (btn) {
          btn.click();
          return "click";
        }
        const form = document.querySelector('form[action*="sorry"], form[action*="index"], form') as HTMLFormElement | null;
        if (form) {
          form.submit();
          return "submit";
        }
        return false;
      })
      .catch(() => false as const);
    if (kicked) logger.info({ via: kicked }, "callback sonrası form submit fallback");
    await sleep(8_000);
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  return isRealSerp(page);
}

/** Snapshot Google trust cookies for the vault after a successful solve. */
async function googleTrustCookies(page: Page): Promise<TrustCookie[]> {
  try {
    const cookies = await page.context().cookies();
    return cookies
      .filter((c) => /google\./i.test(c.domain) && /^(GOOGLE_ABUSE_EXEMPTION|NID|__Secure-ENID|AEC|SOCS|CONSENT)$/i.test(c.name))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" }));
  } catch {
    return [];
  }
}

export interface RecoveryResult {
  cleared: boolean;
  /** True when a wall was present at all (false = nothing to recover). */
  hadWall: boolean;
  reason?: string;
}

/**
 * Ücretsiz ilk şans: reCAPTCHA checkbox'ına insan gibi tık. Gerçek tarayıcı
 * parmak izi + davranış güvenli görünürse Google puzzle açmadan geçirir;
 * /sorry formu token dolunca kendiliğinden (ya da bizim submit'imizle) düşer.
 * Görsel puzzle (bframe) açılırsa vazgeçilir — ücretli solver'a düşülür.
 */
async function tryNaturalCheckbox(page: Page): Promise<boolean> {
  try {
    const anchor = page
      .frameLocator('iframe[src*="recaptcha"][src*="anchor"]')
      .first();
    const box = anchor.locator(".recaptcha-checkbox-border").first();
    if ((await box.count()) === 0) return false;
    await box.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => {});
    await sleep(randInt(700, 1_600));
    await box.click({ timeout: 5_000 });

    const tokenLength = () =>
      page
        .evaluate(
          () =>
            (document.querySelector('textarea[name="g-recaptcha-response"], #g-recaptcha-response') as HTMLTextAreaElement | null)
              ?.value?.length ?? 0
        )
        .catch(() => 0);

    let solved = false;
    // bframe (puzzle) iframe'i sayfada her zaman render edilir — görünürlük
    // kontrolü güvenilir değil. Tek objektif sinyal: token dolması. Puzzle
    // açılırsa token hiç gelmez ve 12 sn sonra vazgeçilir.
    for (let i = 0; i < 12; i++) {
      await sleep(1_000);
      if ((await tokenLength()) > 50) {
        solved = true;
        break;
      }
    }
    if (!solved) return false;

    // /sorry formu çoğu zaman auto-submit eder; etmediyse buton/form düş.
    await sleep(3_000);
    if (!(await isRealSerp(page))) {
      await page
        .evaluate(() => {
          const btn = document.querySelector(
            '#captcha-form input[type="submit"], #captcha-form button[type="submit"], #recaptcha-submit, form[action*="sorry"] input[type="submit"], form[action*="index"] input[type="submit"]'
          ) as HTMLElement | null;
          if (btn) {
            btn.click();
            return;
          }
          (document.querySelector('form[action*="sorry"], form[action*="index"], form') as HTMLFormElement | null)?.submit();
        })
        .catch(() => {});
      await sleep(6_000);
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    return isRealSerp(page);
  } catch (err) {
    logger.debug({ err: String(err) }, "natural checkbox attempt failed");
    return false;
  }
}

/**
 * Detect and (when allowed) solve a Google /sorry wall on the current page.
 * Updates the IP-trust vault either way; the caller treats a non-cleared wall
 * as a visit failure for this profile. The engine owns one SolverPolicy per
 * run and passes it in.
 */
export async function recoverFromSorry(
  page: Page,
  config: AppConfig,
  profile: AntidetectProfile,
  vault: IpTrustStore,
  policy: SolverPolicy
): Promise<RecoveryResult> {
  if (!(await pageLooksLikeCaptcha(page))) return { cleared: true, hadWall: false };

  // Ücretli çözümden ÖNCE bedava şans: doğal checkbox tıklaması. Profilin
  // gerçek parmak izi güvenliyse duvar burada düşer (bütçe harcanmaz).
  await page
    .waitForSelector('iframe[src*="recaptcha"][src*="anchor"]', { timeout: 10_000 })
    .catch(() => {});
  if (await tryNaturalCheckbox(page)) {
    vault.markSolved(profile.id, await googleTrustCookies(page));
    logger.info("captcha wall cleared via natural checkbox (no paid solve)");
    return { cleared: true, hadWall: true };
  }

  const gate = policy.shouldSolve();
  if (!gate.ok) {
    logger.warn({ profileId: profile.id, reason: gate.reason }, "captcha wall — policy says no solve, cooldown");
    vault.markSolverFailed(profile.id, gate.reason ?? "policy gate", { maxCooldownMinutes: 30 });
    return { cleared: false, hadWall: true, reason: gate.reason };
  }

  vault.markRecovering(profile.id);
  const proxyStr = profile.proxy
    ? profile.proxy.user
      ? `${profile.proxy.user}:${profile.proxy.password ?? ""}@${profile.proxy.host}:${profile.proxy.port}`
      : `${profile.proxy.host}:${profile.proxy.port}`
    : undefined;

  for (let attempt = 1; attempt <= gate.maxAttempts; attempt++) {
    await page
      .waitForSelector('.g-recaptcha[data-sitekey], iframe[src*="recaptcha"]', { timeout: 15_000 })
      .catch(() => {});
    if (await isRealSerp(page)) {
      vault.markClean(profile.id);
      return { cleared: true, hadWall: true };
    }

    let rc = await extractRecaptchaParams(page).catch(() => null);
    if (!rc?.key) {
      // Geç render ya da text-only varyant: bir kez bekle + reload ile taze
      // challenge şansı ver, yine yoksa bu duvar çözülemez.
      logger.warn({ attempt }, "sorry wall present but no reCAPTCHA sitekey found — wait + reload");
      await sleep(randInt(15_000, 25_000));
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await page
        .waitForSelector('.g-recaptcha[data-sitekey], iframe[src*="recaptcha"]', { timeout: 15_000 })
        .catch(() => {});
      rc = await extractRecaptchaParams(page).catch(() => null);
      if (!rc?.key) {
        logger.warn({ attempt }, "still no sitekey after reload — unsolvable wall variant");
        break;
      }
    }

    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
    const solved = await solveRecaptchaMulti(rc.key, page.url(), {
      enterprise: rc.enterprise,
      dataS: rc.dataS ?? undefined,
      userAgent,
      proxy: proxyStr,
      proxytype: profile.proxy?.type,
      timeoutMs: SOLVE_TIMEOUT_MS,
      pollMs: 1_500,
      provider: config.solver.provider,
      capSolverApiKey: config.solver.capSolverApiKey,
      twoCaptchaApiKey: config.solver.twoCaptchaApiKey,
    });

    if (!solved) {
      policy.recordSolve(profile.id, config.solver.provider === "2captcha" ? "2captcha" : "capsolver", "no_token");
      logger.warn({ attempt }, "solver returned no token — reloading for fresh challenge");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await sleep(2_000);
      continue;
    }

    // Stale data-s: discard, do not submit, do not reportbad.
    if (solved.waitMs > DATA_S_MAX_WAIT_MS) {
      logger.warn({ attempt, waitMs: solved.waitMs }, "token wait exceeded data-s budget — discarding");
      policy.recordSolve(profile.id, solved.provider, "no_token");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await sleep(2_000);
      continue;
    }

    const cleared = await submitToken(page, solved.token, rc.callback);
    if (cleared) {
      policy.recordSolve(profile.id, solved.provider, "cleared");
      vault.markSolved(profile.id, await googleTrustCookies(page));
      logger.info({ attempt, provider: solved.provider, waitMs: solved.waitMs }, "captcha wall cleared via solver");
      return { cleared: true, hadWall: true };
    }

    policy.recordSolve(profile.id, solved.provider, "persisted");
    if (solved.provider === "2captcha") {
      await reportIncorrect(config.solver.twoCaptchaApiKey, solved.jobId);
    }
    logger.warn({ attempt, provider: solved.provider }, "token submitted but wall persisted — fresh challenge next");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await sleep(2_000);
  }

  vault.markSolverFailed(profile.id, "solver exhausted on /sorry wall", { maxCooldownMinutes: 30 });
  return { cleared: false, hadWall: true, reason: "solver exhausted" };
}
