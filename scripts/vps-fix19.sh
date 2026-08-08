#!/bin/bash
# vps-fix19: mobil SERP DOM tani
set -u
cd /opt/pbd 2>/dev/null || cd /root/PBD || { echo "PBD dizini yok"; exit 1; }
git pull -q origin main && echo "pull OK"
npm run build >/dev/null 2>&1 && echo "build OK" || { echo "BUILD FAIL"; exit 1; }
node scripts/mlx-serp-dom.mjs "${1:-PBD-05}" "${2:-milanbahisde.com}"
echo "== BITTI"
