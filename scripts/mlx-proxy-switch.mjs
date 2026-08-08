#!/usr/bin/env node
/**
 * mlx-proxy-switch.mjs v2 — socks5:50101 -> http:50100 (parameters'li govde).
 * Once PBD-01'de govde varyantlarini dener, tutani tum havuza uygular.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const email = process.env.MULTILOGIN_EMAIL || "";
const password = process.env.MULTILOGIN_PASSWORD || "";
const mapping = JSON.parse(readFileSync("config/profiles.json", "utf8"));

const token = (await (
  await fetch("https://api.multilogin.com/user/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: createHash("md5").update(password).digest("hex") }),
  })
).json())?.data?.token;
if (!token) { console.log("SIGNIN FAIL"); process.exit(1); }
console.log("token OK");

const proxyOf = (p) => ({
  type: "http",
  host: "79.127.168.43",
  port: 50100,
  username: p.proxyLogin,
  password: "uDdliaN2SU",
});

const shapes = {
  A: (p) => ({ profile_id: p.id, parameters: { proxy: proxyOf(p), flags: { proxy_masking: "custom" } } }),
  B: (p) => ({
    profile_id: p.id,
    parameters: { name: p.name, folder_id: mapping.folderId, proxy: proxyOf(p), flags: { proxy_masking: "custom" } },
  }),
  C: (p) => ({ parameters: { profile_id: p.id, proxy: proxyOf(p), flags: { proxy_masking: "custom" } } }),
};

async function update(p, shape) {
  const res = await fetch("https://api.multilogin.com/profile/update", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(shapes[shape](p)),
  });
  const text = await res.text();
  const ok = res.status === 200 && !/"error_code"\s*:\s*"[A-Z]/.test(text);
  return { ok, text: text.slice(0, 140) };
}

// 1) PBD-01'de dogru govd emi bul
const probe = mapping.profiles[0];
let winner = null;
for (const shape of Object.keys(shapes)) {
  const r = await update(probe, shape);
  console.log(`deneme ${shape}: ${r.ok ? "OK" : "FAIL"} ${r.text}`);
  if (r.ok) { winner = shape; break; }
  await new Promise((s) => setTimeout(s, 500));
}
if (!winner) { console.log("HICBIR GOVDE TUTMADI"); process.exit(1); }

// 2) kazanan govdeyi tum havuza uygula
console.log(`== kazanan: ${winner} — tum havuza uygulaniyor`);
for (const p of mapping.profiles.slice(1)) {
  const r = await update(p, winner);
  console.log(`${r.ok ? "OK  " : "FAIL"} ${p.name} ${r.ok ? "" : r.text}`);
  await new Promise((s) => setTimeout(s, 700));
}
console.log("== BITTI");
