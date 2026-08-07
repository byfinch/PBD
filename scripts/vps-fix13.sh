#!/bin/bash
# vps-fix13: canli /sorry cozum testi (PBD-08)
set -u
cd /opt/pbd 2>/dev/null || cd /root/PBD || { echo "PBD dizini yok"; exit 1; }
git pull -q origin main && echo "pull OK"
npm install --silent >/dev/null 2>&1 && echo "npm OK"
npm run build >/dev/null 2>&1 && echo "build OK" || { echo "BUILD FAIL"; exit 1; }
grep -n '"enabled": true' config/default.json >/dev/null && echo "solver enabled OK"
node scripts/mlx-sorry-test.mjs "${1:-PBD-08}"
echo "== BITTI"
