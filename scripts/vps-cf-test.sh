#!/bin/bash
# VPS'te CF-Abuse dry-run testi
set -u
cd /opt/pbd && git pull -q origin main && echo "pull OK"
cd cf-abuse
node report.mjs --target "https://bd3685.icefactory.cl/" --brand "OpenPhish feed entry" --profile PBD-08 --dry
echo "== BITTI"
