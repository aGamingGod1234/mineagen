#!/usr/bin/env python3
"""Generates the control center's GUI sprites: rounded shapes, one soft shadow and the icon set.

Minecraft draws GUI sprites point-sampled, so hi-res art scaled by a non-integer factor gets uneven corners.
Every sprite is therefore rendered once per GUI scale at exactly one texel per screen pixel, and the client
picks the set that matches the current scale (ConsoleDraw). Shapes are white and tinted at draw time.

Usage: python3 scripts/generate-console-sprites.py   (needs Pillow; rewrites the console sprite folder)
"""
import json
import math
import os
import shutil

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "main", "resources", "assets",
                    "mineagen", "textures", "gui", "sprites", "console")
SCALES = range(1, 7)
ICON_SCALES = range(1, 5)
RADII = (3, 4, 6, 8)
SHADOW_BLUR = 10  # GUI px the panel shadow spreads past its edge
SS = 8  # supersampling factor for anti-aliasing


def save(img, name, border=None):
    path = os.path.join(ROOT, name + ".png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    if border is not None:
        meta = {"gui": {"scaling": {"type": "nine_slice", "width": img.width, "height": img.height, "border": border}}}
        with open(path + ".mcmeta", "w") as handle:
            json.dump(meta, handle)


def rounded(size, radius, ring=0):
    big = Image.new("L", (size * SS, size * SS), 0)
    draw = ImageDraw.Draw(big)
    draw.rounded_rectangle((0, 0, size * SS - 1, size * SS - 1), radius * SS, fill=255)
    if ring:
        inner = ring * SS
        draw.rounded_rectangle((inner, inner, size * SS - 1 - inner, size * SS - 1 - inner),
                               max(0, radius - ring) * SS, fill=0)
    mask = big.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    out.putalpha(mask)
    return out


def shapes():
    for scale in SCALES:
        for radius in RADII:
            r = radius * scale
            size = r * 2 + 2
            save(rounded(size, r), f"fill_r{radius}_s{scale}", r)
            save(rounded(size, r, ring=scale), f"ring_r{radius}_s{scale}", r)
        # Panel shadow: an 8 px rounded slab blurred past its edge, black, tinted for strength at draw time.
        blur = SHADOW_BLUR * scale
        r = 8 * scale
        border = blur + r
        size = border * 2 + 2
        slab = Image.new("L", (size, size), 0)
        ImageDraw.Draw(slab).rounded_rectangle((blur, blur, size - 1 - blur, size - 1 - blur), r, fill=255)
        slab = slab.filter(ImageFilter.GaussianBlur(blur / 2.2))
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.putalpha(slab)
        save(out, f"shadow_s{scale}", border)


# Icons are drawn on a 24-unit grid with 2-unit round strokes, then rendered at 12 GUI px per scale.
def icon_paths():
    def line(*points):
        return ("line", points)

    def arc(cx, cy, r, start, end):
        return ("arc", (cx, cy, r, start, end))

    def circle(cx, cy, r, fill=False):
        return ("circle", (cx, cy, r, fill))

    def poly(*points):
        return ("poly", points)

    return {
        "plus": [line((12, 5), (12, 19)), line((5, 12), (19, 12))],
        "refresh": [arc(12, 12, 7.5, 40, 330), line((19.5, 4), (19.5, 9), (14.5, 9))],
        "key": [circle(8, 15.5, 4.5), line((11.2, 12.3), (20, 3.5)), line((16, 7.5), (19, 10.5)), line((18.3, 5.2), (20.5, 7.4))],
        "chevron_down": [line((6, 9.5), (12, 15.5), (18, 9.5))],
        "chevron_left": [line((14.5, 6), (8.5, 12), (14.5, 18))],
        "chevron_right": [line((9.5, 6), (15.5, 12), (9.5, 18))],
        "check": [line((5, 12.5), (10, 17.5), (19, 7))],
        "play": [poly((8, 5.5), (18.5, 12), (8, 18.5))],
        "pause": [line((9, 6), (9, 18)), line((15, 6), (15, 18))],
        "trash": [line((4.5, 7), (19.5, 7)), line((9.5, 7), (9.5, 4.5), (14.5, 4.5), (14.5, 7)),
                  line((6.5, 7), (7.5, 19.5), (16.5, 19.5), (17.5, 7)), line((10.5, 11), (10.5, 16)), line((13.5, 11), (13.5, 16))],
        "terminal": [line((5, 8), (9.5, 12), (5, 16)), line((12, 17), (19, 17))],
        "map": [line((3.5, 6.5), (9, 4.5), (15, 6.5), (20.5, 4.5), (20.5, 17.5), (15, 19.5), (9, 17.5), (3.5, 19.5), (3.5, 6.5)),
                line((9, 4.5), (9, 17.5)), line((15, 6.5), (15, 19.5))],
        "spark": [poly((12, 3), (14, 10), (21, 12), (14, 14), (12, 21), (10, 14), (3, 12), (10, 10))],
        "task": [line((4.5, 6.5), (6.5, 8.5), (9.5, 5)), line((12.5, 7), (19.5, 7)),
                 line((4.5, 15.5), (6.5, 17.5), (9.5, 14)), line((12.5, 16), (19.5, 16))],
        "respawn": [arc(12, 12, 7.5, 210, 500), line((4.5, 4.5), (4.5, 9.5), (9.5, 9.5))],
        "agents": [circle(12, 8.5, 3.8), arc(12, 21.5, 7.5, 200, 340)],
        "back": [line((19, 12), (5, 12)), line((11, 6), (5, 12), (11, 18))],
        "eye": [arc(12, 18, 10, 215, 325), arc(12, 6, 10, 35, 145), circle(12, 12, 2.6)],
    }


def draw_icon(ops, size):
    unit = size * SS / 24.0
    stroke = max(1.0, 2.0 * unit)
    big = Image.new("L", (size * SS, size * SS), 0)
    draw = ImageDraw.Draw(big)

    def p(point):
        return (point[0] * unit, point[1] * unit)

    def dot(point):
        x, y = p(point)
        draw.ellipse((x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2), fill=255)

    for kind, data in ops:
        if kind == "line":
            points = [p(point) for point in data]
            draw.line(points, fill=255, width=int(round(stroke)), joint="curve")
            for point in data:
                dot(point)
        elif kind == "poly":
            draw.polygon([p(point) for point in data], fill=255)
        elif kind == "circle":
            cx, cy, r, fill = data
            box = ((cx - r) * unit, (cy - r) * unit, (cx + r) * unit, (cy + r) * unit)
            if fill:
                draw.ellipse(box, fill=255)
            else:
                draw.ellipse(box, outline=255, width=int(round(stroke)))
        elif kind == "arc":
            cx, cy, r, start, end = data
            box = ((cx - r) * unit, (cy - r) * unit, (cx + r) * unit, (cy + r) * unit)
            draw.arc(box, start, end, fill=255, width=int(round(stroke)))
            for angle in (start, end):
                dot((cx + r * math.cos(math.radians(angle)), cy + r * math.sin(math.radians(angle))))
    mask = big.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    out.putalpha(mask)
    return out


def logo(size):
    """The Mineagen mark: a faceted diamond in three tones of the product cyan."""
    big = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(big)
    u = size * SS / 16.0
    top, mid_y, bottom = 1.5 * u, 6 * u, 14.5 * u
    left, right, cx = 1 * u, 15 * u, 8 * u
    crown_l, crown_r = 4.5 * u, 11.5 * u
    draw.polygon([(crown_l, top), (crown_r, top), (right, mid_y), (left, mid_y)], fill=(170, 238, 255, 255))
    draw.polygon([(left, mid_y), (cx, mid_y), (cx, bottom)], fill=(95, 212, 244, 255))
    draw.polygon([(cx, mid_y), (right, mid_y), (cx, bottom)], fill=(48, 160, 205, 255))
    draw.polygon([(crown_l, top), (cx, mid_y), (crown_r, top)], fill=(214, 248, 255, 255))
    return big.resize((size, size), Image.LANCZOS)


def icons():
    for name, ops in icon_paths().items():
        for scale in ICON_SCALES:
            save(draw_icon(ops, 12 * scale), f"icon/{name}_s{scale}")
    for scale in ICON_SCALES:
        save(logo(16 * scale), f"icon/logo_s{scale}")


if __name__ == "__main__":
    shutil.rmtree(ROOT, ignore_errors=True)
    shapes()
    icons()
    count = sum(len([f for f in files if f.endswith(".png")]) for _, _, files in os.walk(ROOT))
    print(f"wrote {count} sprites to {os.path.relpath(ROOT)}")
