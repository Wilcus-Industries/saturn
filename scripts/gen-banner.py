#!/usr/bin/env python3
"""Generate the README banner: ASCII Saturn + wordmark, transparent, light+dark.

Renders with ImageMagick. Run: python3 scripts/gen-banner.py
"""
import math
import subprocess
import sys
from pathlib import Path

COLS, ROWS = 44, 22          # char grid — small on purpose, so glyphs read as glyphs
TILT = math.radians(30)      # ring opening
SPIN = math.radians(-26)     # in-plane rotation, matches the old diagonal
R = 0.30                     # planet radius, in half-heights
RING = [(0.45, 0.60), (0.66, 0.97)]  # inner/outer pairs, gap = Cassini division
LIGHT = (-0.55, -0.5, 0.67)
PLANET_RAMP = " .:-=+*#%@"
RING_RAMP = " .:-=+*x"


def ascii_saturn() -> str:
    rows = []
    for j in range(ROWS):
        line = []
        for i in range(COLS):
            # screen coords, y down; x halved for the 1:2 character cell
            sx = (i + 0.5) / COLS * 2 - 1
            sy = (j + 0.5) / ROWS * 2 - 1
            sx *= COLS / ROWS * 0.5
            x = sx * math.cos(-SPIN) - sy * math.sin(-SPIN)
            y = sx * math.sin(-SPIN) + sy * math.cos(-SPIN)

            d = math.hypot(x, y)
            on_planet = d < R
            zp = math.sqrt(max(R * R - d * d, 0.0)) if on_planet else -1.0

            r = math.hypot(x, y / math.sin(TILT))
            zr = y / math.tan(TILT)   # +ve = near half, the one that crosses in front
            band = next((k for k, (a, b) in enumerate(RING) if a < r < b), None)

            ch = " "
            if band is not None and (not on_planet or zr > zp):
                # brighter mid-band, dimmer at the edges; far half falls off
                a, b = RING[band]
                t = (r - a) / (b - a)
                v = math.sin(math.pi * t) ** 0.6 * (0.55 if zr < 0 else 1.0)
                ch = RING_RAMP[min(int(v * len(RING_RAMP)), len(RING_RAMP) - 1)]
            elif on_planet:
                nx, ny, nz = x / R, y / R, zp / R
                lam = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]
                v = max(lam, 0.0) * 0.85 + 0.15
                ch = PLANET_RAMP[min(int(v * len(PLANET_RAMP)), len(PLANET_RAMP) - 1)]
            line.append(ch)
        rows.append("".join(line).rstrip())
    while rows and not rows[0]:
        rows.pop(0)
    while rows and not rows[-1]:
        rows.pop()
    return "\n".join(rows)


def render(art: str, out: Path, color: str, font: str, wordfont: str) -> None:
    tmp = out.parent / ".banner-ascii.txt"
    tmp.write_text(art)
    art_png = out.parent / ".banner-art.png"
    word_png = out.parent / ".banner-word.png"
    run = lambda *a: subprocess.run(a, check=True)
    run("magick", "-background", "none", "-fill", color, "-font", font,
        "-pointsize", "22", "-interline-spacing", "-4", f"label:@{tmp}", str(art_png))
    run("magick", "-background", "none", "-fill", color, "-font", wordfont,
        "-pointsize", "110", "label:Saturn", str(word_png))
    run("magick", str(art_png), str(word_png), "-background", "none",
        "-gravity", "center", "+smush", "40",
        "-bordercolor", "none", "-border", "40x30", str(out))
    for p in (tmp, art_png, word_png):
        p.unlink()


if __name__ == "__main__":
    art = ascii_saturn()
    lines = art.split("\n")
    # the walk is easy to break silently: assert a planet, both ring halves, and a hole
    assert max(map(len, lines)) <= COLS and len(lines) <= ROWS, "grid overflow"
    assert "@" in art, "no lit planet"
    assert "x" in art and "-" in art, "ring halves collapsed"
    assert any(" " in ln.strip() for ln in lines), "ring/planet gap closed up"
    print(art)
    d = Path(__file__).resolve().parent.parent / "public" / "art"
    sf = "/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts"
    mono, word = f"{sf}/SF-Mono-Medium.otf", f"{sf}/SF-Mono-Regular.otf"
    if "--print" not in sys.argv:
        render(art, d / "logo-landscape-light.png", "#0b0b0b", mono, word)
        render(art, d / "logo-landscape-dark.png", "#fafafa", mono, word)
        print("wrote", d / "logo-landscape-{light,dark}.png")
