#!/usr/bin/env python3
"""Generate epok's PWA icons. Owner: Window A.

Run once, commit the output. The app never runs this — there is no build step;
this is a tool that writes files, the same way scrape_catalog.py writes JSON.

    python3 tools/make-icons.py

The mark is a blocky E drawn from rectangles rather than set in a font, so the
icon does not depend on a font being installed and renders identically
everywhere. Ground is pure black and the accent is quasar's FF4081, matching
the default palette.
"""
from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parent.parent / "icons"
BG = (0, 0, 0, 255)
ACCENT = (255, 64, 129, 255)
LINE = (110, 96, 104, 255)          # --p-line-strong-d, quasar

# Fraction of the canvas the mark occupies. Maskable icons need a safe zone:
# Android crops to a circle of 80% width, so the mark sits inside 60%.
SIZES = [(192, "icon-192.png", 0.62), (512, "icon-512.png", 0.62),
         (512, "icon-maskable-512.png", 0.46), (180, "apple-touch-icon.png", 0.62)]


def draw_e(d: ImageDraw.ImageDraw, x: float, y: float, w: float, h: float) -> None:
    """A blocky E: one stem and three arms, all the same stroke weight."""
    s = w * 0.26                                  # stroke
    d.rectangle([x, y, x + s, y + h], fill=ACCENT)                 # stem
    d.rectangle([x, y, x + w, y + s], fill=ACCENT)                 # top arm
    d.rectangle([x, y + (h - s) / 2, x + w * 0.82, y + (h + s) / 2], fill=ACCENT)  # middle
    d.rectangle([x, y + h - s, x + w, y + h], fill=ACCENT)         # bottom arm


def build(size: int, name: str, scale: float) -> pathlib.Path:
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    # A hairline border, the one piece of chrome the whole visual direction allows.
    if scale > 0.5:
        w = max(1, size // 64)
        d.rectangle([0, 0, size - 1, size - 1], outline=LINE, width=w)
    mark_w = size * scale * 0.78
    mark_h = size * scale
    draw_e(d, (size - mark_w) / 2, (size - mark_h) / 2, mark_w, mark_h)
    path = OUT / name
    img.save(path, "PNG", optimize=True)
    return path


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for size, name, scale in SIZES:
        p = build(size, name, scale)
        print(f"{p.relative_to(OUT.parent)}  {size}x{size}  {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()
