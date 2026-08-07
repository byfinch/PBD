import type { AppConfig } from "../config.js";

/**
 * Stable per-profile "personality" derived from profile name/id.
 * Same profile always gets the same base traits (scroll style, pace, mouse-iness).
 * Per-action randomness still applies inside those ranges so sessions don't look robotic.
 */

export type ScrollStyle = "calm" | "normal" | "active";

export interface ProfilePersona {
  key: string;
  /** 0..1 — higher = more scrolling */
  scrollChance: number;
  /** 0..1 — desktop mouse wander */
  mouseMoveChance: number;
  /** 0..1 — chance to open an internal link after landing */
  internalLinkChance: number;
  /** Multiplier on pre-click wait ranges */
  preClickScale: number;
  /** Multiplier on landing dwell ranges */
  dwellScale: number;
  scrollStyle: ScrollStyle;
  /** Extra inter-visit delay multiplier (safety) */
  interQueryScale: number;
  /** Label for logs */
  label: string;
}

/** FNV-1a 32-bit hash → stable seed in [0,1). */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

function pickStyle(t: number): ScrollStyle {
  if (t < 0.33) return "calm";
  if (t < 0.66) return "normal";
  return "active";
}

/**
 * Build a deterministic persona for an antidetect profile (prefer human name: PBD-014).
 */
export function personaFor(profileKey: string): ProfilePersona {
  const key = profileKey.trim() || "unknown";
  const a = hash01(key);
  const b = hash01(key + ":b");
  const c = hash01(key + ":c");
  const d = hash01(key + ":d");
  const e = hash01(key + ":e");

  const scrollStyle = pickStyle(a);
  const scrollChance =
    scrollStyle === "calm" ? 0.45 + b * 0.25 : scrollStyle === "normal" ? 0.7 + b * 0.2 : 0.85 + b * 0.15;
  const mouseMoveChance = 0.35 + c * 0.55;
  const internalLinkChance = 0.08 + d * 0.28;
  const preClickScale = 0.75 + e * 0.7; // 0.75–1.45
  const dwellScale = 0.8 + hash01(key + ":dwell") * 0.6; // 0.8–1.4
  const interQueryScale = 0.9 + hash01(key + ":gap") * 0.5; // 0.9–1.4

  return {
    key,
    scrollChance: Math.min(0.98, scrollChance),
    mouseMoveChance: Math.min(0.95, mouseMoveChance),
    internalLinkChance: Math.min(0.45, internalLinkChance),
    preClickScale,
    dwellScale,
    scrollStyle,
    interQueryScale,
    label: scrollStyle,
  };
}

/** Scale a [min,max] range by factor, keep integers. */
export function scaleRange(min: number, max: number, scale: number): { min: number; max: number } {
  const mid = (min + max) / 2;
  const half = ((max - min) / 2) * scale;
  const nmin = Math.max(200, Math.floor(mid - half));
  const nmax = Math.max(nmin + 100, Math.floor(mid + half));
  return { min: nmin, max: nmax };
}

export type BehaviorConfig = AppConfig["behavior"];

/**
 * Merge the global behavior config with this profile's persona: dwell ranges,
 * scroll reach, mouse-iness and internal-link appetite all shift per profile.
 */
export function behaviorForProfile(base: BehaviorConfig, profileKey: string): BehaviorConfig {
  const p = personaFor(profileKey);
  const dwell = scaleRange(base.dwellMinMs, base.dwellMaxMs, p.dwellScale);
  const internal = scaleRange(base.internalLinks.minStayMs, base.internalLinks.maxStayMs, p.dwellScale);

  return {
    ...base,
    dwellMinMs: dwell.min,
    dwellMaxMs: dwell.max,
    scrollReachChance: Math.min(0.98, base.scrollReachChance * p.scrollChance),
    mouseMoveChance: p.mouseMoveChance,
    internalLinks: {
      ...base.internalLinks,
      chance: Math.min(0.9, base.internalLinks.chance + p.internalLinkChance),
      minStayMs: internal.min,
      maxStayMs: internal.max,
    },
  };
}
