#!/bin/bash
# layoutMetrics clientWidth vs screenshot piksel olcusu
set -u
cd /opt/pbd && git pull -q origin main
MD5=$(echo -n 'LakeGarda123/' | md5sum | cut -d' ' -f1)
TOKEN=$(curl -s --max-time 20 -X POST https://api.multilogin.com/user/signin -H 'Content-Type: application/json' \
  -d "{\"email\":\"efsunlukemal@gmail.com\",\"password\":\"$MD5\"}" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
F=0509ecba-935f-484b-bb1f-18c8370d1017
P=a8ef6245-8c8d-4499-acba-8b80e4cd5d0f  # PBD-08
L="https://launcher.mlx.yt:45001"
curl -sk --max-time 15 "$L/api/v1/profile/stop/p/$P" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1
sleep 3
RESP=$(curl -sk --max-time 90 "$L/api/v2/profile/f/$F/p/$P/start?automation_type=playwright&headless_mode=false" -H "Authorization: Bearer $TOKEN")
PORT=$(echo "$RESP" | tr -d ' ' | grep -o '"port":"\?[0-9]\+' | grep -o '[0-9]\+' | head -1)
echo "port: $PORT"
[ -z "$PORT" ] && { echo "$RESP" | head -c 200; exit 1; }
node - "$PORT" <<'NODE'
const port = process.argv[2];
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: "https://abuse.cloudflare.com/phishing" });
  await new Promise((s) => setTimeout(s, 30000));
  const lm = await cdp("Page.getLayoutMetrics");
  const vv = lm.result?.visualViewport ?? lm.result;
  console.log("CSS viewport:", JSON.stringify({ w: vv?.clientWidth, h: vv?.clientHeight }));
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/metrics.png", Buffer.from(shot.result.data, "base64"));
  const { execSync } = await import("node:child_process");
  console.log("screenshot px:", execSync("python3 -c \"from PIL import Image; print(Image.open('/tmp/metrics.png').size)\"").toString().trim());
  ws.close();
  process.exit(0);
})();
NODE
curl -sk --max-time 15 "$L/api/v1/profile/stop/p/$P" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1
echo "== BITTI"
