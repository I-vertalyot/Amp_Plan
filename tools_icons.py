"""Draw the Amp Plan app icons: a beige CRT bezel with a dark screen, a green power LED and three amp slots."""
from PIL import Image, ImageDraw
import pathlib
out = pathlib.Path(__file__).parent / 'pwa/icons'
def icon(size, maskable=False):
    S = 1024
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pad = 0 if maskable else 40
    bg = (221, 213, 193, 255)
    if maskable:
        d.rectangle([0, 0, S, S], fill=bg)
    else:
        d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=200, fill=bg, outline=(111, 104, 85, 255), width=14)
    # inner safe zone for maskable icons is the middle 80%
    m = 205 if maskable else 150
    d.rounded_rectangle([m, m, S - m, S - m], radius=60, fill=(27, 35, 30, 255))
    # three amp slots in zone colours
    cols = [(42, 120, 214, 255), (235, 104, 52, 255), (237, 161, 0, 255)]
    x0, x1 = m + 70, S - m - 70
    h = (S - 2 * m - 200) / 3
    for i, c in enumerate(cols):
        y = m + 120 + i * (h + 18)
        d.rounded_rectangle([x0, y, x1, y + h - 18], radius=14, fill=c)
    # green power LED
    r = 26
    cx, cy = m + 70 + r, m + 60
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(166, 227, 161, 255))
    return im.resize((size, size), Image.LANCZOS)
for s in (192, 512):
    icon(s).save(out / f'icon-{s}.png')
    icon(s, True).save(out / f'icon-maskable-{s}.png')
icon(180, True).convert('RGB').save(out / 'apple-touch-icon.png')
icon(32).save(out / 'favicon-32.png')
print(sorted(p.name for p in out.iterdir()))
