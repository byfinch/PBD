#!/usr/bin/env python3
# check-green.py <img> <x> <y> <w> <h> — bolgede yesil tik var mi? (reCAPTCHA anchor)
# Google yesili ~ (52,168,83). "yesil" / "yok" basar.
import sys
from PIL import Image

img = sys.argv[1]
x, y, w, h = map(int, map(float, sys.argv[2:6]))
im = Image.open(img).convert("RGB").crop((x, y, x + w, y + h))
n = 0
for r, g, b in im.getdata():
    if g > 120 and g > r + 30 and g > b + 20 and r < 120:
        n += 1
print("yesil" if n > 15 else "yok")
