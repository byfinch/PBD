#!/bin/bash
# vps-fix20: proxy'leri Multilogin'siz dogrudan test et (suçlu kim?)
set -u
PASS='uDdliaN2SU'
for u in GMscFKpZ_1 GMscFKpZ_2 GMscFKpZ_5; do
  echo "== $u"
  IP=$(curl -s --max-time 20 --socks5-hostname "$u:$PASS@79.127.168.43:50101" https://api.ipify.org 2>&1)
  echo "  ipify: ${IP:-TIMEOUT/HATA}"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 --socks5-hostname "$u:$PASS@79.127.168.43:50101" "https://www.google.com/search?q=test&hl=tr" 2>&1)
  echo "  google: $CODE"
done
echo "== MLX agent log (son proxy satirlari)"
journalctl -u mlx-agent -n 200 --no-pager 2>/dev/null | grep -i "proxy" | tail -6
echo "== BITTI"
