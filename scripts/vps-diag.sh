#!/bin/bash
echo "=== pbd service log ==="
journalctl -u pbd --no-pager -n 15 | tail -12
echo ""
echo "=== pbd manuel deneme (5sn) ==="
cd /opt/pbd && timeout 5 node dist/index.js web -p 3080 2>&1 | head -8
echo ""
echo "=== profile start RAW (PBD-01) ==="
MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
TOKEN=$(curl -s -X POST https://api.multilogin.com/user/signin -H 'Content-Type: application/json' -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null)
echo "-- v2 yolu:"
curl -s --max-time 60 "http://localhost:35000/api/v2/profile/f/0509ecba-935f-484b-bb1f-18c8370d1017/p/8dd1898f-570f-4dac-a193-46ec9a36e3f8/start?automation_type=playwright&headless_mode=true" -H "Authorization: Bearer $TOKEN" | head -c 400
echo ""
echo "-- v1 yolu:"
curl -s --max-time 60 "http://localhost:35000/api/v1/profile/start?automation=true&profileId=8dd1898f-570f-4dac-a193-46ec9a36e3f8" | head -c 400
echo ""
echo "=== agent log ==="
tail -8 /var/log/ml.log
