/**
 * twocaptcha.mjs — 2Captcha reCAPTCHA v2 token cozucu
 */
export async function solveRecaptchaV2({ apiKey, sitekey, pageurl, invisible = false, timeoutMs = 180000 }) {
  const inUrl = `https://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${encodeURIComponent(pageurl)}${invisible ? "&invisible=1" : ""}&json=1`;
  const r1 = await (await fetch(inUrl)).json();
  if (r1.status !== 1) throw new Error("2captcha in: " + r1.request);
  const id = r1.request;
  const t0 = Date.now();
  await new Promise((s) => setTimeout(s, 15000));
  while (Date.now() - t0 < timeoutMs) {
    const r2 = await (await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${id}&json=1`)).json();
    if (r2.status === 1) return r2.request;
    if (r2.request !== "CAPCHA_NOT_READY") throw new Error("2captcha res: " + r2.request);
    await new Promise((s) => setTimeout(s, 5000));
  }
  throw new Error("2captcha timeout");
}
