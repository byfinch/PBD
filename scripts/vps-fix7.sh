#!/bin/bash
# vps-fix7: stop -> start, toleransli port parse, CDP dogrula
set -u

MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
TOKEN=$(curl -s --max-time 30 -X POST https://api.multilogin.com/user/signin \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TOKEN" ] && echo "token OK" || { echo "TOKEN YOK"; exit 1; }

F=0509ecba-935f-484b-bb1f-18c8370d1017
P=8dd1898f-570f-4dac-a193-46ec9a36e3f8
BASE="https://launcher.mlx.yt:45001/api/v2/profile/f/$F/p/$P"

echo "== once stop (temiz sayfa)"
curl -sk --max-time 30 "$BASE/stop" -H "Authorization: Bearer $TOKEN" | head -c 150
echo ""
sleep 5

echo "== start"
RESP=$(curl -sk --max-time 180 "$BASE/start?automation_type=playwright&headless_mode=false" \
  -H "Authorization: Bearer $TOKEN")
echo "ham cevap: $(echo "$RESP" | head -c 500)"
PORT=$(echo "$RESP" | tr -d ' ' | grep -o '"port":[0-9]*' | head -1 | cut -d: -f2)
echo ""
echo "port: ${PORT:-YOK}"

if [ -n "$PORT" ]; then
  echo "== CDP /json/version"
  curl -s --max-time 10 "http://127.0.0.1:$PORT/json/version" | head -c 300
  echo ""
  echo "== stop"
  curl -sk --max-time 30 "$BASE/stop" -H "Authorization: Bearer $TOKEN" | head -c 150
  echo ""
fi
echo "== BITTI"
