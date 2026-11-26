#!/usr/bin/env python3
"""Download yearly and monthly electricity data for the whole world from the
Ember API (https://api.ember-energy.org) into data/raw/world/.

    python pipeline/fetch_world.py              # all datasets, all countries
    python pipeline/fetch_world.py --dry-run    # show what would be requested
    python pipeline/fetch_world.py --no-cache   # ignore .cache/world/

Needs a free API key (https://ember-energy.org/data/api/) in the environment
variable EMBER_API_KEY or in a git-ignored `.env` file (EMBER_API_KEY=...).

Six bulk requests (generation, demand and carbon intensity, each yearly and
monthly) return every country and region at once; Ember has no rate limit.
One raw file per entity and resolution:

    data/raw/world/yearly/<ISO3 or region>.json   one line per year
    data/raw/world/monthly/<ISO3 or region>.json  one line per month

Values: TWh (generation per source, net imports, demand), gCO2/kWh (ci) and
kWh per person (kwh_pc, yearly only). Merging is idempotent: a new non-null
value overwrites (Ember revises history), a null never erases a value.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
from common import clean_number, merge_rows, write_if_changed  # noqa: E402

log = logging.getLogger("fetch_world")
CACHE = config.CACHE_DIR / "world"
RETRY_BACKOFF_S = (10, 30, 60)

# (dataset, resolution) -> how to turn one API record into {field: value}
DATASETS = [
    ("electricity-generation", "yearly"),
    ("electricity-generation", "monthly"),
    ("electricity-demand", "yearly"),
    ("electricity-demand", "monthly"),
    ("carbon-intensity", "yearly"),
    ("carbon-intensity", "monthly"),
]


def api_key() -> str | None:
    key = os.environ.get(config.EMBER_KEY_ENV, "").strip()
    env = config.ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            m = re.match(rf"\s*(?:export\s+)?{config.EMBER_KEY_ENV}\s*=\s*['\"]?([^'\"\s#]+)", line)
            if m:
                key = m.group(1)
    return key or None


def params_for(dataset: str, resolution: str) -> dict:
    start = str(config.WORLD_START_YEAR) if resolution == "yearly" else f"{config.WORLD_START_YEAR}-01"
    p = {"start_date": start}
    if dataset == "electricity-generation":
        p["is_aggregate_series"] = "false"  # fuels + net imports; totals are sums of these
    return p


def get(session: requests.Session, key: str, dataset: str, resolution: str, use_cache: bool) -> list[dict]:
    """One bulk request, cached in .cache/world/ for RECENT_CACHE_TTL_H hours."""
    CACHE.mkdir(parents=True, exist_ok=True)
    cache = CACHE / f"{dataset}_{resolution}.json"
    if use_cache and cache.exists() and time.time() - cache.stat().st_mtime < config.RECENT_CACHE_TTL_H * 3600:
        log.info("%s/%s: from cache", dataset, resolution)
        return json.loads(cache.read_text(encoding="utf-8"))["data"]
    url = f"{config.EMBER_API_BASE}/{dataset}/{resolution}"
    params = {**params_for(dataset, resolution), "api_key": key}
    for attempt in range(len(RETRY_BACKOFF_S) + 1):
        t0 = time.monotonic()
        try:
            r = session.get(url, params=params, timeout=config.EMBER_HTTP_TIMEOUT)
        except requests.RequestException as e:
            err = f"network error: {e.__class__.__name__}"
        else:
            if r.status_code == 200:
                doc = r.json()
                log.info("%s/%s: %d records, %.1f MB, %.1f s", dataset, resolution, len(doc["data"]),
                         len(r.content) / 1e6, time.monotonic() - t0)
                tmp = cache.with_suffix(".tmp")
                tmp.write_bytes(r.content)
                tmp.replace(cache)
                return doc["data"]
            if r.status_code in (401, 403):
                raise RuntimeError(f"HTTP {r.status_code} - check {config.EMBER_KEY_ENV}")
            if r.status_code < 500:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
            err = f"HTTP {r.status_code}"
        if attempt == len(RETRY_BACKOFF_S):
            raise RuntimeError(err)
        wait = RETRY_BACKOFF_S[attempt]
        log.warning("%s/%s: %s, retry in %d s", dataset, resolution, err, wait)
        time.sleep(wait)
    raise AssertionError("unreachable")


def entity_code(rec: dict) -> str:
    if rec.get("entity_code"):
        return rec["entity_code"]
    name = rec["entity"]
    if name in config.WORLD_AGGREGATES:
        return config.WORLD_AGGREGATES[name][0]
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    log.warning("unknown aggregate %r stored as %r - add it to WORLD_AGGREGATES in config.py", name, slug)
    return slug


def period(rec: dict, resolution: str) -> str:
    d = str(rec["date"])
    return d[:4] if resolution == "yearly" else d[:7]


def collect(records_by_ds: dict, unknown: set) -> tuple[dict, dict]:
    """-> ({(resolution, code): {period: {field: value}}}, {code: Ember name})"""
    out: dict[tuple[str, str], dict[str, dict]] = {}
    names: dict[str, str] = {}
    for (dataset, resolution), records in records_by_ds.items():
        for rec in records:
            code = entity_code(rec)
            names[code] = rec["entity"]
            row = out.setdefault((resolution, code), {}).setdefault(period(rec, resolution), {})
            if dataset == "electricity-generation":
                key = config.EMBER_SERIES.get(rec["series"])
                if key is None:
                    if not rec.get("is_aggregate_series"):
                        unknown.add(rec["series"])
                    continue
                row[key] = rec["generation_twh"]
            elif dataset == "electricity-demand":
                row["demand"] = rec["demand_twh"]
                if resolution == "yearly":
                    row["kwh_pc"] = rec.get("demand_kwh_per_capita")
            else:
                row["ci"] = rec["emissions_intensity_gco2_per_kwh"]
    return out, names


# --------------------------------------------------------------------------
# Raw files
# --------------------------------------------------------------------------
def raw_path(resolution: str, code: str) -> Path:
    return config.WORLD_RAW_DIR / resolution / f"{code}.json"


def read_world_raw(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    doc = json.loads(path.read_text(encoding="utf-8"))
    return {p["t"]: dict(zip(doc["series"], p["v"])) for p in doc["periods"]}


def render_world_raw(code: str, name: str, resolution: str, rows: dict[str, dict]) -> str:
    present = {k for r in rows.values() for k in r}
    keys = [k for k in config.WORLD_FIELDS if k in present] + sorted(present - set(config.WORLD_FIELDS))
    header = {
        "entity": name,
        "code": code,
        "resolution": resolution,
        "units": config.WORLD_UNITS,
        "note": "generation per source, net imports (positive = import) and demand in TWh; "
                "ci = carbon intensity of generation; kwh_pc = demand per person",
        "source": "Ember API v1: electricity-generation, electricity-demand, carbon-intensity",
        "license": "CC BY 4.0, attribution: Ember",
    }
    lines = ["{"]
    for k, v in header.items():
        lines.append(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},")
    lines.append(f'  "series": {json.dumps(keys)},')
    lines.append('  "periods": [')
    ts = sorted(rows)
    for i, t in enumerate(ts):
        vals = [clean_number(rows[t].get(k), 2) for k in keys]
        lines.append(f'    {{"t": "{t}", "v": {json.dumps(vals)}}}' + ("," if i < len(ts) - 1 else ""))
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


def store(collected: dict, names: dict) -> list[str]:
    changed = []
    for (resolution, code), rows in sorted(collected.items()):
        path = raw_path(resolution, code)
        merged = merge_rows(read_world_raw(path), rows)
        if not merged:
            continue
        if write_if_changed(path, render_world_raw(code, names[code], resolution, merged)):
            changed.append(f"{resolution}/{code}")
    return changed


def write_github_summary(changed: list[str], error: str | None):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    lines = ["### World data (Ember)"]
    if error:
        lines.append(f"❌ {error}")
    elif not changed:
        lines.append("No new data from Ember - already up to date.")
    else:
        lines.append(f"{len(changed)} file(s) changed: " + ", ".join(changed[:40]) + (" …" if len(changed) > 40 else ""))
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n\n")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="only print the requests")
    p.add_argument("--no-cache", action="store_true", help="ignore cached responses in .cache/world/")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")

    if args.dry_run:
        for ds, res in DATASETS:
            q = "&".join(f"{k}={v}" for k, v in params_for(ds, res).items())
            print(f"GET {config.EMBER_API_BASE}/{ds}/{res}?{q}&api_key=…")
        return 0
    key = api_key()
    if not key:
        msg = f"{config.EMBER_KEY_ENV} is not set (environment or .env) - get a free key at https://ember-energy.org/data/api/"
        log.error(msg)
        write_github_summary([], msg)
        return 2

    session = requests.Session()
    session.headers["User-Agent"] = config.USER_AGENT
    try:
        records = {(ds, res): get(session, key, ds, res, not args.no_cache) for ds, res in DATASETS}
    except RuntimeError as e:
        log.error("download failed: %s", e)
        write_github_summary([], f"download failed: {e}")
        return 1

    unknown: set[str] = set()
    collected, names = collect(records, unknown)
    for s in sorted(unknown):
        log.warning("unknown Ember series %r ignored - add it to EMBER_SERIES in config.py", s)
    changed = store(collected, names)
    n_y = sum(1 for r, _ in collected if r == "yearly")
    n_m = sum(1 for r, _ in collected if r == "monthly")
    log.info("%d entities yearly, %d monthly; %d raw file(s) changed", n_y, n_m, len(changed))
    write_github_summary(changed, None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
