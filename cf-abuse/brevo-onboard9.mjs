#!/usr/bin/env node
/** brevo-onboard9.mjs — combobox panel takibi ile country secimi */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-onboard9-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

async function typeInto(sel, text) {
  await cdp.focusSelector(sel);
  await sleep(400);
  await cdp.typeText(text, 50);
  await sleep(400);
}

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(12000);
  for (let i = 0; i < 10; i++) { if (await ev(`!!document.getElementById("address")`)) break; await sleep(3000); }
  await typeInto("#address", "Mumhane Caddesi No 12 Karakoy");
  await typeInto("#zip_code", "34425");
  await typeInto("#city", "Istanbul");

  // role=button olan kontrole koordinat tikla
  const ctrlBox = await ev(`(() => {
    const el = document.querySelector('[class*="sib-selectmenu-control___"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  console.log("control box:", JSON.stringify(ctrlBox));
  await cdp.click(ctrlBox.x + ctrlBox.w / 2, ctrlBox.y + ctrlBox.h / 2);
  await sleep(3000);
  const panel = await ev(`(() => {
    const p = document.querySelector('[id^="sib-selectmenu--panel"]');
    if (!p) return { found: false, expanded: document.getElementById("select-menu-input").getAttribute("aria-expanded") };
    const r = p.getBoundingClientRect();
    return { found: true, expanded: document.getElementById("select-menu-input").getAttribute("aria-expanded"),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height }, text: (p.innerText||"").slice(0,200), html: p.outerHTML.length };
  })()`);
  console.log("panel:", JSON.stringify(panel, null, 1));
  await shot(cdp, "01-panel");

  if (panel?.found && panel.rect?.h > 20) {
    // Turkey secenegini panel icinde bul
    const tr = await ev(`(() => {
      const p = document.querySelector('[id^="sib-selectmenu--panel"]');
      const els = [...p.querySelectorAll("*")].filter(e => e.children.length === 0 && /^turkey$/i.test((e.textContent||"").trim()));
      if (!els.length) {
        // scroll gerekebilir — panelde Turkey'ye kadar kaydir
        const opts = [...p.querySelectorAll('[role="option"], li, [class*="option"]')];
        const t = opts.find(o => /turkey/i.test(o.textContent||""));
        if (t) { t.scrollIntoView({ block: "center" }); }
        return null;
      }
      const r = els[0].getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    console.log("turkey:", JSON.stringify(tr));
    if (tr) {
      await cdp.click(tr.x + tr.w / 2, tr.y + tr.h / 2);
      await sleep(1500);
    } else {
      await sleep(1500);
      const tr2 = await ev(`(() => {
        const p = document.querySelector('[id^="sib-selectmenu--panel"]');
        const els = [...p.querySelectorAll("*")].filter(e => (e.offsetWidth||e.offsetHeight) && /^turkey$/i.test((e.textContent||"").trim()));
        if (!els.length) return null;
        const r = els[0].getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`);
      console.log("turkey2:", JSON.stringify(tr2));
      if (tr2) { await cdp.click(tr2.x + tr2.w / 2, tr2.y + tr2.h / 2); await sleep(1500); }
    }
    console.log("country v:", await ev(`document.getElementById("select-menu-input").value`));
    console.log("selected text:", await ev(`(document.querySelector('[class*="selected-value"]")||{}).innerText`));
    await shot(cdp, "02-selected");
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
