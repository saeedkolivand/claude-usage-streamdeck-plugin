#!/usr/bin/env python3
"""Generate Stream Deck icon assets for the Claude Usage plugin."""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.join(os.path.dirname(__file__), "com.saeedkolivand.claude-usage.sdPlugin", "imgs")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

BG = (15, 18, 22, 255)        # #0f1216
TRACK = (35, 40, 47, 255)     # #23282f
CORAL = (217, 119, 87, 255)   # #d97757  (Claude accent)
WHITE = (245, 245, 245, 255)

SS = 4  # supersample factor for crisp downscaling


def make(size, glyph=True, ring_pct=0.72, pad_ratio=0.10, corner_ratio=0.18):
    """Render one icon at `size`px (square)."""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # rounded dark background
    corner = int(s * corner_ratio)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=corner, fill=BG)

    # ring
    pad = int(s * pad_ratio)
    stroke = max(2 * SS, int(s * 0.085))
    box = [pad + stroke, pad + stroke, s - pad - stroke, s - pad - stroke]
    # full faint track
    d.arc(box, start=0, end=360, fill=TRACK, width=stroke)
    # coral progress arc, starting at top (-90deg)
    d.arc(box, start=-90, end=-90 + int(360 * ring_pct), fill=CORAL, width=stroke)

    # center "C"
    if glyph:
        fs = int(s * 0.46)
        try:
            font = ImageFont.truetype(FONT, fs)
        except Exception:
            font = ImageFont.load_default()
        tb = d.textbbox((0, 0), "C", font=font)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        d.text(((s - tw) / 2 - tb[0], (s - th) / 2 - tb[1]), "C", font=font, fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


def save_pair(rel_base, logical):
    """Save <base>.png (logical px) and <base>@2x.png (2x)."""
    path1 = os.path.join(ROOT, rel_base + ".png")
    path2 = os.path.join(ROOT, rel_base + "@2x.png")
    os.makedirs(os.path.dirname(path1), exist_ok=True)
    make(logical).save(path1)
    make(logical * 2).save(path2)
    print(f"  {rel_base}.png ({logical}px) + @2x ({logical*2}px)")


print("Generating icons ->", ROOT)
save_pair("category-icon", 28)
save_pair("plugin-icon", 256)
save_pair(os.path.join("actions", "meter", "icon"), 20)
save_pair(os.path.join("actions", "meter", "key"), 72)
print("done.")
