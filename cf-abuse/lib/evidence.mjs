/**
 * lib/evidence.mjs — kanit dosya hijyeni (basarisiz denemelerin kanitlarini temizle).
 */
import { readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const KANIT_RE = /^kanit-(?!monitor-).+-(filled|result)-\d+\.jpe?g$/i;

/** Deneme oncesi evidence dizini snapshot'i. */
export function snapEvidence(dir) {
  try { return new Set(readdirSync(dir)); } catch { return new Set(); }
}

/** Snapshot sonrasi olusan kanit-* dosyalarini sil (basarisiz deneme hijyeni). */
export function cleanNewEvidence(dir, snap) {
  try {
    for (const f of readdirSync(dir)) {
      if (!snap.has(f) && KANIT_RE.test(f)) unlinkSync(resolve(dir, f));
    }
  } catch {}
}
