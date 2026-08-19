#!/usr/bin/env node
/**
 * inspect-page.mjs — bir profilde sayfa ac, form yapisini dok, screenshot al.
 * kullanim: node inspect-page.mjs <url> [--profile PBD-03] [--wait 8000] [--shot isim]
 */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const args = { _: [] };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[i + 1] ?? true, i++;
  else args._.push(process.argv[i]);
}
const URL0 = args._[0];
const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === (args.profile || "PBD-03"));

const started = await startProfile(profile, mapping.folderId);
console.log("port:", started.port);
const cdp = await RawCdp.connect(started.port);
try {
  await cdp.navigate(URL0);
  await sleep(Number(args.wait || 8000));
  const dump = await cdp.call("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const out = { url: location.href, title: document.title, inputs: [], buttons: [], iframes: [], links: [] };
      document.querySelectorAll("input,select,textarea").forEach(el => out.inputs.push({
        tag: el.tagName, type: el.type, name: el.name, id: el.id, placeholder: el.placeholder,
        aria: el.getAttribute("aria-label"), visible: !!(el.offsetWidth||el.offsetHeight)
      }));
      document.querySelectorAll("button,[role=button],a.btn,input[type=submit]").forEach(el => out.buttons.push({
        tag: el.tagName, type: el.type, text: (el.innerText||el.value||"").trim().slice(0,60), id: el.id,
        visible: !!(el.offsetWidth||el.offsetHeight)
      }));
      document.querySelectorAll("iframe").forEach(f => out.iframes.push({ src: (f.src||"").slice(0,120), title: f.title }));
      document.querySelectorAll("a[href]").forEach(a => { const t=(a.innerText||"").trim(); if (/sign|register|join|api|settings|profile/i.test(t+" "+a.href)) out.links.push({t:t.slice(0,50), href:a.href.slice(0,120)}); });
      out.bodySnippet = document.body.innerText.slice(0, 1500);
      return out;
    })()`,
  });
  console.log(JSON.stringify(dump.result.value, null, 2));
  await cdp.screenshot(resolve(SCRIPT_DIR, "evidence", `inspect-${args.shot || "page"}-${Date.now()}.jpg`), 70, true);
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
