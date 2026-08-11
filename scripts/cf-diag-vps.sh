#!/bin/bash
# cf-diag-vps.sh — X display + mimic proses + pencere taramasi
set -u
echo "== X soketleri:"
ls -la /tmp/.X11-unix/ 2>/dev/null
echo "== Xvfb prosesleri:"
ps aux | grep -i "[x]vfb" | awk '{print $2, $11, $12, $13, $14}'
echo "== mimic/mimic-browser prosesleri:"
ps aux | grep -iE "[m]imic|[l]auncher" | awk '{print $2, substr($0, index($0,$11), 80)}' | head -8
echo "== her display'de pencere tara:"
for d in $(ls /tmp/.X11-unix/ 2>/dev/null | grep -oE 'X[0-9]+' | tr -d 'X'); do
  echo "-- DISPLAY=:$d"
  DISPLAY=:$d xdotool search --name "." 2>/dev/null | while read w; do
    echo "   win $w: $(DISPLAY=:$d xdotool getwindowname $w 2>/dev/null)"
  done | head -10
done
echo "== BITTI"
