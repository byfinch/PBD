#!/bin/bash
# 10 profil PARALEL — her biri once GSB sonra CF raporlar.
cd "$(dirname "$0")/.."
LOG=/tmp/partest.log
: > $LOG
run_one() {
  local P="$1" ID="$2"
  {
    echo "[$P] GSB basladi $(date +%H:%M:%S)"
    node cf-abuse/gsb-report.mjs --profile $P --target https://herabet392.cam/ 2>&1 | tail -15 | sed "s/^/[$P GSB] /"
    sleep 5
    echo "[$P] CF basladi $(date +%H:%M:%S)"
    node cf-abuse/report.mjs --profile $P --identity "$ID" --target https://herabet392.cam/ --official https://herabet393.com/ --brand herabet 2>&1 | tail -20 | sed "s/^/[$P CF] /"
  } >> $LOG 2>&1
}
run_one PBD-01 hakan.yildiz.tr@meridyendijital.com &
run_one PBD-02 yagmur.sen.tr@meridyendijital.com &
run_one PBD-03 arda.gul.35@meridyendijital.com &
run_one PBD-04 melis.toprak.tr@meridyendijital.com &
run_one PBD-05 keremaydogdu.ist@meridyendijital.com &
wait
echo "== dalga 1 bitti, dalga 2 $(date +%H:%M:%S) ==" >> $LOG
sleep 10
run_one PBD-06 asli.cetin.tr@meridyendijital.com &
run_one PBD-07 yusuf.bulut.06@meridyendijital.com &
run_one PBD-08 esra.karaca.tr@meridyendijital.com &
run_one PBD-09 oguz.simsek.tr@meridyendijital.com &
run_one PBD-10 handeyavuz.ank@meridyendijital.com &
wait
echo "== OZET =="
sort $LOG | grep SONUC
