#!/bin/bash
# vps-update: en son kodu cek + build + servisleri yeniden baslat
set -u
cd /opt/pbd 2>/dev/null || cd /root/PBD || { echo "PBD dizini yok"; exit 1; }
git remote set-url origin https://github.com/byfinch/project-rank.git
git fetch -q origin && git reset -q --hard origin/main && echo "pull OK"
npm install --silent >/dev/null 2>&1 && echo "npm OK"
npm run build >/dev/null 2>&1 && echo "build OK" || { echo "BUILD FAIL"; exit 1; }
systemctl restart pbd
sleep 5
echo "pbd: $(systemctl is-active pbd)"
echo "multilogin: $(systemctl is-active multilogin 2>/dev/null || echo yok)"
echo "mailpit: $(systemctl is-active mailpit 2>/dev/null || echo yok)"
curl -s -o /dev/null -w "panel(3080): %{http_code}\n" http://localhost:3080/
echo "== BITTI"
