import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Agent, fetch as uFetch } from "undici";
import { RawCdp, sleep } from "./rawcdp.mjs";
const PBD = "C:/Users/efsun/Desktop/PBD";
const mapping = JSON.parse(readFileSync(`${PBD}/config/profiles.json`, "utf8"));
for (const line of readFileSync(`${PBD}/.env`, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const tls = new Agent({ connect: { rejectUnauthorized: false } });
const token = (await (await uFetch("https://api.multilogin.com/user/signin", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.MULTILOGIN_EMAIL, password: createHash("md5").update(process.env.MULTILOGIN_PASSWORD).digest("hex") }),
})).json()).data.token;
const p = mapping.profiles.find((x) => x.name === "PBD-08");
const L = "https://launcher.mlx.yt:45001";
async function api(path) {
  const r = await uFetch(L + path, { headers: { Authorization: `Bearer ${token}` }, dispatcher: tls });
  return (await r.json().catch(() => null))?.data;
}
await api(`/api/v1/profile/stop/p/${p.id}`).catch(() => {});
await sleep(3000);
const d = await api(`/api/v2/profile/f/${mapping.folderId}/p/${p.id}/start?automation_type=playwright&headless_mode=false`);
const cdp = await RawCdp.connect(d.port);
await cdp.navigate("https://abuse.cloudflare.com/phishing");
await sleep(25000);

// 1) name'e tikla, zincirle Evidence'a kadar git, isaret yaz
await cdp.clickSelector('[aria-label="Your full name"]', 12);
await sleep(300);
await cdp.typeText("ISIM TESTI", 25);
await cdp.key("Tab"); await cdp.typeText("a@b.com", 20);
await cdp.key("Tab"); await cdp.typeText("a@b.com", 20);
await cdp.key("Tab"); await cdp.key("Tab"); await cdp.key("Tab"); await cdp.key("Tab");
await cdp.typeText("EVIDENCE-MARKER-111", 20);
// 2) Evidence'dan Tab — nereye?
await cdp.key("Tab"); await sleep(400);
await cdp.typeText("TABLI-MARKER-222", 20);
await sleep(500);
await cdp.screenshot("cf-abuse/evidence/dbg-f1.jpg");
console.log("shot1 alindi");
cdp.close();
await api(`/api/v1/profile/stop/p/${p.id}`).catch(() => {});
console.log("BITTI");
