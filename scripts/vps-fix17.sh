#!/bin/bash
# vps-fix16: yeni panel deploy (pull + build + pbd restart)
set -u
cd /opt/pbd 2>/dev/null || cd /root/PBD || { echo "PBD dizini yok"; exit 1; }
git pull -q origin main && echo "pull OK"
npm install --silent >/dev/null 2>&1 && echo "npm OK"
npm run build >/dev/null 2>&1 && echo "build OK" || { echo "BUILD FAIL"; exit 1; }
systemctl restart pbd
sleep 5
echo "pbd: $(systemctl is-active pbd)"
curl -s -o /dev/null -w "panel (auth'suz 401 beklenir): %{http_code}\n" http://localhost:3080/
curl -s -X POST http://localhost:3080/api/login -H 'Content-Type: application/json' \
  -d '{"u":"admin","p":"pbd2026"}' -c /tmp/pbdck -o /dev/null -w "login: %{http_code}\n"
curl -s -b /tmp/pbdck http://localhost:3080/api/overview | head -c 300
echo ""
echo "== BITTI"
