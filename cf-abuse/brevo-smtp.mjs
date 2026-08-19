#!/usr/bin/env node
/** brevo-smtp.mjs — SMTP & API sayfasindan SMTP key uret/yakala */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const CREDS = resolve(EV, "brevo-creds.json");
const creds = JSON.parse(readFileSync(CREDS, "utf8"));
const shot = (cdp, tag) => cdp.screenshot(resolve(EV, `brevo-smtp-${tag}-${Date.now()}.jpg`), 70, true);

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

try {
  await cdp.navigate("https://app.brevo.com/settings/keys/smtp");
  await sleep(15000);
  await shot(cdp, "01-smtp-page");
  const d1 = await ev(`(() => {
    const inputs = [...document.querySelectorAll("input")].filter(i => i.type !== "hidden").map(i => ({ id: i.id, name: i.name, type: i.type, v: (i.value||"").slice(0,60), ro: i.readOnly }));
    const buttons = [...document.querySelectorAll("button")].filter(b => b.offsetWidth||b.offsetHeight).map(b => (b.innerText||"").trim().slice(0,50)).filter(Boolean);
    return { url: location.href, text: document.body.innerText.slice(0, 1200), inputs, buttons: buttons.slice(0, 20) };
  })()`);
  console.log(JSON.stringify(d1, null, 1));
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
