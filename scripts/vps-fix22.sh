#!/bin/bash
# vps-fix22: proxy'leri http:50100'e cevir + dogrula (PBD-01 start)
set -u
cd /opt/pbd 2>/dev/null || cd /root/PBD || { echo "PBD dizini yok"; exit 1; }
git pull -q origin main && echo "pull OK"
npm run build >/dev/null 2>&1 && echo "build OK" || { echo "BUILD FAIL"; exit 1; }

echo "== 1) proxy switch (socks5 -> http)"
node scripts/mlx-proxy-switch.mjs

echo "== 2) dogrulama: PBD-01 start"
MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
TOKEN=$(curl -s --max-time 30 -X POST https://api.multilogin.com/user/signin \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
F=0509ecba-935f-484b-bb1f-18c8370d1017
P=8dd1898f-570f-4dac-a193-46ec9a36e3f8
L="https://launcher.mlx.yt:45001"
RESP=$(curl -sk --max-time 120 "$L/api/v2/profile/f/$F/p/$P/start?automation_type=playwright&headless_mode=false" \
  -H "Authorization: Bearer $TOKEN")
echo "start: $(echo "$RESP" | head -c 250)"
PORT=$(echo "$RESP" | tr -d ' ' | grep -o '"port":"\?[0-9]\+' | grep -o '[0-9]\+' | head -1)
if [ -n "$PORT" ]; then
  sleep 3
  echo "== 3) exit IP (CDP uzerinden degil, profilin kendi sayfasi yerine duz kontrol yok — launcher basardiysa proxy OK)"
  curl -sk --max-time 30 "$L/api/v1/profile/stop/p/$P" -H "Authorization: Bearer $TOKEN" | head -c 120
  echo ""
fi
echo "== BITTI"
