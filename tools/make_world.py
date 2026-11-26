#!/usr/bin/env python3
"""One-off: build site/world.geojson and pipeline/world_entities.json.

    curl -L -o /tmp/ne.geojson \
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
    python pipeline/fetch_world.py          # entity list comes from data/raw/world/
    python tools/make_world.py /tmp/ne.geojson

- world.geojson: Natural Earth 1:50m countries (public domain), simplified,
  without Antarctica, one feature per Ember country (`id` = ISO 3166 alpha-3).
  French overseas departments are split off France as Ember reports them
  separately.
- world_entities.json: Czech name (CLDR via Node's Intl.DisplayNames), ISO
  alpha-2 and region of every Ember country. Regions follow Ember's own
  aggregates; the membership below reproduces their sums (see --check).
Needs `node` for the Czech names.
"""
from __future__ import annotations

import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
sys.path.insert(0, str(ROOT / "tools"))
import config  # noqa: E402
from make_geojson import area, dp  # noqa: E402

TOLERANCE = 0.06       # degrees
MIN_RING_AREA = 0.05   # sq. degrees; smaller islands are dropped (the largest part of a country is kept)
DROP = {"ATA", "ATF"}  # Antarctica, French Southern Territories

# Parts of France's MultiPolygon that Ember reports as separate entities: code -> bbox
FRANCE_SPLIT = {
    "GUF": (-55, 1, -51, 6.5),
    "GLP": (-62, 15.8, -60.9, 16.6),
    "MTQ": (-61.3, 14.3, -60.7, 15),
    "REU": (55, -21.5, 56, -20.8),
}
# Entities Natural Earth does not have as a country (ISO alpha-2, region)
MANUAL = {"XKX": ("XK", "europe"), "GUF": ("GF", "latin_america"), "GLP": ("GP", "latin_america"),
          "MTQ": ("MQ", "latin_america"), "REU": ("RE", "africa")}
NAME_FIX = {"HK": "Hongkong", "MO": "Macao", "CD": "DR Kongo", "CG": "Kongo", "PS": "Palestina",
            "MM": "Myanmar", "US": "USA", "GB": "Velká Británie", "VG": "Britské Panenské ostrovy",
            "VI": "Americké Panenské ostrovy", "BA": "Bosna a Hercegovina"}


def region_of(iso3: str, p: dict) -> str:
    """Ember's grouping; differs from Natural Earth's continents in a few places."""
    cont, sub = p.get("CONTINENT"), p.get("SUBREGION")
    if iso3 in ("TUR", "CYP"):
        return "europe"
    if iso3 in ("ARM", "AZE", "GEO", "MDV"):
        return "asia"
    if iso3 == "IRN" or sub == "Western Asia":
        return "middle_east"
    if iso3 in ("MUS", "SYC"):
        return "africa"
    if cont == "North America":
        return "north_america" if iso3 in ("USA", "CAN", "GRL", "BMU", "SPM") else "latin_america"
    return {"Europe": "europe", "Asia": "asia", "Africa": "africa", "Oceania": "oceania",
            "South America": "latin_america"}[cont]


def iso3_of(p: dict) -> str | None:
    if p.get("ADM0_A3") == "KOS":
        return "XKX"
    for k in ("ISO_A3_EH", "ISO_A3", "ADM0_A3"):
        v = p.get(k)
        if v and v != "-99":
            return v
    return None


def simplify_polygon(poly):
    out = []
    for n, ring in enumerate(poly):
        s = dp([tuple(pt) for pt in ring], TOLERANCE)
        s = [[round(x, 2), round(y, 2)] for x, y in s]
        s = [pt for i, pt in enumerate(s) if i == 0 or pt != s[i - 1]]
        if len(s) < 4:
            if n == 0:
                return None
            continue
        out.append(s)
    return out or None


def in_bbox(poly, bbox):
    xs = [pt[0] for pt in poly[0]]
    ys = [pt[1] for pt in poly[0]]
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    return bbox[0] <= cx <= bbox[2] and bbox[1] <= cy <= bbox[3]


def czech_names(iso2s: list[str]) -> dict[str, str]:
    js = ("const dn=new Intl.DisplayNames(['cs'],{type:'region'});"
          "const out={};for(const c of JSON.parse(process.argv[1]))out[c]=dn.of(c);"
          "console.log(JSON.stringify(out))")
    res = subprocess.run(["node", "-e", js, json.dumps(iso2s)], capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def main(src: str):
    ne = json.loads(Path(src).read_text(encoding="utf-8"))
    entities = sorted(p.stem for p in (config.WORLD_RAW_DIR / "yearly").glob("*.json"))
    countries = [c for c in entities if c.isupper()]
    if not countries:
        sys.exit("no data in data/raw/world/yearly - run pipeline/fetch_world.py first")

    props: dict[str, dict] = {}
    parts: dict[str, list] = defaultdict(list)
    for f in ne["features"]:
        p = f["properties"]
        iso3 = iso3_of(p)
        if not iso3 or iso3 in DROP:
            continue
        props.setdefault(iso3, p)
        g = f["geometry"]
        for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]):
            code = iso3
            if iso3 == "FRA":
                code = next((c for c, bb in FRANCE_SPLIT.items() if in_bbox(poly, bb)), "FRA")
            parts[code].append(poly)

    # ---------------------------------------------------------------- map
    features = []
    for code in sorted(parts):
        if code not in countries:
            continue
        polys = [q for q in (simplify_polygon(poly) for poly in parts[code]) if q]
        big = [q for q in polys if area(q[0]) >= MIN_RING_AREA]
        keep = big or sorted(polys, key=lambda q: -area(q[0]))[:1]
        if keep:
            features.append({"type": "Feature", "properties": {"id": code},
                             "geometry": {"type": "MultiPolygon", "coordinates": keep}})
    gj = {"type": "FeatureCollection",
          "_source": "Natural Earth 1:50m admin 0 countries (public domain), simplified",
          "features": features}
    path = ROOT / "site" / "world.geojson"
    path.write_text(json.dumps(gj, separators=(",", ":")), encoding="utf-8")
    print(f"{path.relative_to(ROOT)}: {len(features)} countries, {path.stat().st_size / 1024:.0f} kB")
    print("not on the map:", sorted(set(countries) - {f['properties']['id'] for f in features}))

    # ----------------------------------------------------------- entities
    meta = {}
    for code in countries:
        if code in MANUAL:
            iso2, region = MANUAL[code]
        elif code in props:
            p = props[code]
            iso2 = p.get("ISO_A2_EH") if p.get("ISO_A2_EH") not in (None, "-99") else p.get("ISO_A2")
            region = region_of(code, p)
        else:
            print(f"warning: {code} not in Natural Earth - add it to MANUAL")
            continue
        meta[code] = {"iso2": iso2, "region": region}
    names = czech_names(sorted({m["iso2"] for m in meta.values()}))
    europe = {cc.upper() if cc != "uk" else "GB": i["name"] for cc, i in config.COUNTRY_INFO.items()}
    for m in meta.values():
        m["name"] = NAME_FIX.get(m["iso2"]) or europe.get(m["iso2"]) or names.get(m["iso2"]) or m["iso2"]
    out = ROOT / "pipeline" / "world_entities.json"
    lines = ["{"] + [f'"{c}":{json.dumps(meta[c], ensure_ascii=False, sort_keys=True)},' for c in sorted(meta)]
    lines[-1] = lines[-1].rstrip(",")
    out.write_text("\n".join(lines + ["}"]) + "\n", encoding="utf-8")
    print(f"{out.relative_to(ROOT)}: {len(meta)} countries")
    check(meta)


def check(meta: dict):
    """Compare our region sums with Ember's regional aggregates."""
    def total(code: str) -> dict[str, float]:
        doc = json.loads((config.WORLD_RAW_DIR / "yearly" / f"{code}.json").read_text(encoding="utf-8"))
        fuels = [i for i, k in enumerate(doc["series"]) if k in {s[0] for s in config.WORLD_SOURCES}]
        return {p["t"]: sum(p["v"][i] or 0 for i in fuels) for p in doc["periods"]}
    by_region = defaultdict(list)
    for code, m in meta.items():
        by_region[m["region"]].append(code)
    for year in ("2005", "2015", "2023"):
        row = []
        for region, _ in config.WORLD_REGIONS:
            ours = sum(total(c).get(year, 0) for c in by_region[region])
            ember = total(region).get(year)
            row.append(f"{region} {ours:.0f}/{ember:.0f}")
        print(year, "ours/Ember TWh:", ", ".join(row))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
