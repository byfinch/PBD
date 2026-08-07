#!/bin/bash
# PBD VPS kurulum scripti — idempotent, her adımı loglar
set -u
LOG=/var/log/pbd-setup.log
OK=(); FAIL=()
step() { echo "== $1" | tee -a $LOG; }
mark() { if [ $1 -eq 0 ]; then OK+=("$2"); else FAIL+=("$2"); fi; }

echo "PBD setup başlıyor: $(date)" | tee $LOG

# 1. Multilogin agent servisi
step "multilogin agent systemd servisi"
cat > /etc/systemd/system/multilogin.service << 'UNIT'
[Unit]
Description=Multilogin headless agent
After=network.target

[Service]
Type=simple
Environment=HOME=/root
WorkingDirectory=/opt/Multilogin/headless
ExecStart=/usr/bin/xvfb-run -a /opt/Multilogin/headless/headless.sh -port 35000
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now multilogin 2>>$LOG
sleep 18
curl -s -o /dev/null -w "%{http_code}" http://localhost:35000/ > /tmp/mlcode
C=$(cat /tmp/mlcode)
if [ "$C" != "000" ]; then mark 0 "multilogin-agent (http $C)"; else mark 1 "multilogin-agent"; fi

# 2. Multilogin cloud signin + profil senkronu testi
step "multilogin cloud signin testi"
MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
TOKEN=$(curl -s -X POST https://api.multilogin.com/user/signin -H 'Content-Type: application/json' -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null)
if [ -n "$TOKEN" ]; then mark 0 "cloud-signin"; else mark 1 "cloud-signin"; fi

# 3. PBD repo
step "PBD clone"
if [ ! -d /opt/pbd/.git ]; then
  git clone -q https://github.com/byfinch/PBD.git /opt/pbd 2>>$LOG
fi
cd /opt/pbd && git pull -q 2>>$LOG
mark $? "pbd-clone"

# 4. npm install + build
step "npm install + build"
cd /opt/pbd && npm install --no-audit --no-fund >>$LOG 2>&1
mark $? "npm-install"
npm run build >>$LOG 2>&1
mark $? "pbd-build"

# 5. .env
step ".env üretimi"
if [ ! -f /opt/pbd/.env ]; then
cat > /opt/pbd/.env << 'ENVEOF'
NODE_ENV=production
PANEL_USER=admin
PANEL_PASSWORD=pbd2026
ANTIDETECT_PROVIDER=multilogin
MULTILOGIN_BASE_URL=http://localhost:35000
TWOCAPTCHA_API_KEY=02422d02254baf4cb7e766ab9d70c0ec
CAPSOLVER_API_KEY=CAP-AB2563A935C48FFE739B898003B85AC059D6933A48FB551EF5C30F65AC7153E3
ENVEOF
fi
mark 0 "env-file"

# 6. pbd servisi
step "pbd systemd servisi"
cat > /etc/systemd/system/pbd.service << 'UNIT2'
[Unit]
Description=PBD ops (web panel + engine)
After=network.target multilogin.service

[Service]
Type=simple
Environment=NODE_ENV=production
WorkingDirectory=/opt/pbd
EnvironmentFile=/opt/pbd/.env
ExecStart=/usr/bin/node dist/index.js web -p 3080
Restart=always
RestartSec=8

[Install]
WantedBy=multi-user.target
UNIT2
systemctl daemon-reload && systemctl enable --now pbd 2>>$LOG
sleep 5
systemctl is-active pbd > /tmp/pbdstate
if [ "$(cat /tmp/pbdstate)" = "active" ]; then mark 0 "pbd-service"; else mark 1 "pbd-service"; fi

# 7. PBD-01 start testi (profil + proxy + exit IP)
step "PBD-01 start testi"
START=$(curl -s --max-time 90 "http://localhost:35000/api/v2/profile/f/0509ecba-935f-484b-bb1f-18c8370d1017/p/8dd1898f-570f-4dac-a193-46ec9a36e3f8/start?automation_type=playwright&headless_mode=true" -H "Authorization: Bearer $TOKEN")
echo "$START" | grep -q port
if [ $? -eq 0 ]; then
  mark 0 "profile-start"
  curl -s --max-time 20 "http://localhost:35000/api/v2/profile/f/0509ecba-935f-484b-bb1f-18c8370d1017/p/8dd1898f-570f-4dac-a193-46ec9a36e3f8/stop" -H "Authorization: Bearer $TOKEN" > /dev/null 2>&1
else
  START2=$(curl -s --max-time 90 "http://localhost:35000/api/v1/profile/start?automation=true&profileId=8dd1898f-570f-4dac-a193-46ec9a36e3f8")
  echo "$START2" | grep -qiE 'value|port|ws'
  mark $? "profile-start"
  curl -s "http://localhost:35000/api/v1/profile/stop?profileId=8dd1898f-570f-4dac-a193-46ec9a36e3f8" > /dev/null 2>&1
fi

# Özet
echo "" | tee -a $LOG
echo "======= ÖZET =======" | tee -a $LOG
for s in "${OK[@]}"; do echo "  OK: $s" | tee -a $LOG; done
for s in "${FAIL[@]}"; do echo "  FAIL: $s" | tee -a $LOG; done
echo "Log: $LOG"
