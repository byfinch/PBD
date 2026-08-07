#!/bin/bash
# vps-fix12: RAM/dmesg + derin profil tani
set -u
cd /opt/pbd 2>/dev/null || cd /root/PBD || { echo "PBD dizini yok"; exit 1; }
git pull -q origin main && echo "pull OK"

echo "== RAM"
free -m
echo "== OOM kill var mi"
dmesg 2>/dev/null | grep -i "killed process" | tail -5 || echo "(dmesg okunamadi)"
echo "== cpu"
nproc

echo "== derin tani"
node scripts/mlx-debug.mjs
echo "== BITTI"
