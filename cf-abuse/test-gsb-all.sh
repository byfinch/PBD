#!/bin/bash
# GSB: 8 profilde seri dogrulama (05 ve 07 zaten submitted).
cd "$(dirname "$0")/.."
LOG=/tmp/gsbtest.log
: > $LOG
for i in 01 02 03 04 06 08 09 10; do
  P="PBD-$i"
  echo "===== $P basladi $(date +%H:%M:%S) =====" >> $LOG
  node cf-abuse/gsb-report.mjs --profile $P --target https://herabet392.cam/ >> $LOG 2>&1
  echo "----- $P bitti $(date +%H:%M:%S) -----" >> $LOG
  grep "SONUC" $LOG | tail -1
  sleep 15
done
echo "== OZET =="
grep "SONUC" $LOG
