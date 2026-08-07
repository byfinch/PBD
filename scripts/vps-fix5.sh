#!/bin/bash
# vps-fix5: mlx-agent HOME tanimi + start testi
set -u

echo "== 1) servis unit duzelt (HOME=/root)"
MLX_BIN=$(command -v mlx || echo /usr/bin/mlx)
cat > /etc/systemd/system/mlx-agent.service <<EOF
[Unit]
Description=Multilogin X agent (headless, xvfb)
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOME=/root
ExecStart=/usr/bin/xvfb-run -a --server-args="-screen 0 1920x1080x24" $MLX_BIN
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl restart mlx-agent
sleep 20
echo "mlx-agent: $(systemctl is-active mlx-agent)"
ss -ltnp | grep -Ei ":4500|:3500" || echo "(port yok)"
journalctl -u mlx-agent -n 5 --no-pager 2>/dev/null | tail -5

echo "== 2) signin + start testi"
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
  echo ""
  echo "== stop"
  curl -sk --max-time 30 "https://launcher.mlx.yt:45001/api/v2/profile/f/$F/p/$P/stop" \
    -H "Authorization: Bearer $TOKEN" | head -c 200
  echo ""
fi
echo "== BITTI"
