// Copy src/web/public → dist/web/public so the panel works from the build output.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "src/web/public");
const to = resolve(root, "dist/web/public");

if (!existsSync(from)) {
  console.warn("[copy-web-assets] src/web/public not found — skipping");
  process.exit(0);
}
mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });
console.log("[copy-web-assets] copied src/web/public → dist/web/public");
