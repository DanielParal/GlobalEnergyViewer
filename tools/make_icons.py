#!/usr/bin/env python3
"""One-off: draw the app icons (site/icon-192.png, icon-512.png, icon.svg)
with the standard library only (zlib + struct)."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
BG = (22, 58, 110)       # dark blue
FG = (245, 197, 24)      # solar yellow
# lightning bolt in a 0..1 box
BOLT = [(0.56, 0.12), (0.28, 0.56), (0.47, 0.56), (0.40, 0.88), (0.72, 0.42), (0.53, 0.42), (0.62, 0.12)]


def inside_poly(x, y, poly):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def inside_rrect(x, y, r=0.2):
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def png(size: int) -> bytes:
    ss = 3  # supersampling for smooth edges
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            bg = fg = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    if inside_rrect(x, y):
                        bg += 1
                        if inside_poly(x, y, BOLT):
                            fg += 1
            n = ss * ss
            a = bg / n
            if bg:
                t = fg / bg
                rgb = [round(BG[k] * (1 - t) + FG[k] * t) for k in range(3)]
            else:
                rgb = [0, 0, 0]
            row += bytes(rgb + [round(a * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def svg() -> str:
    pts = " ".join(f"{x * 100:.0f},{y * 100:.0f}" for x, y in BOLT)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            f'<rect width="100" height="100" rx="20" fill="rgb{BG}"/>'
            f'<polygon points="{pts}" fill="rgb{FG}"/></svg>\n')


if __name__ == "__main__":
    for s in (192, 512):
        (SITE / f"icon-{s}.png").write_bytes(png(s))
    (SITE / "icon.svg").write_text(svg(), encoding="utf-8")
    print("icons written to", SITE)
