#!/bin/bash
# vps-fix24: yeni repo (project-rank) + kanitlanmis surum deploy
set -u
cd /opt/pbd 2>/dev/null || cd /root/PBD || { echo "PBD dizini yok"; exit 1; }
git remote set-url origin https://github.com/byfinch/project-rank.git
git fetch -q origin && git reset -q --hard origin/main && echo "pull OK (project-rank)"
npm install --silent >/dev/null 2>&1 && echo "npm OK"
npm run build >/dev/null 2>&1 && echo "build OK" || { echo "BUILD FAIL"; exit 1; }

grep -v "^MULTILOGIN_PROXY_TYPE" .env > .env.tmp 2>/dev/null || true
echo "MULTILOGIN_PROXY_TYPE=HTTP" >> .env.tmp
mv .env.tmp .env

systemctl restart pbd
sleep 5
echo "pbd: $(systemctl is-active pbd)"
curl -s -o /dev/null -w "panel: %{http_code}\n" http://localhost:3080/
curl -s -X POST http://localhost:3080/api/login -H 'Content-Type: application/json' \
  -d '{"u":"admin","p":"pbd2026"}' -c /tmp/pbdck -o /dev/null -w "login: %{http_code}\n"
curl -s -b /tmp/pbdck http://localhost:3080/api/overview | head -c 220
echo ""
echo "== BITTI"
