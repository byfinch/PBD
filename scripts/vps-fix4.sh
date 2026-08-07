#!/bin/bash
# vps-fix4: mlx-agent eksik kutuphaneler + eski ML6 proses temizligi + start testi
set -u

echo "== 1) eski ML6 prosesini oldur"
pkill -x multilogin 2>/dev/null
pkill -f "Multilogin" 2>/dev/null
sleep 2
ss -ltnp | grep ":35000" && echo "35000 HALA DOLU" || echo "35000 bos"

echo "== 2) eksik kutuphaneler (electron deps)"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -q \
  libayatana-appindicator3-1 \
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils \
  libatspi2.0-0 libdrm2 libgbm1 libxcb-dri3-0 libasound2t64 \
  libsecret-1-0 libxkbcommon0 libxrandr2 libxfixes3 libcups2 \
  >/tmp/mlx-deps.log 2>&1 || tail -5 /tmp/mlx-deps.log
echo "deps kuruldu"

echo "== 3) ldd kontrol (hala eksik var mi)"
if [ -f /opt/mlx/agent.bin ]; then
  MISSING=$(ldd /opt/mlx/agent.bin 2>/dev/null | grep "not found" | awk '{print $1}' | sort -u)
  if [ -n "$MISSING" ]; then
    echo "HALA EKSIK:"; echo "$MISSING"
  else
    echo "ldd temiz"
  fi
else
  echo "/opt/mlx/agent.bin yok?"
fi

echo "== 4) mlx-agent restart"
systemctl restart mlx-agent
sleep 15
echo "mlx-agent: $(systemctl is-active mlx-agent)"
ss -ltnp | grep -Ei ":4500|:3500" || echo "(port yok)"
journalctl -u mlx-agent -n 5 --no-pager 2>/dev/null | tail -5

echo "== 5) signin + start testi"
MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
TOKEN=$(curl -s --max-time 30 -X POST https://api.multilogin.com/user/signin \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TOKEN" ] && echo "token OK" || { echo "TOKEN YOK"; exit 1; }

F=0509ecba-935f-484b-bb1f-18c8370d1017
P=8dd1898f-570f-4dac-a193-46ec9a36e3f8
RESP=$(curl -sk --max-time 300 \
  "https://launcher.mlx.yt:45001/api/v2/profile/f/$F/p/$P/start?automation_type=playwright&headless_mode=false" \
  -H "Authorization: Bearer $TOKEN")
echo "start: $(echo "$RESP" | head -c 400)"
PORT=$(echo "$RESP" | grep -o '"port":[0-9]*' | head -1 | cut -d: -f2)
if [ -n "$PORT" ]; then
  echo "CDP $PORT: $(curl -s --max-time 10 "http://127.0.0.1:$PORT/json/version" | head -c 150)"
  echo "== stop"
  curl -sk --max-time 30 "https://launcher.mlx.yt:45001/api/v2/profile/f/$F/p/$P/stop" \
    -H "Authorization: Bearer $TOKEN" | head -c 200
  echo ""
fi
echo "== BITTI"
