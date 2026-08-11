#!/bin/bash
set -u
echo "== ana chrome prosesinin TAM cmdline'i:"
for pid in $(pgrep -f "mimic_151.1/chrome " | head -3); do
  echo "-- pid $pid:"
  tr '\0' ' ' < /proc/$pid/cmdline | head -c 600
  echo ""
done
echo "== ozone/headless izi:"
pgrep -f "mimic" | head -5 | while read pid; do tr '\0' ' ' < /proc/$pid/cmdline; echo; done | grep -oE "ozone-platform=[a-z]+|headless[a-z-]*" | sort | uniq -c
echo "== xwininfo root cocuklari (:99):"
DISPLAY=:99 xwininfo -root -children 2>/dev/null | head -12
echo "== BITTI"
