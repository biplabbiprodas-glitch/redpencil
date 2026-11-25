# Draws the Redpencil hexagon logo as the app icon (traced from the official logo).
from PIL import Image, ImageDraw
import os
BBOX = (199, 1, 628, 362)
DARK = [[(583, 101), (378, 244), (379, 362), (526, 360), (628, 184), (626, 175)],
        [(525, 1), (378, 1), (378, 225), (575, 89)],
        [(364, 1), (303, 1), (199, 179), (201, 187), (268, 302), (364, 234)]]
RED = [[(362, 259), (283, 313), (307, 356), (362, 356)]]
INK, REDC = (6, 6, 8, 255), (237, 28, 36, 255)

def draw(size, frac, bg):
    ss = 4; S = size * ss
    im = Image.new('RGBA', (S, S), bg); d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = BBOX; w, h = x1 - x0, y1 - y0
    k = S * frac / max(w, h); ox = (S - w * k) / 2; oy = (S - h * k) / 2
    f = lambda p: [(ox + (x - x0) * k, oy + (y - y0) * k) for x, y in p]
    for p in DARK: d.polygon(f(p), fill=INK)
    for p in RED: d.polygon(f(p), fill=REDC)
    return im.resize((size, size), Image.LANCZOS)

os.makedirs('www/icons', exist_ok=True); os.makedirs('assets', exist_ok=True)
WHITE = (255, 255, 255, 255)
for n in (192, 512): draw(n, 0.70, WHITE).save(f'www/icons/icon-{n}.png')
draw(1024, 0.66, WHITE).save('assets/icon-only.png')
draw(1024, 0.46, (0, 0, 0, 0)).save('assets/icon-foreground.png')
Image.new('RGBA', (1024, 1024), WHITE).save('assets/icon-background.png')
print('Redpencil logo icons written')
