#!/bin/bash
# 10 profili sirayla gercek sikayet kosusuyla test eder; her profile TAZE kimlik.
cd "$(dirname "$0")/.."
LOG=/tmp/proftest.log
: > $LOG
PAIR="08:tolga.karaman35 09:irem.yalcin.tr 10:volkanerdem.ist"
for p in $PAIR; do
  i="${p%%:*}"; id="${p#*:}"
  P="PBD-$i"
  echo "===== $P ($id) basladi $(date +%H:%M:%S) =====" >> $LOG
  node cf-abuse/report.mjs --profile $P --identity "$id@meridyendijital.com" \
    --target https://herabet392.cam/ --official https://herabet393.com/ --brand herabet \
    >> $LOG 2>&1
  echo "----- $P bitti $(date +%H:%M:%S) -----" >> $LOG
  grep -E "SONUC" $LOG | tail -1
  sleep 20
done
echo "== OZET =="
grep "SONUC" $LOG
