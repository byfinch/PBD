#!/bin/bash
# vps-mailpit.sh — Mailpit kur (SMTP sink + API), systemd servisi
set -u
cd /tmp
curl -sL -o mailpit.tar.gz "https://github.com/axllent/mailpit/releases/latest/download/mailpit-linux-amd64.tar.gz" && echo "indirildi"
tar -xzf mailpit.tar.gz mailpit && mv mailpit /usr/local/bin/mailpit && chmod +x /usr/local/bin/mailpit && echo "kuruldu: $(mailpit version)"

echo "admin:pbd2026" > /etc/mailpit-auth && chmod 600 /etc/mailpit-auth
cat > /etc/systemd/system/mailpit.service <<'UNIT'
[Unit]
Description=Mailpit (catch-all SMTP + API)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/mailpit --listen 0.0.0.0:8025 --smtp 0.0.0.0:25 --ui-auth-file /etc/mailpit-auth
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now mailpit
sleep 3
echo "mailpit: $(systemctl is-active mailpit)"
ss -ltnp | grep -E ":25 |:8025" || echo "(port yok)"
# disaridan SMTP testi
curl -s --max-time 8 -o /dev/null -w "web UI (lokal): %{http_code}\n" http://127.0.0.1:8025/
echo "== BITTI"
