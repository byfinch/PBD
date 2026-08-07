#!/bin/bash
set -u
echo "== pbd.service düzeltme (unknown option -p)"
sed -i 's|ExecStart=.*|ExecStart=/usr/bin/node dist/index.js web|' /etc/systemd/system/pbd.service
systemctl daemon-reload && systemctl restart pbd
sleep 5
echo "pbd: $(systemctl is-active pbd)"
curl -s -o /dev/null -w "panel http: %{http_code}\n" http://localhost:3080/

echo ""
echo "== multilogin cli login denemeleri"
cd /opt/Multilogin/headless
echo "-- A: -login -u -p"
timeout 25 ./cli.sh -login -u "efsunlukemal@gmail.com" -p "LakeGarda123/" 2>&1 | head -5
echo "-- B: --login --email --password"
timeout 25 ./cli.sh --login --email "efsunlukemal@gmail.com" --password "LakeGarda123/" 2>&1 | head -5
echo "-- C: login -u -p (dash'siz)"
timeout 25 ./cli.sh login -u "efsunlukemal@gmail.com" -p "LakeGarda123/" 2>&1 | head -5

echo ""
echo "== profile start (v1) PBD-01"
curl -s --max-time 90 "http://localhost:35000/api/v1/profile/start?automation=true&profileId=8dd1898f-570f-4dac-a193-46ec9a36e3f8" | head -c 300
echo ""
curl -s "http://localhost:35000/api/v1/profile/stop?profileId=8dd1898f-570f-4dac-a193-46ec9a36e3f8" > /dev/null 2>&1
