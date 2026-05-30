"""Generate the app icon (assets/icon.ico) from the ツCKヤ DPS Meter branding.

A dark rounded tile with a pink->cyan "CK" monogram (the app's brand colors).
Regenerate with:  uv run python assets/make_icon.py
Outputs a multi-resolution .ico (16/24/32/48/64/128/256) next to this script.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
S = 256  # master size; .ico downscales to the standard sizes
RADIUS = 52

BG_TOP = (30, 41, 59)     # slate-800
BG_BOT = (8, 14, 26)      # near-black navy
PINK = (236, 72, 153)     # brand pink
CYAN = (56, 189, 248)     # brand cyan


def _font(size: int) -> ImageFont.FreeTypeFont:
    for name in ("segoeuib.ttf", "arialbd.ttf", "seguisb.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _vertical_gradient(w: int, h: int, top, bot) -> Image.Image:
    grad = Image.new("RGB", (w, h))
    px = grad.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        col = tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = col
    return grad


def main() -> None:
    # rounded-tile background with a vertical gradient
    bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = _vertical_gradient(S, S, BG_TOP, BG_BOT).convert("RGBA")
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS, fill=255)
    bg.paste(grad, (0, 0), mask)

    # "CK" monogram, sized to fit, filled with a horizontal pink->cyan gradient
    font = _font(150)
    text = "CK"
    tmask = Image.new("L", (S, S), 0)
    td = ImageDraw.Draw(tmask)
    bbox = td.textbbox((0, 0), text, font=font, stroke_width=0)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (S - tw) / 2 - bbox[0]
    ty = (S - th) / 2 - bbox[1]
    td.text((tx, ty), text, fill=255, font=font)

    tgrad = Image.new("RGB", (S, S))
    tpx = tgrad.load()
    for x in range(S):
        t = x / (S - 1)
        col = tuple(round(PINK[i] + (CYAN[i] - PINK[i]) * t) for i in range(3))
        for y in range(S):
            tpx[x, y] = col
    bg.paste(tgrad, (0, 0), tmask)

    sizes = [16, 24, 32, 48, 64, 128, 256]
    out = HERE / "icon.ico"
    bg.save(out, format="ICO", sizes=[(s, s) for s in sizes])
    print(f"wrote {out} ({out.stat().st_size} bytes; sizes {sizes})")


if __name__ == "__main__":
    main()
