#!/bin/bash
# vps-fix15: proxy env + profil havuzu dogrulama (node dist/index.js profiles)
set -u
cd /opt/pbd 2>/dev/null || cd /root/PBD || { echo "PBD dizini yok"; exit 1; }
git pull -q origin main && echo "pull OK"
npm install --silent >/dev/null 2>&1 && echo "npm OK"
npm run build >/dev/null 2>&1 && echo "build OK" || { echo "BUILD FAIL"; exit 1; }

grep -v "^MULTILOGIN_PROXY_" .env > .env.tmp 2>/dev/null || true
cat >> .env.tmp <<EOF
MULTILOGIN_PROXY_HOST=79.127.168.43
MULTILOGIN_PROXY_PORT=50101
MULTILOGIN_PROXY_PASSWORD=uDdliaN2SU
EOF
mv .env.tmp .env
echo ".env proxy OK"

echo "== profil havuzu"
node dist/index.js profiles 2>&1 | tail -14
echo "== BITTI"
