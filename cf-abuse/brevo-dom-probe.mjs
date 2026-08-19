#!/usr/bin/env node
/** brevo-dom-probe.mjs — country wrapper DOM yapisi */
import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";

const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === "PBD-02");
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
const ev = (expr) => cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

try {
  await cdp.navigate("https://onboarding.brevo.com/account/register/complete-profile?redirectTo=https%3A%2F%2Fapp.brevo.com%2F");
  await sleep(12000);
  for (let i = 0; i < 10; i++) { if (await ev(`!!document.getElementById("address")`)) break; await sleep(3000); }
  const out = await ev(`(() => {
    const inp = document.getElementById("select-menu-input");
    if (!inp) return "input yok";
    let chain = [];
    let el = inp;
    for (let i = 0; i < 6 && el; i++) {
      chain.push({ tag: el.tagName, id: el.id, cls: (el.className||"").toString().slice(0,80), role: el.getAttribute("role"),
        pe: getComputedStyle(el).pointerEvents, ro: el.readOnly ?? undefined });
      el = el.parentElement;
    }
    // komsu svg/button
    const wrapper = inp.closest("div");
    const siblings = wrapper ? [...wrapper.parentElement.children].map(c => ({ tag: c.tagName, cls: (c.className||"").toString().slice(0,60) })) : [];
    // gizli select var mi
    const selects = [...document.querySelectorAll("select")].map(s => ({ id: s.id, opts: s.options.length, visible: !!(s.offsetWidth||s.offsetHeight) }));
    // react props anahtarlari
    const rk = Object.keys(inp).filter(k => k.startsWith("__react"));
    return { chain, siblings, selects, reactKeys: rk, outerStart: inp.outerHTML.slice(0, 300) };
  })()`);
  console.log(JSON.stringify(out, null, 1));
} finally {
  cdp.close();
  await stopProfile(profile.id);
}
