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
// DSA label'i bul
const doc = await cdp.call("DOM.getDocument", { depth: -1 });
const q = await cdp.call("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "label" });
let dsaNode = null;
for (const nid of q.nodeIds ?? []) {
  const html = (await cdp.call("DOM.getOuterHTML", { nodeId: nid })).outerHTML ?? "";
  if (/DSA certification/i.test(html)) { dsaNode = nid; break; }
}
console.log("dsaNode:", dsaNode);
if (dsaNode) {
  await cdp.cdp("DOM.scrollIntoViewIfNeeded", { nodeId: dsaNode }).catch(() => {});
  await sleep(1200);
  const lm = await cdp.call("Page.getLayoutMetrics", {});
  const bm = await cdp.call("DOM.getBoxModel", { nodeId: dsaNode });
  const vw = lm.visualViewport ?? {};
  const c = bm.model.content;
  const bx = c[0] - (vw.pageX ?? 0), by = c[1] - (vw.pageY ?? 0);
  console.log("box viewport:", Math.round(bx), Math.round(by), "w:", c[2]-c[0], "h:", c[5]-c[1]);
  await cdp.screenshot("cf-abuse/evidence/dbg-dsa-pre.jpg");
  await cdp.click(bx + 12, by + 12);
  await sleep(900);
  await cdp.screenshot("cf-abuse/evidence/dbg-dsa-post.jpg");
  const html = (await cdp.call("DOM.getOuterHTML", { nodeId: dsaNode })).outerHTML ?? "";
  console.log("checked mi:", /data-state="checked"|aria-checked="true"/.test(html));
}
cdp.close();
await api(`/api/v1/profile/stop/p/${p.id}`).catch(() => {});
console.log("BITTI");
