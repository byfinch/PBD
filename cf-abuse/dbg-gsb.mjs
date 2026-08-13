#!/usr/bin/env node
// dbg-gsb.mjs — GSB formunun gercek DOM'unu dok (butonlar, dropdownlar, inputlar)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Agent, fetch as uFetch } from "undici";
import { RawCdp, sleep } from "./rawcdp.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PBD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(resolve(PBD, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const mapping = JSON.parse(readFileSync(resolve(PBD, "config/profiles.json"), "utf8"));
const profile = mapping.profiles.find((x) => x.name === (process.argv[2] || "PBD-01"));
const tls = new Agent({ connect: { rejectUnauthorized: false } });
const mlxToken = (await (await uFetch("https://api.multilogin.com/user/signin", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.MULTILOGIN_EMAIL, password: createHash("md5").update(process.env.MULTILOGIN_PASSWORD).digest("hex") }),
})).json())?.data?.token;
const L = "https://launcher.mlx.yt:45001";
const lapi = async (p) => (await (await uFetch(L + p, { headers: { Authorization: `Bearer ${mlxToken}` }, dispatcher: tls })).json().catch(() => null))?.data;

await lapi(`/api/v1/profile/stop/p/${profile.id}`).catch(() => {});
await sleep(4000);
let started = null;
for (let a = 1; a <= 6 && !started; a++) {
  const r = await uFetch(`${L}/api/v2/profile/f/${mapping.folderId}/p/${profile.id}/start?automation_type=playwright&headless_mode=false`, { headers: { Authorization: `Bearer ${mlxToken}` }, dispatcher: tls });
  const j = await r.json().catch(() => null);
  if (j?.data?.port) started = j.data; else await sleep(6000);
}
const cdp = await RawCdp.connect(started.port);
await cdp.navigate("https://safebrowsing.google.com/safebrowsing/report_phish/?url=https%3A%2F%2Fexample.com%2F");
await sleep(8000);

const doc = await cdp.call("DOM.getDocument", { depth: -1 });
for (const sel of ["button", "mat-select", "[role='combobox']", "input", "textarea", "select"]) {
  const q = await cdp.call("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: sel });
  console.log(`\n=== ${sel} (${q.nodeIds?.length ?? 0}) ===`);
  for (const nid of (q.nodeIds ?? []).slice(0, 10)) {
    const h = (await cdp.call("DOM.getOuterHTML", { nodeId: nid })).outerHTML ?? "";
    console.log(" *", h.slice(0, 220).replace(/\s+/g, " "));
  }
}
// dropdown'u ac, secenekleri dok
const q2 = await cdp.call("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "mat-select, [role='combobox']" });
if (q2.nodeIds?.length) {
  const b = await cdp.boxForNode(q2.nodeIds[Math.min(1, q2.nodeIds.length - 1)]);
  if (b) { await cdp.click(b.x + 60, b.y + b.h / 2); await sleep(1500); }
  const doc2 = await cdp.call("DOM.getDocument", { depth: -1 });
  for (const sel of ["mat-option", "[role='option']"]) {
    const q3 = await cdp.call("DOM.querySelectorAll", { nodeId: doc2.root.nodeId, selector: sel });
    console.log(`\n=== acik secenekler ${sel} (${q3.nodeIds?.length ?? 0}) ===`);
    for (const nid of (q3.nodeIds ?? []).slice(0, 12)) {
      const h = (await cdp.call("DOM.getOuterHTML", { nodeId: nid })).outerHTML ?? "";
      console.log(" *", h.slice(0, 160).replace(/\s+/g, " "));
    }
  }
}
cdp.close();
await lapi(`/api/v1/profile/stop/p/${profile.id}`).catch(() => {});
console.log("\nBITTI");
process.exit(0);
