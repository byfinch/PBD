#!/bin/bash
# vps-fix21: proxy-seller upstream TCP seviyesi + HTTP portu + kisa retry
set -u
echo "== TCP baglanti testi (socks5 50101)"
timeout 8 bash -c 'echo > /dev/tcp/79.127.168.43/50101' 2>&1 && echo "50101 TCP ACIK" || echo "50101 TCP KAPALI/FILTRELI"
echo "== TCP baglanti testi (http 50100)"
timeout 8 bash -c 'echo > /dev/tcp/79.127.168.43/50100' 2>&1 && echo "50100 TCP ACIK" || echo "50100 TCP KAPALI/FILTRELI"
echo "== HTTP portu uzerinden dene"
IP=$(curl -s --max-time 15 -x "http://GMscFKpZ_1:uDdliaN2SU@79.127.168.43:50100" https://api.ipify.org 2>&1)
echo "ipify (50100): ${IP:-TIMEOUT/HATA}"
echo "== genel internet saglam mi (proxysiz)"
curl -s --max-time 10 -o /dev/null -w "google proxysiz: %{http_code}\n" https://www.google.com
echo "== 3 deneme / 30 sn arayla (flap mi kalici mi)"
for i in 1 2 3; do
  IP=$(curl -s --max-time 15 --socks5-hostname "GMscFKpZ_1:uDdliaN2SU@79.127.168.43:50101" https://api.ipify.org 2>&1)
  echo "deneme $i: ${IP:-TIMEOUT}"
  [ $i -lt 3 ] && sleep 30
done
echo "== BITTI"
