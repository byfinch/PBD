#!/bin/bash
# cf-turnstile-vps.sh v3 — dogru DISPLAY tespiti + pencere listesi + xdotool navigate
set -u
command -v xdotool >/dev/null || apt-get install -y -q xdotool >/dev/null 2>&1
command -v import >/dev/null || apt-get install -y -q imagemagick >/dev/null 2>&1

# agent'in gercek X display'ini bul (/tmp/.X11-unix altindaki soketler)
DISP=$(ls /tmp/.X11-unix/ 2>/dev/null | grep -oE 'X[0-9]+' | sort -t X -k2 -n | tail -1 | tr -d 'X')
[ -z "$DISP" ] && { echo "X display YOK — agent calisiyor mu?"; systemctl status mlx-agent --no-pager | head -5; exit 1; }
export DISPLAY=:$DISP
echo "DISPLAY=$DISPLAY"

MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
TOKEN=$(curl -s --max-time 20 -X POST https://api.multilogin.com/user/signin -H 'Content-Type: application/json' \
  -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TOKEN" ] && echo "token OK" || { echo "TOKEN YOK"; exit 1; }

F=0509ecba-935f-484b-bb1f-18c8370d1017
P=e7a207bd-ce4b-4419-8484-056b53dbb3c4  # PBD-01
L="https://launcher.mlx.yt:45001"
curl -sk --max-time 15 "$L/api/v1/profile/stop/p/$P" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1
sleep 3

echo "== plain start (automation YOK)"
for i in $(seq 1 50); do
  RESP=$(curl -sk --max-time 90 "$L/api/v2/profile/f/$F/p/$P/start" -H "Authorization: Bearer $TOKEN")
  if echo "$RESP" | grep -qE '"port"|started successfully'; then
    echo "profil acildi"
    break
  fi
  CODE=$(echo "$RESP" | grep -o '"error_code":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "[$i] ${CODE:-?}"
  case "$CODE" in
    *CORE_DOWNLOADING*) sleep 20 ;;
    *) echo "$RESP" | head -c 200; exit 1 ;;
  esac
done

echo "== pencere araniyor (tum pencereler listelenecek)"
WID=""
for i in $(seq 1 40); do
  LIST=$(xdotool search --onlyvisible --name "." 2>/dev/null)
  if [ -n "$LIST" ]; then
    for w in $LIST; do
      T=$(xdotool getwindowname "$w" 2>/dev/null)
      echo "  win $w: $T"
      case "$T" in *PBD-01*|*Mimic*|*"New Tab"*|*Cloudflare*|*Google*) [ -z "$WID" ] && WID=$w;; esac
    done
    [ -n "$WID" ] && break
    sleep 3
  else
    sleep 2
  fi
done
[ -z "$WID" ] && { echo "PENCERE YOK"; exit 1; }
echo "hedef pencere: $WID ($(xdotool getwindowname $WID))"

xdotool windowactivate "$WID" 2>/dev/null
sleep 1
xdotool windowfocus "$WID" 2>/dev/null
xdotool key --window "$WID" ctrl+l
sleep 0.5
xdotool type --window "$WID" --delay 40 "abuse.cloudflare.com/phishing"
xdotool key --window "$WID" Return
echo "navigate edildi, 30sn bekleniyor"
sleep 30
xdotool key --window "$WID" End
sleep 2
xdotool key --window "$WID" End
sleep 3
import -window root /tmp/cf-vps-1.png 2>/dev/null && echo "screenshot OK ($(du -h /tmp/cf-vps-1.png | cut -f1))" || echo "screenshot FAIL"
echo "== BITTI (profil acik)"
