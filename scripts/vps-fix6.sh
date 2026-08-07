#!/bin/bash
# vps-fix6: core indirme bitene kadar bekle, sonra start testi
set -u

echo "== agent durumu"
systemctl is-active mlx-agent
ss -ltnp | grep ":45001" || echo "45001 YOK!"

MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
TOKEN=$(curl -s --max-time 30 -X POST https://api.multilogin.com/user/signin \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TOKEN" ] && echo "token OK" || { echo "TOKEN YOK"; exit 1; }

F=0509ecba-935f-484b-bb1f-18c8370d1017
P=8dd1898f-570f-4dac-a193-46ec9a36e3f8
URL="https://launcher.mlx.yt:45001/api/v2/profile/f/$F/p/$P/start?automation_type=playwright&headless_mode=false"

echo "== start denemeleri (core iniyorsa bekler, 15 dk tavan)"
PORT=""
for i in $(seq 1 45); do
  RESP=$(curl -sk --max-time 120 "$URL" -H "Authorization: Bearer $TOKEN")
  PORT=$(echo "$RESP" | grep -o '"port":[0-9]*' | head -1 | cut -d: -f2)
  if [ -n "$PORT" ]; then
    echo "[$i] PROFIL ACTI - port $PORT"
    break
  fi
  CODE=$(echo "$RESP" | grep -o '"error_code":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "[$i] henuz yok: ${CODE:-$(echo "$RESP" | head -c 120)}"
  if [ "$CODE" != "CORE_DOWNLOADING_STARTED" ] && [ "$CODE" != "CORE_DOWNLOADING" ] && [ -n "$CODE" ]; then
    echo "BEKLENMEYEN HATA, cikiliyor"
    break
  fi
  sleep 20
done

if [ -n "$PORT" ]; then
  echo "== CDP dogrulama"
  curl -s --max-time 10 "http://127.0.0.1:$PORT/json/version" | head -c 200
  echo ""
  echo "== stop"
  curl -sk --max-time 30 "https://launcher.mlx.yt:45001/api/v2/profile/f/$F/p/$P/stop" \
    -H "Authorization: Bearer $TOKEN" | head -c 200
  echo ""
fi
echo "== BITTI"
