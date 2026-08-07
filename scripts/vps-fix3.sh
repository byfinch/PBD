#!/bin/bash
# vps-fix3: ML6 -> Multilogin X agent gecisi + ilk profil start testi
set -u

echo "== 1) eski ML6 agent durdur"
systemctl stop multilogin 2>/dev/null
systemctl disable multilogin 2>/dev/null
pkill -f "/opt/Multilogin" 2>/dev/null
sleep 1
echo "ok"

echo "== 2) MLX agent indir + kur"
cd /tmp
curl -L -f -sS -o mlxdeb.deb "https://mlxdists.s3.eu-west-3.amazonaws.com/mlx/latest/multiloginx-amd64.deb" \
  && echo "indirildi: $(du -h mlxdeb.deb | cut -f1)"
dpkg -i mlxdeb.deb >/tmp/mlx-dpkg.log 2>&1 || apt-get -f install -y >>/tmp/mlx-dpkg.log 2>&1
MLX_BIN=$(command -v mlx || true)
if [ -z "$MLX_BIN" ]; then
  echo "mlx BULUNAMADI - dpkg log:"
  tail -8 /tmp/mlx-dpkg.log
  exit 1
fi
echo "mlx: $MLX_BIN"

echo "== 3) xvfb kontrol"
command -v xvfb-run >/dev/null || apt-get install -y xvfb >/dev/null 2>&1
command -v xvfb-run >/dev/null && echo "xvfb OK" || echo "XVFB YOK"

echo "== 4) mlx-agent systemd servisi"
cat > /etc/systemd/system/mlx-agent.service <<EOF
[Unit]
Description=Multilogin X agent (headless, xvfb)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/xvfb-run -a --server-args="-screen 0 1920x1080x24" $MLX_BIN
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now mlx-agent >/dev/null 2>&1
sleep 15
echo "mlx-agent: $(systemctl is-active mlx-agent)"
echo "-- dinleyen portlar:"
ss -ltnp | grep -Ei ":4500|:3500|mlx" || echo "(henuz port yok)"
echo "-- son log:"
journalctl -u mlx-agent -n 6 --no-pager 2>/dev/null | tail -6

echo "== 5) cloud signin"
MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
SIGNIN=$(curl -s --max-time 30 -X POST https://api.multilogin.com/user/signin \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}")
TOKEN=$(echo "$SIGNIN" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$TOKEN" ]; then echo "token OK (${#TOKEN} kr)"; else echo "TOKEN YOK: $(echo "$SIGNIN" | head -c 200)"; fi

echo "== 6) profile start testi (PBD-01, ilk calistirmada core indirir, uzun surebilir)"
F=0509ecba-935f-484b-bb1f-18c8370d1017
P=8dd1898f-570f-4dac-a193-46ec9a36e3f8
RESP=$(curl -sk --max-time 300 \
  "https://launcher.mlx.yt:45001/api/v2/profile/f/$F/p/$P/start?automation_type=playwright&headless_mode=false" \
  -H "Authorization: Bearer $TOKEN")
echo "$RESP" | head -c 400
echo ""
PORT=$(echo "$RESP" | grep -o '"port":[0-9]*' | head -1 | cut -d: -f2)
if [ -n "$PORT" ]; then
  echo "-- CDP port $PORT acik mi:"
  curl -s --max-time 10 "http://127.0.0.1:$PORT/json/version" | head -c 200
  echo ""
fi

echo "== 7) stop"
curl -sk --max-time 30 "https://launcher.mlx.yt:45001/api/v2/profile/f/$F/p/$P/stop" \
  -H "Authorization: Bearer $TOKEN" | head -c 200
echo ""
echo "== BITTI"
