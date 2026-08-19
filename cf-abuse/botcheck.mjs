import { RawCdp, sleep } from "./rawcdp.mjs";
import { loadProfiles, startProfile, stopProfile } from "./lib/mlx.mjs";
const mapping = loadProfiles();
const profile = mapping.profiles.find((x) => x.name === (process.argv[2] || "PBD-08"));
const started = await startProfile(profile, mapping.folderId);
const cdp = await RawCdp.connect(started.port);
try {
  await cdp.navigate("https://bot.sannysoft.com");
  await sleep(10000);
  const r = await cdp.call("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const rows = {};
      document.querySelectorAll("table tr").forEach(tr => {
        const tds = tr.querySelectorAll("td");
        if (tds.length >= 2) rows[tds[0].innerText.trim()] = tds[1].innerText.trim();
      });
      return { webdriver: navigator.webdriver, ua: navigator.userAgent.slice(0,80), rows };
    })()`,
  });
  console.log(JSON.stringify(r.result.value, null, 2));
  await cdp.screenshot("evidence/botcheck.jpg", 70, true);
} finally { cdp.close(); await stopProfile(profile.id); }
