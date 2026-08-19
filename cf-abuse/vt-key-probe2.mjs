#!/usr/bin/env node
/** vt-key-probe2.mjs — "This is your personal key" bilesenini dok, gercek key'i bul */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EV = resolve(SCRIPT_DIR, "evidence");
const CREDS = resolve(EV, "vt-creds.json");
const creds = JSON.parse(readFileSync(CREDS, "utf8"));

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-08");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => r.result.value);

try {
  await cdp.navigate("https://www.virustotal.com/gui/my-apikey");
  await sleep(15000);
  // 1) session cookie ile kendi API'sinden key'i cekmeyi dene
  const viaApi = await ev(`fetch("/api/v3/users/current", { credentials: "include" })
    .then(r => r.json()).then(j => j?.data?.attributes?.apikey || j?.data?.attributes?.api_key || JSON.stringify(Object.keys(j?.data?.attributes||{}))).catch(e => "ERR:" + e)`);
  console.log("api/v3 users/current:", viaApi);

  // 2) olmazsa DOM'dan: blur'lu alani bul
  if (!/^[0-9a-f]{64}$/i.test(viaApi || "")) {
    const dom = await ev(`(() => {
      // "personal key" metnini iceren bileseni bul, ic HTML dok
      let hit = null;
      const walk = (root, depth) => {
        if (hit || depth > 12) return;
        for (const el of root.querySelectorAll("*")) {
          if (!hit && el.children.length < 40 && /personal key/i.test(el.textContent || "") && (el.textContent||"").length < 2000) hit = el;
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        }
      };
      walk(document, 0);
      if (!hit) return "YOK";
      const hexes = (hit.innerHTML.match(/[0-9a-f]{64}/gi) || []);
      const blurred = [];
      for (const el of hit.querySelectorAll("*")) {
        const f = getComputedStyle(el).filter;
        if (f && f !== "none") blurred.push({ tag: el.tagName, text: (el.textContent||"").slice(0,90), filter: f });
      }
      return { hexes: [...new Set(hexes)].slice(0,5), blurred: blurred.slice(0,5) };
    })()`);
    console.log("dom:", JSON.stringify(dom, null, 1));
  }
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
