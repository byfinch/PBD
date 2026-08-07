#!/bin/bash
# vps-fix10: PBD guncelle + .env MLX ayarlari + driver=multilogin + 10 profil saglik turu
set -u

PBD_DIR=/opt/pbd
[ -d "$PBD_DIR" ] || PBD_DIR=/root/PBD
[ -d "$PBD_DIR" ] || { echo "PBD dizini bulunamadi"; exit 1; }
echo "== PBD guncelle ($PBD_DIR)"
cd "$PBD_DIR"
git pull -q origin main && echo "pull OK"
npm install --silent >/dev/null 2>&1 && echo "npm OK"
npm run build >/dev/null 2>&1 && echo "build OK" || { echo "BUILD FAIL"; exit 1; }

echo "== .env MLX ayarlari"
grep -v "^MULTILOGIN_" .env > .env.tmp 2>/dev/null || true
cat >> .env.tmp <<EOF
MULTILOGIN_BASE_URL=https://launcher.mlx.yt:45001
MULTILOGIN_EMAIL=efsunlukemal@gmail.com
MULTILOGIN_PASSWORD=LakeGarda123/
MULTILOGIN_FOLDER_ID=0509ecba-935f-484b-bb1f-18c8370d1017
EOF
mv .env.tmp .env
echo ".env OK"

echo "== config driver=multilogin"
sed -i 's/"driver": "adspower"/"driver": "multilogin"/' config/default.json
grep '"driver"' config/default.json

echo "== 10 profil saglik turu (birkac dk surebilir)"
node scripts/mlx-health.mjs
echo "== BITTI"
