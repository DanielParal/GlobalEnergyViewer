#!/usr/bin/env python3
"""One-off: build site/europe.geojson from Natural Earth 1:50m countries.

    curl -L -o /tmp/ne.geojson \
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
    python tools/make_geojson.py /tmp/ne.geojson

Keeps Europe (+ neighbours around the Mediterranean), clips to a Europe
bounding box, simplifies (Douglas-Peucker) and rounds coordinates so the file
stays well below 300 kB. Natural Earth is public domain.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import config  # noqa: E402

BBOX = (-25.0, 28.0, 45.0, 72.0)  # lon_min, lat_min, lon_max, lat_max
TOLERANCE = 0.02                  # degrees
MIN_RING_AREA = 0.02              # sq. degrees; drops tiny islands
EXTRA = {"TR", "MA", "DZ", "TN", "CY", "GE", "SY", "LB", "IL", "JO", "IQ", "LY", "EG", "AM", "AZ", "IR", "SA"}
DROP = {"VA", "SM", "MC", "LI", "JE", "GG", "AD", "GI"}
MERGE = {"AX": "FI", "IM": "GB"}
CODE = {"GB": "uk", "GR": "gr"}


def clip_ring(ring, bbox):
    """Sutherland-Hodgman clip of a closed ring against an axis-aligned box."""
    x0, y0, x1, y1 = bbox
    edges = [
        (lambda p: p[0] >= x0, lambda a, b: (x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= x1, lambda a, b: (x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= y0, lambda a, b: (a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0)),
        (lambda p: p[1] <= y1, lambda a, b: (a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1)),
    ]
    pts = [tuple(p) for p in ring[:-1]] if ring[0] == ring[-1] else [tuple(p) for p in ring]
    for inside, cross in edges:
        if not pts:
            break
        out = []
        prev = pts[-1]
        for cur in pts:
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
            prev = cur
        pts = out
    if len(pts) < 3:
        return None
    return pts + [pts[0]]


def dp(points, tol):
    """Douglas-Peucker simplification (iterative)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = 0.0, None
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm if norm else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def area(ring):
    return abs(sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1))) / 2


def process_polygon(poly):
    out = []
    for n, ring in enumerate(poly):
        c = clip_ring(ring, BBOX)
        if c is None:
            if n == 0:
                return None
            continue
        s = dp(c, TOLERANCE)
        s = [[round(x, 2), round(y, 2)] for x, y in s]
        s = [p for i, p in enumerate(s) if i == 0 or p != s[i - 1]]
        if len(s) < 4 or area(s) < MIN_RING_AREA:
            if n == 0:
                return None
            continue
        out.append(s)
    return out or None


def main(src: str):
    doc = json.loads(Path(src).read_text(encoding="utf-8"))
    polys: dict[str, list] = {}
    names: dict[str, str] = {}
    for f in doc["features"]:
        p = f["properties"]
        iso = p.get("ISO_A2_EH") or p.get("ISO_A2")
        if iso in DROP or iso in (None, "-99"):
            continue
        if p.get("CONTINENT") != "Europe" and iso not in EXTRA:
            continue
        iso = MERGE.get(iso, iso)
        code = CODE.get(iso, iso.lower())
        g = f["geometry"]
        parts = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for part in parts:
            q = process_polygon(part)
            if q:
                polys.setdefault(code, []).append(q)
        names.setdefault(code, config.COUNTRY_INFO.get(code, {}).get("name", p.get("NAME")))

    features = []
    for code in sorted(polys):
        features.append({
            "type": "Feature",
            "properties": {"id": code, "name": names[code]},
            "geometry": {"type": "MultiPolygon", "coordinates": polys[code]},
        })
    out = {"type": "FeatureCollection",
           "_source": "Natural Earth 1:50m admin 0 countries (public domain), clipped and simplified",
           "features": features}
    path = ROOT / "site" / "europe.geojson"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{path.relative_to(ROOT)}: {len(features)} countries, {path.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
