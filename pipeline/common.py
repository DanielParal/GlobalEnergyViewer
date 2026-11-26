"""Helpers shared by fetch.py and build.py: time handling and raw-file I/O."""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import config

UTC = timezone.utc
HOUR = timedelta(hours=1)


# --------------------------------------------------------------------------
# Time
# --------------------------------------------------------------------------
def fmt_hour(dt: datetime) -> str:
    """UTC datetime -> '2026-11-01T00:00Z' (the key used in raw files)."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%MZ")


def parse_hour(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=UTC)


def month_of(t: str) -> str:
    return t[:7]


# --------------------------------------------------------------------------
# Numbers
# --------------------------------------------------------------------------
def clean_number(x: float | None, ndigits: int = 1):
    """Round, drop '-0.0' and write whole numbers as ints -> stable JSON."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    r = round(x, ndigits) + 0.0  # +0.0 turns -0.0 into 0.0
    if ndigits == 0 or r == int(r):
        return int(r)
    return r


# --------------------------------------------------------------------------
# Raw files: data/raw/<kind>/<cc>/<yyyy-mm>.json
# --------------------------------------------------------------------------
def raw_path(kind: str, country: str, month: str) -> Path:
    return config.RAW_DIR / kind / country / f"{month}.json"


def series_sort_key(kind: str):
    if kind == "power":
        order = {k: i for i, k in enumerate(config.SOURCE_ORDER)}
        return lambda k: (order.get(k, len(order)), k)
    return lambda k: k  # flows: neighbour codes alphabetically


def read_raw(path: Path) -> tuple[dict, dict[str, dict[str, float | None]]]:
    """Return (header, rows) where rows = {t: {series: value}}."""
    if not path.exists():
        return {}, {}
    doc = json.loads(path.read_text(encoding="utf-8"))
    series = doc["series"]
    rows = {h["t"]: dict(zip(series, h["v"])) for h in doc["hours"]}
    header = {k: v for k, v in doc.items() if k not in ("series", "hours")}
    return header, rows


def render_raw(header: dict, rows: dict[str, dict[str, float | None]], kind: str) -> str:
    """Stable, diff-friendly JSON: header fields, then one line per hour."""
    keys = sorted({k for r in rows.values() for k in r}, key=series_sort_key(kind))
    lines = ["{"]
    for k, v in header.items():
        lines.append(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},")
    lines.append(f'  "series": {json.dumps(keys)},')
    lines.append('  "hours": [')
    ts = sorted(rows)
    for i, t in enumerate(ts):
        vals = [clean_number(rows[t].get(k)) for k in keys]
        sep = "," if i < len(ts) - 1 else ""
        lines.append(f'    {{"t": "{t}", "v": {json.dumps(vals)}}}{sep}')
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return True


def raw_header(kind: str, country: str, month: str) -> dict:
    if kind == "power":
        return {
            "country": country,
            "month": month,
            "unit": "MW",
            "note": "hourly mean (= MWh per hour), UTC; load = consumption",
            "source": "energy-charts.info /v2/public_power",
            "license": "CC BY 4.0, attribution: energy-charts.info",
        }
    return {
        "country": country,
        "month": month,
        "unit": "MW",
        "note": "hourly mean physical flow, UTC; positive = export from country to neighbour",
        "source": "energy-charts.info /v2/cbpf",
        "license": "CC BY 4.0, attribution: energy-charts.info",
    }


def merge_rows(old: dict, new: dict) -> dict:
    """Merge new hourly rows into old. New non-null values win; a new null
    never erases a value we already have (the API returns null for
    'not yet available', not for 'deleted')."""
    out = {t: dict(v) for t, v in old.items()}
    for t, vals in new.items():
        row = out.setdefault(t, {})
        for k, v in vals.items():
            if v is not None or k not in row:
                row[k] = v
    # drop hours that carry no value at all
    return {t: r for t, r in out.items() if any(v is not None for v in r.values())}
