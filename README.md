# PBD — Organic SERP SEO-Signal Automation

PBD arama motorunda keyword arayıp hedef siteyi **organik** sonuçlarda bulur, insan gibi tıklar ve sitede doğal davranır (dwell, scroll, iç link gezintisi). Amaç: hedef sitenin seçili keyword'lerde organik CTR / davranış sinyallerini güçlendirmek.

- Reklam tıklama / şikayet **yok** — tamamen organik akış.
- Antidetect profilleri: **AdsPower Local API** (varsayılan) veya **Multilogin X Local API v2** — `config/default.json` → `antidetect.driver`.
- TR proxy'ler profillere antidetect tarafında bağlı.
- Ölçek: 10–15 profil, gün-gün rampa (varsayılan 20 → 100 ziyaret/gün, 8 gün), profil/IP başına gün tavanı 10, 1–2 eşzamanlı tarayıcı.

## Kurulum

```bash
npm install
cp .env.example .env     # AdsPower/Multilogin + solver + panel bilgileri
npm run build
```

`config/default.json`:

- `sites` — hedef domainler ve keyword listeleri (ağırlık: `weight`)
- `ramp` — rampa parametreleri (başlangıç kotası, plato, gün sayısı, IP tavanı, saat pencereleri)
- `profiles` — `prefixes` (örn. `["PBD-"]`) veya açık `ids`
- `behavior` — dwell, scroll waypoint'leri, iç link, rakip-karşılaştırma, çıkış biçimi
- `solver` — 2captcha / CapSolver (`/sorry` kurtarma; opsiyonel)

## Komutlar

```bash
npm run web                  # panel (http://localhost:3080) + scheduler
npm run visit                # tek deneme ziyareti (--once)
node dist/index.js visit --once --profile <id> --keyword "..." --site example.com
npm run track                # tüm keyword'ler için pozisyon ölçümü (tıklamasız)
npm run profiles             # profil havuzunu listele
```

Panel giriş: `PANEL_USER` / `PANEL_PASSWORD` (varsayılan `admin` / `pbd`). Görünümler: Takvim (rampa + bugünkü plan), Pozisyonlar (trend), Ziyaretler (log), Sağlık (IP-trust vault).

## Mimari

- `src/antidetect/` — `AntidetectClient` interface + AdsPower / Multilogin driver'ları
- `src/serp/finder.ts` — organik SERP parser + hedef bulucu + tıklayıcı (reklam konteynerleri elenir)
- `src/behavior/siteVisit.ts` — davranış seti motoru (persona uyumlu)
- `src/calendar/ramp.ts` — gün-gün kota + deterministik günlük plan
- `src/rank/tracker.ts` — tıklamasız günlük pozisyon ölçümü
- `src/store/` — sqlite (`node:sqlite`, native build yok): visits, positions, sites, ip_trust vault
- `src/captcha/` — solver (2captcha/CapSolver) + bütçe politikası + /sorry kurtarma
- `src/engine.ts` — ana döngü: plan → saati gelen ziyaret → profil → SERP → tık → davranış → kapat

Veritabanı: `data/pbd.sqlite`.
