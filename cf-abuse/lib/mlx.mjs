/**
 * mlx.mjs — Multilogin yardimcilari (signup scriptleri icin)
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Agent, fetch as uFetch } from "undici";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PBD = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tls = new Agent({ connect: { rejectUnauthorized: false } });
const L = "https://launcher.mlx.yt:45001";

export function loadEnv() {
  for (const line of readFileSync(`${PBD}/.env`, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

export function loadProfiles() {
  return JSON.parse(readFileSync(`${PBD}/config/profiles.json`, "utf8"));
}

let _token = null;
export async function mlxToken() {
  if (_token) return _token;
  loadEnv();
  const r = await uFetch("https://api.multilogin.com/user/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.MULTILOGIN_EMAIL,
      password: createHash("md5").update(process.env.MULTILOGIN_PASSWORD).digest("hex"),
    }),
  });
  const j = await r.json();
  _token = j.data.token;
  return _token;
}

export async function lapi(path) {
  const token = await mlxToken();
  const r = await uFetch(L + path, { headers: { Authorization: `Bearer ${token}` }, dispatcher: tls });
  return (await r.json().catch(() => null))?.data;
}

export async function stopProfile(profileId) {
  await lapi(`/api/v1/profile/stop/p/${profileId}`).catch(() => {});
}

/** Profili baslat, {port} dondur. Retry dahili (maxAttempts ile kisitlabilir). */
export async function startProfile(profile, folderId, maxAttempts = 6) {
  const token = await mlxToken();
  await stopProfile(profile.id);
  await new Promise((s) => setTimeout(s, 4000));
  for (let a = 1; a <= maxAttempts; a++) {
    const r = await uFetch(
      `${L}/api/v2/profile/f/${folderId}/p/${profile.id}/start?automation_type=playwright&headless_mode=false`,
      { headers: { Authorization: `Bearer ${token}` }, dispatcher: tls }
    );
    const j = await r.json().catch(() => null);
    if (j?.data?.port) return j.data;
    const code = j?.status?.error_code ?? "";
    console.log(`start deneme ${a}: ${code || "?"}`);
    if (code.includes("CORE_DOWNLOADING")) { await new Promise((s) => setTimeout(s, 15000)); continue; }
    if (code === "LOCK_PROFILE_ERROR" || code === "PROFILE_ALREADY_RUNNING") {
      await stopProfile(profile.id);
      await new Promise((s) => setTimeout(s, 8000));
      continue;
    }
    await new Promise((s) => setTimeout(s, 4000));
  }
  throw new Error("profil acilmadi: " + profile.name);
}
