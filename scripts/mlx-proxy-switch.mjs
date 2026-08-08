#!/usr/bin/env node
/**
 * mlx-proxy-switch.mjs — 10 profilin proxy'sini socks5:50101 -> http:50100'a cevirir.
 * Sebep: socks5 endpoint'i flap yapiyor, http endpoint stabil (canli olcumlendi).
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

const signinRes = await fetch("https://api.multilogin.com/user/signin", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: createHash("md5").update(password).digest("hex") }),
});
const token = (await signinRes.json())?.data?.token;
if (!token) {
  console.log("SIGNIN FAIL");
  process.exit(1);
}
console.log("token OK");

for (const p of mapping.profiles) {
  const body = {
    profile_id: p.id,
    folder_id: mapping.folderId,
    name: p.name,
    proxy: {
      type: "http",
      host: "79.127.168.43",
      port: 50100,
      username: p.proxyLogin,
      password: "uDdliaN2SU",
    },
    flags: { proxy_masking: "custom" },
  };
  const res = await fetch("https://api.multilogin.com/profile/update", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ok = res.status === 200 && !/error/i.test(text.slice(0, 80));
  console.log(`${ok ? "OK  " : "FAIL"} ${p.name} http:${res.status} ${text.slice(0, 120)}`);
  await new Promise((s) => setTimeout(s, 800));
}
console.log("== BITTI");
