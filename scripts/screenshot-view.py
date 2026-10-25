#!/usr/bin/env python3
"""Render an Android screenshot: crop, scale to maxWidth, optional 100px grid.
Usage: python3 screenshot-view.py SOURCE.png OUT.png OPTIONS_JSON
OPTIONS (flat): x, y, width, height  (crop in source/device pixels), maxWidth, grid, sourceWidth, sourceHeight
Prints: {"width": W, "height": H}
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont


def main():
    source, output, options = sys.argv[1], sys.argv[2], sys.argv[3]
    o = json.loads(options)
    im = Image.open(source).convert("RGB")
    if list(im.size) != [int(o["sourceWidth"]), int(o["sourceHeight"])]:
        raise ValueError(
            "Captured image size differs from source geometry; take another screenshot"
        )
    x, y, w, h = (int(o[k]) for k in ("x", "y", "width", "height"))
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > im.width or y + h > im.height:
        raise ValueError("Crop is outside screenshot")
    im = im.crop((x, y, x + w, y + h))
    scale = min(1.0, int(o["maxWidth"]) / w)
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    if im.size != size:
        im = im.resize(size, Image.Resampling.LANCZOS)
    if o.get("grid"):
        grid = Image.new("RGBA", im.size)
        draw = ImageDraw.Draw(grid)
        font = ImageFont.load_default(size=12)
        for gx in range(0, im.width, 100):
            draw.line((gx, 0, gx, im.height), fill=(255, 255, 255, 80))
            draw.text((gx + 2, 2), str(gx), font=font, fill="white", stroke_width=2, stroke_fill="black")
        for gy in range(0, im.height, 100):
            draw.line((0, gy, im.width, gy), fill=(255, 255, 255, 80))
            draw.text((2, gy + 2), str(gy), font=font, fill="white", stroke_width=2, stroke_fill="black")
        im = Image.alpha_composite(im.convert("RGBA"), grid).convert("RGB")
    im.save(output)
    print(json.dumps({"width": im.width, "height": im.height}))


if __name__ == "__main__":
    main()
