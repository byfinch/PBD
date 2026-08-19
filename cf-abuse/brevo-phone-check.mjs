#!/usr/bin/env node
/** brevo-phone-check.mjs — Generate SMTP key tikla, telefon modalini yakinindan incele */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

try {
  await cdp.navigate("https://app.brevo.com/settings/keys/smtp");
  await sleep(15000);
  const b = await ev(`(() => {
    const el = [...document.querySelectorAll("button")].find(x => /generate smtp key/i.test(x.innerText||"") && (x.offsetWidth||x.offsetHeight));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  await cdp.click(b.x + b.w / 2, b.y + b.h / 2);
  await sleep(3500);
  await cdp.screenshot(resolve(EV, `brevo-phone-${Date.now()}.jpg`), 70, true);
  const dlg = await ev(`(() => {
    // gorunur modal/dialog ara
    const modals = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]')]
      .filter(m => m.offsetWidth && m.offsetHeight)
      .map(m => ({ cls: (m.className||"").toString().slice(0,60), text: (m.innerText||"").slice(0,500) }));
    const phone = document.getElementById("phone-verification-input");
    const phoneVisible = phone ? !!(phone.offsetWidth || phone.offsetHeight) : null;
    const btns = [...document.querySelectorAll('[role="dialog"] button, [class*="modal"] button')]
      .filter(x => x.offsetWidth || x.offsetHeight).map(x => (x.innerText||"").trim().slice(0,40));
    return { modals: modals.slice(0,3), phoneVisible, dlgButtons: btns };
  })()`);
  console.log(JSON.stringify(dlg, null, 1));
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
