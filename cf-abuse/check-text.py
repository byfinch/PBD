#!/usr/bin/env python3
# check-text.py <img> <x> <y> <w> <h> <vwW> — textarea'da gercek yazi var mi?
# Koordinatlar CSS/viewport birimi; goruntu DPR yuzunden daha genis olabilir,
# bu yuzden vwW ile olceklendirilir. "dolu" / "bos" basar.
import sys
from PIL import Image

img = sys.argv[1]
x, y, w, h, vw = map(float, sys.argv[2:7])
im = Image.open(img).convert("L")
s = im.size[0] / vw if vw else 1.0
im = im.crop((int(x * s), int(y * s), int((x + w) * s), int((y + h) * s)))
W, H = im.size
lower = im.crop((0, int(H * 0.55), W, H))  # alt %45 — placeholder buraya asla inmez
px = list(lower.getdata())
bright = sum(1 for p in px if p > 110)
print("dolu" if bright > 40 else "bos")
