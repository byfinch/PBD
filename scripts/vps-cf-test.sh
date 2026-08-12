#!/bin/bash
# VPS'te CF-Abuse GEREK rapor (primebahis) + kanitlari panele servis et
set -u
cd /opt/pbd && git pull -q origin main && echo "pull OK"
python3 -c "import PIL" 2>/dev/null || pip3 install -q pillow 2>/dev/null || (apt-get install -y -q python3-pil >/dev/null 2>&1)
python3 -c "import PIL; print('pillow OK')" || echo "PIL YOK"
cd cf-abuse
node report.mjs \
  --target "https://guncel.primebahis-tronline.cam/" \
  --official "https://primebahis404.com/" \
  --brand "Primebahis" \
  --profile PBD-08
mkdir -p /opt/pbd/data/evidence
cp -f evidence/*.jpg /opt/pbd/data/evidence/ 2>/dev/null
echo "== kanitlar panelde: http://209.74.95.106:3080/evidence/ (login sonrasi)"
ls -t /opt/pbd/data/evidence/ | head -6
echo "== BITTI"
