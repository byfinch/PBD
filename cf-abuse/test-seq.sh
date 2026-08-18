#!/bin/bash
# 10 profil SIRAYLA — her biri once GSB sonra CF. Tam seri, hatasiz gecis testi.
cd "$(dirname "$0")/.."
LOG=/tmp/seqtest.log
: > $LOG
PAIR="01:hakan.yildiz.tr 02:yagmur.sen.tr 03:arda.gul.35 04:melis.toprak.tr 05:keremaydogdu.ist 06:asli.cetin.tr 07:yusuf.bulut.06 08:esra.karaca.tr 09:oguz.simsek.tr 10:handeyavuz.ank"
for p in $PAIR; do
  i="${p%%:*}"; id="${p#*:}"
  P="PBD-$i"
  echo "===== $P GSB $(date +%H:%M:%S) =====" >> $LOG
  node cf-abuse/gsb-report.mjs --profile $P --target https://herabet392.cam/ >> $LOG 2>&1
  grep SONUC $LOG | tail -1 | sed "s/^/[GSB] /"
  sleep 8
  echo "===== $P CF $(date +%H:%M:%S) =====" >> $LOG
  node cf-abuse/report.mjs --profile $P --identity "$id@meridyendijital.com" \
    --target https://herabet392.cam/ --official https://herabet393.com/ --brand herabet >> $LOG 2>&1
  grep SONUC $LOG | tail -1 | sed "s/^/[CF] /"
  sleep 8
done
echo "== OZET =="
grep SONUC $LOG
