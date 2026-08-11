#!/bin/bash
# cf-turnstile-vps.sh — VPS'te Xvfb + xdotool ile Turnstile testi.
# PLAIN start (automation YOK) -> xdotool ile navigate -> screenshot -> widget durumu.
set -u
export DISPLAY=:99
pgrep -x Xvfb >/dev/null || (Xvfb :99 -screen 0 1920x1080x24 >/var/log/xvfb.log 2>&1 &)
sleep 2
command -v xdotool >/dev/null || apt-get install -y -q xdotool >/dev/null 2>&1
command -v import >/dev/null || apt-get install -y -q imagemagick >/dev/null 2>&1
echo "xdotool: $(command -v xdotool || echo YOK) | import: $(command -v import || echo YOK)"

MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
TOKEN=$(curl -s --max-time 20 -X POST https://api.multilogin.com/user/signin -H 'Content-Type: application/json' \
  -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TOKEN" ] && echo "token OK" || { echo "TOKEN YOK"; exit 1; }

F=0509ecba-935f-484b-bb1f-18c8370d1017
P=e7a207bd-ce4b-4419-8484-056b53dbb3c4  # PBD-01 (yeni windows profili)
L="https://launcher.mlx.yt:45001"
curl -sk --max-time 15 "$L/api/v1/profile/stop/p/$P" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1
sleep 3

echo "== plain start (automation parametresi YOK)"
PORT=""
for i in $(seq 1 50); do
  RESP=$(curl -sk --max-time 90 "$L/api/v2/profile/f/$F/p/$P/start" -H "Authorization: Bearer $TOKEN")
  if echo "$RESP" | grep -qE '"port"|started successfully'; then
    echo "profil acildi: $(echo "$RESP" | head -c 160)"
    break
  fi
  CODE=$(echo "$RESP" | grep -o '"error_code":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "[$i] ${CODE:-?}"
  case "$CODE" in
    *CORE_DOWNLOADING*) sleep 20 ;;
    *) echo "beklenmedik hata"; echo "$RESP" | head -c 200; exit 1 ;;
  esac
done

echo "== pencere bekleniyor"
WID=""
for i in $(seq 1 30); do
  WID=$(xdotool search --name "PBD-01" 2>/dev/null | head -1)
  [ -n "$WID" ] && break
  sleep 1
done
[ -z "$WID" ] && { echo "PENCERE YOK"; exit 1; }
echo "pencere: $WID"
xdotool windowactivate "$WID" 2>/dev/null
sleep 1
xdotool key --window "$WID" ctrl+l
sleep 0.5
xdotool type --window "$WID" --delay 40 "abuse.cloudflare.com/phishing"
xdotool key --window "$WID" Return
echo "navigate edildi, 30sn bekleniyor"
sleep 30

# alta kaydir
xdotool key --window "$WID" End
sleep 2
xdotool key --window "$WID" End
sleep 3

import -window root -display :99 /tmp/cf-vps-1.png 2>/dev/null && echo "screenshot OK: /tmp/cf-vps-1.png ($(du -h /tmp/cf-vps-1.png | cut -f1))" || echo "screenshot FAIL"
echo "== BITTI (profil acik birakildi; tiklama icin sonraki adim)"
