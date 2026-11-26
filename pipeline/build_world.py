"""World summaries for the web (site/data/world/) from data/raw/world/.
Called by build.py; no network, deterministic.

    world/meta.json             entities (Czech names, regions, available years/months), sources, regions
    world/yearly.json           every entity x year: TWh per source, net imports, demand, ci, kWh per person,
                                plus `ltm` = the last 12 months of each entity with monthly data
    world/monthly/<code>.json   monthly values of one entity (Výroba with monthly step)
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import config
from common import clean_number

log = logging.getLogger("build")
FUELS = [s[0] for s in config.WORLD_SOURCES]
TWH_FIELDS = FUELS + ["net_imports", "demand"]


def dumps(v) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def read(path: Path) -> dict[str, dict]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    return {p["t"]: dict(zip(doc["series"], p["v"])) for p in doc["periods"]}


def has_gen(row: dict | None) -> bool:
    return bool(row) and any(row.get(k) is not None for k in FUELS)


def gen_total(row: dict) -> float:
    return sum(row.get(k) or 0 for k in FUELS)


def load_world() -> dict:
    """{'yearly': {code: {period: row}}, 'monthly': {...}, 'names': {code: Ember name}}"""
    out = {"yearly": {}, "monthly": {}, "names": {}}
    for res in ("yearly", "monthly"):
        for path in sorted((config.WORLD_RAW_DIR / res).glob("*.json")):
            rows = read(path)
            if any(has_gen(r) for r in rows.values()):
                out[res][path.stem] = rows
                out["names"][path.stem] = json.loads(path.read_text(encoding="utf-8"))["entity"]
    return out


def render_lines(doc: dict, nested: tuple[str, ...]) -> str:
    """One line per top-level key and per entry of the `nested` dicts/lists."""
    lines = ["{"]
    keys = list(doc)
    for n, k in enumerate(keys):
        comma = "," if n < len(keys) - 1 else ""
        v = doc[k]
        if k in nested and isinstance(v, dict):
            items = list(v.items())
            lines.append(f"{dumps(k)}:{{")
            lines += [f"{dumps(a)}:{dumps(b)}" + ("," if m < len(items) - 1 else "") for m, (a, b) in enumerate(items)]
            lines.append("}" + comma)
        elif k in nested and isinstance(v, list):
            lines.append(f"{dumps(k)}:[")
            lines += [dumps(x) + ("," if m < len(v) - 1 else "") for m, x in enumerate(v)]
            lines.append("]" + comma)
        else:
            lines.append(f"{dumps(k)}:{dumps(v)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def span(rows: dict[str, dict]) -> list[str] | None:
    ps = [p for p, r in rows.items() if has_gen(r)]
    return [min(ps), max(ps)] if ps else None


def months_between(a: str, b: str) -> list[str]:
    out, y, m = [], int(a[:4]), int(a[5:7])
    while f"{y}-{m:02d}" <= b:
        out.append(f"{y}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def last_12_months(monthly: dict[str, dict], yearly: dict[str, dict]) -> dict | None:
    """Sum of the last 12 months that have generation data (all 12 must be present)."""
    sp = span(monthly)
    if not sp:
        return None
    months = months_between(sp[0], sp[1])[-12:]
    if len(months) < 12 or not all(has_gen(monthly.get(m)) for m in months):
        return None
    v: dict[str, float | None] = {}
    for k in TWH_FIELDS:
        vals = [monthly[m].get(k) for m in months]
        v[k] = clean_number(sum(vals), 2) if all(x is not None for x in vals) else None
    gens = [gen_total(monthly[m]) for m in months]
    cis = [monthly[m].get("ci") for m in months]
    if all(c is not None for c in cis) and sum(gens) > 0:
        v["ci"] = clean_number(sum(c * g for c, g in zip(cis, gens)) / sum(gens), 1)
    # per person: scale by the population behind the latest yearly kWh/person
    for y in sorted(yearly, reverse=True):
        r = yearly[y]
        if r.get("kwh_pc") and r.get("demand") and v.get("demand") is not None:
            v["kwh_pc"] = clean_number(v["demand"] * r["kwh_pc"] / r["demand"], 0)
            break
    return {"from": months[0], "to": months[-1], "v": {k: x for k, x in v.items() if x is not None}}


def build(out, europe_codes: set[str]) -> dict | None:
    w = load_world()
    if not w["yearly"]:
        log.info("world: no data in %s - run fetch_world.py", config.WORLD_RAW_DIR)
        return None
    static = json.loads(config.WORLD_ENTITIES_PATH.read_text(encoding="utf-8")) \
        if config.WORLD_ENTITIES_PATH.exists() else {}
    aggs = {code: name for code, name in config.WORLD_AGGREGATES.values()}
    region_keys = {k for k, _ in config.WORLD_REGIONS}

    years = sorted({int(y) for rows in w["yearly"].values() for y, r in rows.items() if has_gen(r)})
    all_years = [str(y) for y in range(years[0], years[-1] + 1)]

    # ------------------------------------------------------------ entities
    entities = []
    order = [c for c, _ in config.WORLD_AGGREGATES.values() if c in w["yearly"]] + \
        sorted(c for c in w["yearly"] if c not in aggs)
    for code in order:
        ys = span(w["yearly"][code])
        ms = span(w["monthly"].get(code, {}))
        e = {"code": code}
        if code in aggs:
            e.update(name=aggs[code], agg=True)
            if code in region_keys:
                e["region"] = code
        else:
            s = static.get(code)
            if s is None:
                log.warning("world: %s (%s) missing in %s - run tools/make_world.py",
                            code, w["names"][code], config.WORLD_ENTITIES_PATH.name)
                s = {"name": w["names"][code], "region": None, "iso2": None}
            eu = (s["iso2"] or "").lower()
            eu = "uk" if eu == "gb" else eu
            e.update(name=s["name"], region=s["region"], iso2=s["iso2"])
            if eu in europe_codes:
                e["eu"] = eu
        e["y"] = [int(ys[0]), int(ys[1])]
        if ms:
            e["m"] = ms
        entities.append(e)

    latest_month = max((e["m"][1] for e in entities if "m" in e), default=None)
    meta = {
        "updated": latest_month,
        "latest_year": years[-1],
        "attribution": config.WORLD_ATTRIBUTION,
        "years": [years[0], years[-1]],
        "sources": [{"key": k, "name": n, "color": c, "renewable": ren, "clean": clean}
                    for k, n, c, ren, clean in config.WORLD_SOURCES],
        "regions": [{"key": k, "name": n} for k, n in config.WORLD_REGIONS],
        "entities": entities,
    }
    out.put("world/meta.json", render_lines(meta, ("sources", "entities")))

    # -------------------------------------------------------------- yearly
    data, ltm = {}, {}
    for code in order:
        rows = w["yearly"][code]
        d = {}
        for k in config.WORLD_FIELDS:
            arr = [rows.get(y, {}).get(k) for y in all_years]
            if any(v is not None for v in arr):
                d[k] = [clean_number(v, 2) for v in arr]
        data[code] = d
        if code in w["monthly"]:
            l12 = last_12_months(w["monthly"][code], rows)
            if l12:
                ltm[code] = l12
    yearly = {"years": [int(y) for y in all_years], "fields": config.WORLD_FIELDS, "data": data, "ltm": ltm}
    out.put("world/yearly.json", render_lines(yearly, ("data", "ltm")))

    # ------------------------------------------------------------- monthly
    for code, rows in sorted(w["monthly"].items()):
        sp = span(rows)
        if not sp:
            continue
        months = months_between(*sp)
        d = {}
        for k in config.WORLD_FIELDS:
            arr = [rows.get(m, {}).get(k) for m in months]
            if any(v is not None for v in arr):
                d[k] = [clean_number(v, 2) for v in arr]
        out.put(f"world/monthly/{code}.json", render_lines({"code": code, "months": sp, "data": d}, ("data",)))

    check(w)
    log.info("world: %d entities (%d with monthly data), years %d-%d, months up to %s",
             len(entities), len(w["monthly"]), years[0], years[-1], latest_month)
    return {"entities": entities, **w}


def check(w: dict):
    """Ember's balance: demand = generation + net imports (rounded to 0.01 TWh per source)."""
    bad = []
    for code, rows in w["yearly"].items():
        for y, r in rows.items():
            if not has_gen(r) or r.get("demand") is None or r.get("net_imports") is None:
                continue
            diff = abs(gen_total(r) + r["net_imports"] - r["demand"])
            if diff > max(0.5, 0.02 * r["demand"]):
                bad.append(f"{code} {y}: {diff:.2f} TWh")
    if bad:
        log.warning("world: demand != generation + net imports in %d rows, e.g. %s", len(bad), ", ".join(bad[:5]))


SQL = """
CREATE TABLE world_entities(code TEXT PRIMARY KEY, name TEXT, ember_name TEXT, region TEXT, iso2 TEXT,
                            is_aggregate INTEGER);
-- Ember yearly / monthly values: field = source key (TWh), 'net_imports' (TWh, positive = import),
-- 'demand' (TWh), 'ci' (gCO2/kWh), 'kwh_pc' (kWh per person, yearly only)
CREATE TABLE world_yearly(entity TEXT NOT NULL, year INTEGER NOT NULL, field TEXT NOT NULL, value REAL NOT NULL,
                          PRIMARY KEY(entity, year, field)) WITHOUT ROWID;
CREATE TABLE world_monthly(entity TEXT NOT NULL, month TEXT NOT NULL, field TEXT NOT NULL, value REAL NOT NULL,
                           PRIMARY KEY(entity, month, field)) WITHOUT ROWID;
"""


def to_sqlite(con, world: dict):
    con.executescript(SQL)
    con.execute("INSERT INTO meta VALUES ('world_attribution', ?)", (config.WORLD_ATTRIBUTION,))
    con.executemany("INSERT INTO world_entities VALUES (?, ?, ?, ?, ?, ?)", [
        (e["code"], e["name"], world["names"].get(e["code"]), e.get("region"), e.get("iso2"), int(bool(e.get("agg"))))
        for e in world["entities"]])
    for res, table, conv in (("yearly", "world_yearly", int), ("monthly", "world_monthly", str)):
        con.executemany(f"INSERT INTO {table} VALUES (?, ?, ?, ?)", (
            (code, conv(p), k, v)
            for code in sorted(world[res]) for p in sorted(world[res][code])
            for k, v in sorted(world[res][code][p].items()) if v is not None))
