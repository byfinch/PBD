# -*- coding: utf-8 -*-
"""find-widget.py <screenshot> — Turnstile checkbox'inin viewport koordinatini
piksel analiziyle bulur. Cikti: "x,y" ya da "yok"."""
import sys
from PIL import Image

path = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "find"   # find | verify
im = Image.open(path).convert("RGB")
w, h = im.size
px = im.load()

def is_orange(r, g, b):
    return r > 200 and 100 < g < 180 and b < 80

def is_green(r, g, b):
    return g > 150 and r < 120 and b < 140

# turnstile widget bolgesi adaylarini tara (sag alt bloklar icin de ustte olabilir)
orange_pts = []
for y in range(0, h, 3):
    for x in range(0, w, 3):
        r, g, b = px[x, y]
        if is_orange(r, g, b):
            orange_pts.append((x, y))

if not orange_pts:
    print("yok"); sys.exit(0)

# sayfa ustundeki logo (header) disla: en buyuk y'li cluster'lar aday (widget altta)
# header logosu genelde y < 120. onlari at.
cands = [(x, y) for (x, y) in orange_pts if y > 120]
if not cands:
    cands = orange_pts
# en alttaki yogun cluster
cands.sort(key=lambda p: p[1])
band_y = sum(p[1] for p in cands[-60:]) / min(60, len(cands))
band = [p for p in cands if abs(p[1] - band_y) < 40]
if not band:
    print("yok"); sys.exit(0)
cx = sum(p[0] for p in band) / len(band)
cy = sum(p[1] for p in band) / len(band)
# logo widget'in SAGINDA — checkbox yaklasik 240-280px solda
cbx = cx - 247
cby = cy + 10

if mode == "submit":
    # mavi Submit butonunu bul (kumo-brand mavisi)
    blue_pts = []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if b > 150 and r < 110 and 50 < g < 170:
                blue_pts.append((x, y))
    if not blue_pts:
        print("yok"); sys.exit(0)
    # yogunluk bandi: buton blok halinde mavi, linkler seyrek — en yogun 20px bandi al
    from collections import Counter
    bands = Counter(y // 20 for (x, y) in blue_pts)
    best_band = max(bands, key=lambda b: bands[b])
    band_pts = [(x, y) for (x, y) in blue_pts if y // 20 == best_band]
    cx = sum(p[0] for p in band_pts) / len(band_pts)
    cy = sum(p[1] for p in band_pts) / len(band_pts)
    print(f"{int(cx)},{int(cy)}")
    sys.exit(0)

if mode == "verify":
    # logo'nun y-bandinda (widget satiri) herhangi bir yerde yesil tik ara —
    # tema/konum bagimsiz (acik temada checkbox ofseti farkli, koyuda da tutar)
    for yy in range(int(cy) - 45, int(cy) + 45):
        for xx in range(0, w):
            if 0 <= yy < h and is_green(*px[xx, yy]):
                print("yesil")
                sys.exit(0)
    print("yesil-yok")
    sys.exit(0)

# guard: widget sayfanin alt yarisinda olmali; ustteki tek turuncu header logosudur
if band_y < h * 0.35:
    print("yok"); sys.exit(0)
print(f"{int(cbx)},{int(cby)}")
