#!/bin/bash
# vps-fix9: stop v1 path + start v2 + string/number port parse
set -u

MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
TOKEN=$(curl -s --max-time 30 -X POST https://api.multilogin.com/user/signin \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TOKEN" ] && echo "token OK" || { echo "TOKEN YOK"; exit 1; }

F=0509ecba-935f-484b-bb1f-18c8370d1017
P=8dd1898f-570f-4dac-a193-46ec9a36e3f8
L="https://launcher.mlx.yt:45001"

echo "== stop (v1: /api/v1/profile/stop/p/ID)"
curl -sk --max-time 30 "$L/api/v1/profile/stop/p/$P" -H "Authorization: Bearer $TOKEN" | head -c 200
echo ""
sleep 5

echo "== start (v2)"
RESP=$(curl -sk --max-time 180 "$L/api/v2/profile/f/$F/p/$P/start?automation_type=playwright&headless_mode=false" \
  -H "Authorization: Bearer $TOKEN")
echo "ham cevap: $(echo "$RESP" | head -c 400)"
PORT=$(echo "$RESP" | tr -d ' ' | grep -o '"port":"\?[0-9]\+' | grep -o '[0-9]\+' | head -1)
echo ""
echo "port: ${PORT:-YOK}"

if [ -n "$PORT" ]; then
  echo "== CDP /json/version"
  curl -s --max-time 10 "http://127.0.0.1:$PORT/json/version" | head -c 300
  echo ""
  echo "== stop (v1)"
  curl -sk --max-time 30 "$L/api/v1/profile/stop/p/$P" -H "Authorization: Bearer $TOKEN" | head -c 200
  echo ""
fi
echo "== BITTI"
