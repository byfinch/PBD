#!/bin/bash
# vps-fix14: lokal config degisikligini sifirla + pull + sorry cozum testi
set -u
cd /opt/pbd 2>/dev/null || cd /root/PBD || { echo "PBD dizini yok"; exit 1; }
git checkout -- config/default.json 2>/dev/null
git pull -q origin main && echo "pull OK" || { echo "PULL FAIL"; git status -sb | head -5; exit 1; }
grep -n '"driver"' config/default.json
grep -n '"enabled"' config/default.json | tail -2
npm install --silent >/dev/null 2>&1 && echo "npm OK"
npm run build >/dev/null 2>&1 && echo "build OK" || { echo "BUILD FAIL"; exit 1; }
node scripts/mlx-sorry-test.mjs "${1:-PBD-08}"
echo "== BITTI"
