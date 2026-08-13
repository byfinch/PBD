#!/usr/bin/env python3
# check-text.py <img> <x> <y> <w> <h> — textarea'da gercek yazı var mi?
# Placeholder sadece ust satirlarda olur; dolu metin kutunun alt yarisina iner.
# "dolu" / "bos" basar.
import sys
from PIL import Image

img, x, y, w, h = sys.argv[1], *map(int, sys.argv[2:6])
im = Image.open(img).convert("L").crop((x, y, x + w, y + h))
W, H = im.size
lower = im.crop((0, int(H * 0.55), W, H))  # alt %45 — placeholder buraya asla inmez
px = list(lower.getdata())
bright = sum(1 for p in px if p > 110)
print("dolu" if bright > 40 else "bos")
