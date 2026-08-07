import { logger } from "../logger.js";
import { sleep } from "../util/time.js";

/**
 * reCAPTCHA v2 solver integration (2captcha + CapSolver), tuned for Google's
 * /sorry/ unusual-traffic wall. Only the API v2 createTask/getTaskResult paths
 * are implemented — the classic in.php fallback was dropped for PBD (data-s is
 * one-shot; a structured-field path is the only one worth paying for).
 */

export interface RecaptchaSolveOpts {
  pollMs?: number;
  timeoutMs?: number;
  enterprise?: boolean;
  /** Per-session data-s from Google's sorry-page .g-recaptcha (required for google.com). */
  dataS?: string;
  /** User-Agent of the browser that hit the captcha wall. */
  userAgent?: string;
  /** Proxy the browser is using, so workers solve from the same IP: `user:pass@host:port`. */
  proxy?: string;
  proxytype?: "HTTP" | "HTTPS" | "SOCKS4" | "SOCKS5";
}

export interface RecaptchaSolveResult {
  token: string;
  jobId: string;
  provider: "2captcha" | "capsolver";
  /** How long we waited for the worker (ms). Google data-s ages hard after ~100s. */
  waitMs: number;
}

export interface MultiProviderSolveOpts extends RecaptchaSolveOpts {
  /** CapSolver first when "auto" (faster for Google data-s). */
  provider?: "2captcha" | "capsolver" | "auto";
  twoCaptchaApiKey?: string;
  capSolverApiKey?: string;
}

/**
 * Parse `user:pass@host:port` or `host:port`.
 * Password may contain `:` — only split userinfo on the FIRST colon.
 */
function parseProxy(proxy: string): {
  address: string;
  port: number;
  login?: string;
  password?: string;
} | null {
  const raw = proxy.trim();
  if (!raw) return null;
  let userinfo: string | null = null;
  let hostport = raw;
  const at = raw.lastIndexOf("@");
  if (at > 0) {
    userinfo = raw.slice(0, at);
    hostport = raw.slice(at + 1);
  }
  const portSep = hostport.lastIndexOf(":");
  if (portSep <= 0) return null;
  const address = hostport.slice(0, portSep);
  const port = parseInt(hostport.slice(portSep + 1), 10);
  if (!address || !Number.isFinite(port) || port <= 0) return null;
  let login: string | undefined;
  let password: string | undefined;
  if (userinfo != null) {
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      login = userinfo.slice(0, colon);
      password = userinfo.slice(colon + 1);
    } else {
      login = userinfo;
      password = "";
    }
  }
  return { address, port, login, password };
}

async function solveVia2Captcha(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  opts: RecaptchaSolveOpts
): Promise<RecaptchaSolveResult | null> {
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 150_000;
  const parsed = opts.proxy ? parseProxy(opts.proxy) : null;
  const enterprise = !!opts.enterprise;

  let type: string;
  if (enterprise) {
    type = parsed ? "RecaptchaV2EnterpriseTask" : "RecaptchaV2EnterpriseTaskProxyless";
  } else {
    type = parsed ? "RecaptchaV2Task" : "RecaptchaV2TaskProxyless";
  }

  const task: Record<string, unknown> = { type, websiteURL: pageUrl, websiteKey: siteKey };
  if (opts.dataS) {
    if (enterprise) task.enterprisePayload = { s: opts.dataS };
    else task.recaptchaDataSValue = opts.dataS;
  }
  if (opts.userAgent) task.userAgent = opts.userAgent;
  if (parsed) {
    task.proxyType = (opts.proxytype ?? "SOCKS5").toLowerCase();
    task.proxyAddress = parsed.address;
    task.proxyPort = parsed.port;
    if (parsed.login) task.proxyLogin = parsed.login;
    if (parsed.password !== undefined) task.proxyPassword = parsed.password;
  }

  const createRes = await fetch("https://api.2captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = (await createRes.json()) as {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
    taskId?: number | string;
  };
  if (created.errorId !== 0 || created.taskId == null) {
    logger.warn(
      { errorCode: created.errorCode, errorDescription: created.errorDescription, type },
      "2captcha createTask rejected"
    );
    return null;
  }
  const taskId = String(created.taskId);
  logger.info({ jobId: taskId, type, hasDataS: !!opts.dataS, hasProxy: !!parsed }, "2captcha job accepted");

  const started = Date.now();
  await sleep(5_000);
  while (Date.now() - started < timeoutMs) {
    const res = await fetch("https://api.2captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      errorId: number;
      status?: string;
      errorCode?: string;
      errorDescription?: string;
      solution?: { gRecaptchaResponse?: string; token?: string };
    };
    if (json.errorId !== 0) {
      logger.warn({ jobId: taskId, errorCode: json.errorCode, errorDescription: json.errorDescription }, "2captcha getTaskResult error");
      return null;
    }
    if (json.status === "ready") {
      const token = json.solution?.gRecaptchaResponse || json.solution?.token;
      if (!token) {
        logger.warn({ jobId: taskId }, "2captcha ready but empty token");
        return null;
      }
      const waitMs = Date.now() - started;
      logger.info({ jobId: taskId, waitMs, tokenLen: token.length }, "2captcha token ready");
      return { token, jobId: taskId, provider: "2captcha", waitMs };
    }
    await sleep(pollMs);
  }
  logger.warn({ jobId: taskId }, "2captcha solve timed out");
  return null;
}

async function solveViaCapSolver(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  opts: RecaptchaSolveOpts
): Promise<RecaptchaSolveResult | null> {
  const pollMs = opts.pollMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const parsed = opts.proxy ? parseProxy(opts.proxy) : null;
  const enterprise = !!opts.enterprise;

  let type: string;
  if (enterprise) {
    type = parsed ? "ReCaptchaV2EnterpriseTask" : "ReCaptchaV2EnterpriseTaskProxyLess";
  } else {
    type = parsed ? "ReCaptchaV2Task" : "ReCaptchaV2TaskProxyLess";
  }

  const task: Record<string, unknown> = { type, websiteURL: pageUrl, websiteKey: siteKey };
  if (opts.dataS) {
    if (enterprise) task.enterprisePayload = { s: opts.dataS };
    else task.recaptchaDataSValue = opts.dataS;
  }
  if (opts.userAgent) task.userAgent = opts.userAgent;
  // CapSolver proxy format (docs): socks5:ip:port:user:pass — single string field.
  if (parsed) {
    const scheme = (opts.proxytype ?? "SOCKS5").toLowerCase().replace("https", "http");
    task.proxy =
      parsed.login != null && parsed.login !== ""
        ? `${scheme}:${parsed.address}:${parsed.port}:${parsed.login}:${parsed.password ?? ""}`
        : `${scheme}:${parsed.address}:${parsed.port}`;
  }

  const createRes = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = (await createRes.json()) as {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
    taskId?: string;
  };
  if (created.errorId !== 0 || !created.taskId) {
    logger.warn(
      { errorCode: created.errorCode, errorDescription: created.errorDescription, type },
      "CapSolver createTask rejected"
    );
    return null;
  }
  const taskId = String(created.taskId);
  logger.info({ jobId: taskId, type, hasDataS: !!opts.dataS, hasProxy: !!parsed }, "CapSolver job accepted");

  const started = Date.now();
  await sleep(3_000);
  while (Date.now() - started < timeoutMs) {
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      errorId: number;
      status?: string;
      errorCode?: string;
      errorDescription?: string;
      solution?: { gRecaptchaResponse?: string; token?: string };
    };
    if (json.errorId !== 0) {
      logger.warn({ jobId: taskId, errorCode: json.errorCode, errorDescription: json.errorDescription }, "CapSolver getTaskResult error");
      return null;
    }
    if (json.status === "ready") {
      const token = json.solution?.gRecaptchaResponse || json.solution?.token;
      if (!token) {
        logger.warn({ jobId: taskId }, "CapSolver ready but empty token");
        return null;
      }
      const waitMs = Date.now() - started;
      logger.info({ jobId: taskId, waitMs, tokenLen: token.length }, "CapSolver token ready");
      return { token, jobId: taskId, provider: "capsolver", waitMs };
    }
    await sleep(pollMs);
  }
  logger.warn({ jobId: taskId }, "CapSolver solve timed out");
  return null;
}

/**
 * Google /sorry solver: provider order per `provider` opt ("auto" = CapSolver
 * first, then 2captcha). IMPORTANT: data-s is one-shot — once a provider
 * accepted a job, do NOT send the same data-s to the other provider; on null,
 * the caller must reload for a fresh challenge.
 */
export async function solveRecaptchaMulti(
  siteKey: string,
  pageUrl: string,
  opts: MultiProviderSolveOpts = {}
): Promise<RecaptchaSolveResult | null> {
  const provider = opts.provider ?? "auto";
  const capKey = opts.capSolverApiKey ?? "";
  const twoKey = opts.twoCaptchaApiKey ?? "";

  const order: Array<"capsolver" | "2captcha"> =
    provider === "capsolver"
      ? ["capsolver"]
      : provider === "2captcha"
        ? ["2captcha"]
        : capKey
          ? twoKey
            ? ["capsolver", "2captcha"]
            : ["capsolver"]
          : ["2captcha"];

  for (const p of order) {
    if (p === "capsolver") {
      if (!capKey) continue;
      logger.info({ provider: "capsolver" }, "trying captcha provider");
      try {
        const r = await solveViaCapSolver(capKey, siteKey, pageUrl, opts);
        if (r) return r;
        if (opts.dataS) {
          logger.warn("CapSolver failed after data-s job — not chaining 2captcha on same data-s");
          return null;
        }
      } catch (err) {
        logger.warn({ err: String(err) }, "CapSolver request failed");
        if (opts.dataS) return null;
      }
    } else {
      if (!twoKey) continue;
      logger.info({ provider: "2captcha" }, "trying captcha provider");
      try {
        const r = await solveVia2Captcha(twoKey, siteKey, pageUrl, opts);
        if (r) return r;
        if (opts.dataS) return null;
      } catch (err) {
        logger.warn({ err: String(err) }, "2captcha request failed");
        if (opts.dataS) return null;
      }
    }
  }
  return null;
}

/** Tell 2captcha a token was rejected so they refund / retrain. */
export async function reportIncorrect(apiKey: string, jobId: string): Promise<void> {
  if (!apiKey || !jobId) return;
  try {
    await fetch("https://api.2captcha.com/reportIncorrect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: jobId }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  } catch {
    /* non-fatal */
  }
}
