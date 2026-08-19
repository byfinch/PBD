#!/bin/bash
# evidence-cleanup.sh — kanit klasoru hijyeni (gunluk timer ile calisir)
# debug-*  : 3 gunden eski silinir (ara/deneme screenshot'lari)
# kanit-*  : 14 gunden eski silinir (rapor + monitor kanitlari)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)/evidence"
[ -d "$DIR" ] || exit 0
find "$DIR" -maxdepth 1 -type f -name 'debug-*' -mtime +3 -delete
find "$DIR" -maxdepth 1 -type f -name 'kanit-*' -mtime +14 -delete
echo "evidence-cleanup: $(date -Iseconds) kalan=$(ls "$DIR" | wc -l)"
