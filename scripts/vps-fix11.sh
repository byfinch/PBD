#!/bin/bash
# vps-fix11: saglik turu v2 (ipify + google metrikleri)
set -u
cd /opt/pbd 2>/dev/null || cd /root/PBD || { echo "PBD dizini yok"; exit 1; }
git pull -q origin main && echo "pull OK"
node scripts/mlx-health.mjs
echo "== BITTI"
