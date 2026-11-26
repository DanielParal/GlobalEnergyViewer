#!/usr/bin/env python3
"""Build web summaries (site/data/) and the SQLite database (build/) from the
raw hourly files in data/raw/. No network. Deterministic: the same input gives
byte-identical output.

    python pipeline/build.py              # summaries + SQLite
    python pipeline/build.py --no-sqlite  # summaries only (faster)
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import sqlite3
import sys
from array import array
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
from common import HOUR, UTC, clean_number, fmt_hour, read_raw, series_sort_key, write_if_changed  # noqa: E402

log = logging.getLogger("build")
NAN = float("nan")
NET_EXPORT = "net_export"

# Border mismatch tolerance when both countries report the same border.
MISMATCH_ABS_MW = 50
MISMATCH_REL = 0.05


# --------------------------------------------------------------------------
# Hour index: every series is an array('d') over one global hour range
# --------------------------------------------------------------------------
class Timeline:
    def __init__(self, months: list[str]):
        first, last = months[0], months[-1]
        self.t0 = datetime(int(first[:4]), int(first[5:7]), 1, tzinfo=UTC)
        y, m = int(last[:4]), int(last[5:7])
        end = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=UTC)
        self.n = int((end - self.t0) / HOUR)
        self._ts: list[str] | None = None
        self._days: dict[str, tuple[list[str], array]] = {}

    def index(self, t: str) -> int:
        # 'YYYY-MM-DDTHH:MMZ' -> hour offset (fast path, no datetime parsing)
        dt = datetime(int(t[:4]), int(t[5:7]), int(t[8:10]), int(t[11:13]), tzinfo=UTC)
        return int((dt - self.t0) / HOUR)

    def new(self) -> array:
        return array("d", [NAN]) * self.n

    def ts(self, i: int) -> str:
        if self._ts is None:
            self._ts = [fmt_hour(self.t0 + k * HOUR) for k in range(self.n)]
        return self._ts[i]

    def local_days(self, tz_name: str) -> tuple[list[str], array]:
        """(list of local dates, per-hour index into that list)."""
        if tz_name not in self._days:
            tz = ZoneInfo(tz_name)
            days: list[str] = []
            idx = array("i")
            last = None
            for k in range(self.n):
                d = (self.t0 + k * HOUR).astimezone(tz).strftime("%Y-%m-%d")
                if d != last:
                    days.append(d)
                    last = d
                idx.append(len(days) - 1)
            self._days[tz_name] = (days, idx)
        return self._days[tz_name]


def isnum(v: float) -> bool:
    return v == v  # False for NaN


def hours_in_local_day(day: str, tz_name: str) -> int:
    """23, 24 or 25 depending on DST."""
    tz = ZoneInfo(tz_name)
    d = datetime.strptime(day, "%Y-%m-%d")
    a = d.replace(tzinfo=tz)
    b = (d + timedelta(days=1)).replace(tzinfo=tz)
    return int((b.astimezone(UTC) - a.astimezone(UTC)) / HOUR)


def first_complete_day(days: list[str], hours: list[int], tz_name: str) -> int:
    """Index of the first day that is not a partially downloaded leading day."""
    for j, d in enumerate(days):
        if hours[j] >= hours_in_local_day(d, tz_name):
            return j
        if hours[j] and j > 0:
            return j  # a gap later in the series: keep it, it is real
    return 0


# --------------------------------------------------------------------------
# Loading raw files
# --------------------------------------------------------------------------
def list_raw(kind: str) -> dict[str, list[Path]]:
    base = config.RAW_DIR / kind
    out = {}
    if base.exists():
        for d in sorted(p for p in base.iterdir() if p.is_dir()):
            files = sorted(d.glob("*.json"))
            if files:
                out[d.name] = files
    return out


def load(kind: str, files_by_cc: dict[str, list[Path]], tl: Timeline) -> dict[str, dict[str, array]]:
    data: dict[str, dict[str, array]] = {}
    for cc, files in files_by_cc.items():
        series: dict[str, array] = {}
        for f in files:
            _, rows = read_raw(f)
            for t, vals in rows.items():
                i = tl.index(t)
                for k, v in vals.items():
                    if v is None:
                        continue
                    arr = series.get(k)
                    if arr is None:
                        arr = series[k] = tl.new()
                    arr[i] = v
        data[cc] = series
    return data


def span(series: dict[str, array], keys=None) -> tuple[int, int] | None:
    """First and last hour index with any value."""
    lo, hi = None, None
    for k, arr in series.items():
        if keys is not None and k not in keys:
            continue
        for i in range(len(arr)):
            if isnum(arr[i]):
                lo = i if lo is None else min(lo, i)
                break
        for i in range(len(arr) - 1, -1, -1):
            if isnum(arr[i]):
                hi = i if hi is None else max(hi, i)
                break
    return None if lo is None else (lo, hi)


# --------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------
def dumps(v) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def render(doc: dict, nested: tuple[str, ...] = ()) -> str:
    """Compact JSON with one line per top-level key (and per entry of the
    `nested` dicts) - small files, still readable diffs."""
    lines = ["{"]
    items = list(doc.items())
    for n, (k, v) in enumerate(items):
        comma = "," if n < len(items) - 1 else ""
        if k in nested and isinstance(v, dict):
            lines.append(f"{dumps(k)}:{{")
            sub = list(v.items())
            for m, (sk, sv) in enumerate(sub):
                lines.append(f"{dumps(sk)}:{dumps(sv)}" + ("," if m < len(sub) - 1 else ""))
            lines.append("}" + comma)
        else:
            lines.append(f"{dumps(k)}:{dumps(v)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


class Output:
    def __init__(self, root: Path):
        self.root = root
        self.written: set[Path] = set()
        self.changed = 0

    def put(self, rel: str, text: str):
        path = self.root / rel
        self.written.add(path)
        if write_if_changed(path, text):
            self.changed += 1

    def prune(self):
        removed = 0
        if not self.root.exists():
            return 0
        for p in sorted(self.root.rglob("*"), reverse=True):
            if p.is_file() and p not in self.written:
                p.unlink()
                removed += 1
            elif p.is_dir() and not any(p.iterdir()):
                p.rmdir()
        return removed


def r(x, nd):
    return clean_number(x, nd)


# --------------------------------------------------------------------------
# Power summaries
# --------------------------------------------------------------------------
def net_export_series(flows: dict[str, array], tl: Timeline) -> array | None:
    if not flows:
        return None
    out = tl.new()
    arrs = list(flows.values())
    for i in range(tl.n):
        s, any_ = 0.0, False
        for a in arrs:
            v = a[i]
            if isnum(v):
                s += v
                any_ = True
        if any_:
            out[i] = s
    return out


def build_power(cc: str, series: dict[str, array], tl: Timeline, out: Output) -> dict | None:
    gen_keys = {k for k in series if k not in ("load", NET_EXPORT)}
    sp = span(series, gen_keys)
    if sp is None:
        return None
    lo, hi = sp
    tz = config.COUNTRY_INFO.get(cc, {}).get("tz", "UTC")
    days, dayidx = tl.local_days(tz)
    keys = sorted(series, key=series_sort_key("power"))
    if NET_EXPORT in keys:  # keep the derived series last
        keys.remove(NET_EXPORT)
        keys.append(NET_EXPORT)

    d_lo, d_hi = dayidx[lo], dayidx[hi]
    nd = d_hi - d_lo + 1
    sums = {k: [0.0] * nd for k in keys}
    cnt = {k: [0] * nd for k in keys}
    hours = [0] * nd
    for i in range(lo, hi + 1):
        d = dayidx[i] - d_lo
        has = False
        for k in keys:
            v = series[k][i]
            if isnum(v):
                sums[k][d] += v
                cnt[k][d] += 1
                if k in gen_keys:
                    has = True
        if has:
            hours[d] += 1
    day_list = days[d_lo:d_hi + 1]
    # drop a leading local day that the download only partly covers
    j0 = first_complete_day(day_list, hours, tz)
    if j0:
        day_list, hours = day_list[j0:], hours[j0:]
        sums = {k: v[j0:] for k, v in sums.items()}
        cnt = {k: v[j0:] for k, v in cnt.items()}

    # daily files per local year
    years = sorted({d[:4] for d in day_list})
    for y in years:
        sel = [j for j, d in enumerate(day_list) if d.startswith(y)]
        doc = {
            "country": cc, "year": int(y), "tz": tz, "unit": "GWh",
            "days": [day_list[j] for j in sel],
            "hours": [hours[j] for j in sel],
            "series": keys,
            "data": {k: [r(sums[k][j] / 1000, 2) if cnt[k][j] else None for j in sel] for k in keys},
        }
        out.put(f"power_daily/{cc}/{y}.json", render(doc, nested=("data",)))

    # monthly sums (local months) for power_monthly.json
    monthly: dict[str, dict] = {}
    for j, d in enumerate(day_list):
        m = monthly.setdefault(d[:7], {"hours": 0, "sum": defaultdict(float), "n": defaultdict(int)})
        m["hours"] += hours[j]
        for k in keys:
            if cnt[k][j]:
                m["sum"][k] += sums[k][j]
                m["n"][k] += cnt[k][j]

    # hourly files per UTC month (for the hourly step and the map panel)
    hourly_months = []
    i = lo
    while i <= hi:
        t = tl.ts(i)
        month = t[:7]
        j = i
        while j <= hi and tl.ts(j)[:7] == month:
            j += 1
        if not any(isnum(series[k][x]) for k in gen_keys for x in range(i, j)):
            i = j
            continue
        doc = {
            "country": cc, "month": month, "unit": "MW", "start": t,
            "series": keys,
            "data": {k: [r(series[k][x], 0) for x in range(i, j)] for k in keys},
        }
        out.put(f"power_hourly/{cc}/{month}.json", render(doc, nested=("data",)))
        hourly_months.append(month)
        i = j

    return {
        "from": day_list[0], "to": day_list[-1], "last_hour": tl.ts(hi),
        "years": [int(y) for y in years], "hourly_months": hourly_months,
        "sources": [k for k in keys if k not in ("load", NET_EXPORT)],
        "has_load": "load" in keys, "has_net_export": NET_EXPORT in keys,
        "_monthly": monthly, "_keys": keys,
    }


def build_power_monthly(meta: dict[str, dict], out: Output):
    months = sorted({m for info in meta.values() for m in info["_monthly"]})
    countries = {}
    for cc, info in meta.items():
        mon = info["_monthly"]
        countries[cc] = {
            "hours": [mon[m]["hours"] if m in mon else None for m in months],
            "data": {k: [r(mon[m]["sum"][k] / 1000, 1) if m in mon and mon[m]["n"].get(k) else None for m in months]
                     for k in info["_keys"]},
        }
    lines = ["{", f'"unit":"GWh",', f'"months":{dumps(months)},', '"countries":{']
    ccs = sorted(countries)
    for n, cc in enumerate(ccs):
        lines.append(f"{dumps(cc)}:{dumps(countries[cc])}" + ("," if n < len(ccs) - 1 else ""))
    lines += ["}", "}"]
    out.put("power_monthly.json", "\n".join(lines) + "\n")


# --------------------------------------------------------------------------
# Flows
# --------------------------------------------------------------------------
def merge_borders(flows: dict[str, dict[str, array]], tl: Timeline) -> dict[tuple[str, str], array]:
    """One hourly net series per border (a < b), positive = a -> b."""
    pairs = set()
    for a, nbs in flows.items():
        for b in nbs:
            if a != b:
                pairs.add(tuple(sorted((a, b))))
    borders = {}
    for a, b in sorted(pairs):
        va = flows.get(a, {}).get(b)   # a's view: export a->b
        vb = flows.get(b, {}).get(a)   # b's view: export b->a
        out = tl.new()
        both = mism = 0
        for i in range(tl.n):
            x = va[i] if va is not None else NAN
            y = -vb[i] if vb is not None else NAN
            if isnum(x) and isnum(y):
                both += 1
                if abs(x - y) > max(MISMATCH_ABS_MW, MISMATCH_REL * max(abs(x), abs(y))):
                    mism += 1
                out[i] = (x + y) / 2
            elif isnum(x):
                out[i] = x
            elif isnum(y):
                out[i] = y
        if mism:
            log.warning("border %s-%s: %d of %d hours differ between the two countries' data (>%d MW and >%d%%), using the mean",
                        a, b, mism, both, MISMATCH_ABS_MW, MISMATCH_REL * 100)
        borders[(a, b)] = out
    return borders


def build_flows(borders: dict[tuple[str, str], array], tl: Timeline, out: Output) -> dict | None:
    sp = span({f"{a}-{b}": v for (a, b), v in borders.items()})
    if sp is None:
        return None
    lo, hi = sp
    days, dayidx = tl.local_days(config.FLOWS_TZ)
    d_lo, d_hi = dayidx[lo], dayidx[hi]
    # drop a leading local day that the download only partly covers
    cover = [0] * (d_hi - d_lo + 1)
    for i in range(lo, hi + 1):
        if any(isnum(arr[i]) for arr in borders.values()):
            cover[dayidx[i] - d_lo] += 1
    d_lo += first_complete_day(days[d_lo:d_hi + 1], cover, config.FLOWS_TZ)
    lo = next(i for i in range(lo, hi + 1) if dayidx[i] >= d_lo)
    day_list = days[d_lo:d_hi + 1]
    nd = len(day_list)

    daily = {}
    for key, arr in borders.items():
        ab, ba, n = [0.0] * nd, [0.0] * nd, [0] * nd
        for i in range(lo, hi + 1):
            v = arr[i]
            if isnum(v):
                d = dayidx[i] - d_lo
                n[d] += 1
                if v >= 0:
                    ab[d] += v
                else:
                    ba[d] -= v
        daily[key] = (ab, ba, n)

    years = sorted({d[:4] for d in day_list})
    for y in years:
        sel = [j for j, d in enumerate(day_list) if d.startswith(y)]
        bdoc = {}
        for (a, b), (ab, ba, n) in daily.items():
            if not any(n[j] for j in sel):
                continue
            bdoc[f"{a}-{b}"] = {
                "ab": [r(ab[j] / 1000, 2) if n[j] else None for j in sel],
                "ba": [r(ba[j] / 1000, 2) if n[j] else None for j in sel],
            }
        doc = {"year": int(y), "tz": config.FLOWS_TZ, "unit": "GWh",
               "note": "ab = flow from first to second country of the key, ba = opposite direction",
               "days": [day_list[j] for j in sel], "borders": bdoc}
        out.put(f"flows_daily/{y}.json", render(doc, nested=("borders",)))

    # hourly files for the last N days with data
    hourly_days = day_list[-config.FLOWS_HOURLY_DAYS:]
    first_d = d_lo + nd - len(hourly_days)
    by_day: dict[int, list[int]] = defaultdict(list)
    for i in range(tl.n):  # whole local days, incl. hours without data yet
        if first_d <= dayidx[i] <= d_hi:
            by_day[dayidx[i]].append(i)
    for d in sorted(by_day):
        idxs = by_day[d]
        bdoc = {}
        for (a, b), arr in borders.items():
            vals = [r(arr[i], 0) for i in idxs]
            if any(v is not None for v in vals):
                bdoc[f"{a}-{b}"] = vals
        doc = {"date": days[d], "tz": config.FLOWS_TZ, "unit": "MW",
               "note": "net flow, positive = from first to second country of the key",
               "start": tl.ts(idxs[0]), "hours": len(idxs), "borders": bdoc}
        out.put(f"flows_hourly/{days[d]}.json", render(doc, nested=("borders",)))

    return {
        "from": day_list[0], "to": day_list[-1], "last_hour": tl.ts(hi),
        "years": [int(y) for y in years], "hourly_days": hourly_days,
        "borders": [[a, b] for (a, b) in sorted(borders)],
    }


# --------------------------------------------------------------------------
# countries.json
# --------------------------------------------------------------------------
def build_countries(power_meta: dict, flows_meta: dict | None, flows: dict, out: Output):
    border_ccs = {c for pair in (flows_meta or {}).get("borders", []) for c in pair}
    codes = [c for c in config.COUNTRIES] + sorted((set(power_meta) | border_ccs) - set(config.COUNTRIES))
    countries = []
    for cc in codes:
        info = config.COUNTRY_INFO.get(cc, {"name": cc.upper(), "center": None, "tz": "UTC"})
        pm = power_meta.get(cc)
        neighbours = sorted({b if a == cc else a for a, b in (flows_meta or {}).get("borders", []) if cc in (a, b)})
        countries.append({
            "code": cc, "name": info["name"], "center": info["center"], "tz": info["tz"],
            "downloaded": cc in config.COUNTRIES,
            "power": None if pm is None else {k: v for k, v in pm.items() if not k.startswith("_")},
            "has_flows": cc in flows,
            "neighbours": neighbours,
        })
    sources = [{"key": k, "name": n, "color": c, "renewable": ren, "kind": kind}
               for k, n, c, ren, kind in config.SOURCES]
    known = {s["key"] for s in sources}
    for pm in power_meta.values():
        for k in pm["sources"]:
            if k not in known:
                sources.append({"key": k, "name": k, "color": "#bbbbbb", "renewable": False, "kind": "generation"})
                known.add(k)
    sources.append({"key": NET_EXPORT, "name": "Saldo (export − import)", "color": "#555555",
                    "renewable": False, "kind": "balance"})
    last = max([pm["last_hour"] for pm in power_meta.values()] + ([flows_meta["last_hour"]] if flows_meta else []), default=None)
    doc = {
        "updated": last,
        "attribution": config.ATTRIBUTION,
        "flows_tz": config.FLOWS_TZ,
        "sources": sources,
        "flows": flows_meta,
        "countries": countries,
    }
    out.put("countries.json", render_countries(doc))


def render_countries(doc: dict) -> str:
    lines = ["{"]
    keys = list(doc)
    for n, k in enumerate(keys):
        comma = "," if n < len(keys) - 1 else ""
        v = doc[k]
        if k in ("sources", "countries") and isinstance(v, list):
            lines.append(f"{dumps(k)}:[")
            for m, item in enumerate(v):
                lines.append(dumps(item) + ("," if m < len(v) - 1 else ""))
            lines.append("]" + comma)
        else:
            lines.append(f"{dumps(k)}:{dumps(v)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# SQLite
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE countries(code TEXT PRIMARY KEY, name TEXT, tz TEXT, downloaded INTEGER);
CREATE TABLE sources(key TEXT PRIMARY KEY, name TEXT, renewable INTEGER, kind TEXT);
-- hourly mean MW (= MWh in that hour), ts = UTC hour start 'YYYY-MM-DDTHH:MMZ'
CREATE TABLE power(country TEXT NOT NULL, ts TEXT NOT NULL, source TEXT NOT NULL, mw REAL NOT NULL,
                   PRIMARY KEY(country, ts, source)) WITHOUT ROWID;
-- hourly net physical flow per border, stored in the direction of the flow (mw >= 0)
CREATE TABLE flows(from_country TEXT NOT NULL, to_country TEXT NOT NULL, ts TEXT NOT NULL, mw REAL NOT NULL,
                   PRIMARY KEY(from_country, to_country, ts)) WITHOUT ROWID;
CREATE INDEX flows_country_ts ON flows(from_country, ts);
CREATE INDEX flows_to_ts ON flows(to_country, ts);
CREATE VIEW power_daily_utc AS
  SELECT country, substr(ts, 1, 10) AS day, source, round(sum(mw) / 1000.0, 3) AS gwh
  FROM power GROUP BY country, day, source;
CREATE VIEW net_export_hourly AS
  SELECT country, ts, sum(mw) AS mw FROM (
    SELECT from_country AS country, ts, mw FROM flows
    UNION ALL SELECT to_country, ts, -mw FROM flows)
  GROUP BY country, ts;
"""


def build_sqlite(power: dict, borders: dict, tl: Timeline, power_meta: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".sqlite.tmp")
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    con.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;" + SCHEMA)
    con.executemany("INSERT INTO meta VALUES (?, ?)", [
        ("attribution", config.ATTRIBUTION),
        ("power_note", "hourly mean MW per production type; source 'load' = consumption; UTC"),
        ("flows_note", "hourly net physical flow from_country -> to_country in MW (always >= 0); UTC"),
    ])
    con.executemany("INSERT INTO countries VALUES (?, ?, ?, ?)", [
        (cc, i["name"], i["tz"], int(cc in config.COUNTRIES)) for cc, i in sorted(config.COUNTRY_INFO.items())])
    con.executemany("INSERT INTO sources VALUES (?, ?, ?, ?)", [
        (k, n, int(ren), kind) for k, n, _, ren, kind in sorted(config.SOURCES)])

    def power_rows():
        for cc in sorted(power):
            keys = sorted(k for k in power[cc] if k != NET_EXPORT)
            arrs = [power[cc][k] for k in keys]
            for i in range(tl.n):
                ts = None
                for k, a in zip(keys, arrs):
                    v = a[i]
                    if isnum(v):
                        if ts is None:
                            ts = tl.ts(i)
                        yield cc, ts, k, round(v, 1)
    con.executemany("INSERT INTO power VALUES (?, ?, ?, ?)", power_rows())

    rows = []
    for (a, b), arr in borders.items():
        for i in range(tl.n):
            v = arr[i]
            if isnum(v):
                rows.append((a, b, tl.ts(i), round(v, 1)) if v >= 0 else (b, a, tl.ts(i), round(-v, 1) + 0.0))
    rows.sort()
    con.executemany("INSERT INTO flows VALUES (?, ?, ?, ?)", rows)
    con.commit()
    con.close()
    tmp.replace(path)


# --------------------------------------------------------------------------
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--no-sqlite", action="store_true", help="skip build/energy.sqlite")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")

    power_files = list_raw("power")
    flow_files = list_raw("flows")
    months = sorted({f.stem for files in (*power_files.values(), *flow_files.values()) for f in files})
    if not months:
        log.error("no raw data in %s - run fetch.py first", config.RAW_DIR)
        return 1
    tl = Timeline(months)
    log.info("timeline %s .. %s (%d hours), %d power / %d flow countries",
             months[0], months[-1], tl.n, len(power_files), len(flow_files))

    power = load("power", power_files, tl)
    flows = load("flows", flow_files, tl)
    for cc, nbs in flows.items():
        ne = net_export_series(nbs, tl)
        if ne is not None and cc in power:
            power[cc][NET_EXPORT] = ne

    out = Output(config.SITE_DATA_DIR)
    power_meta = {}
    for cc in sorted(power):
        meta = build_power(cc, power[cc], tl, out)
        if meta:
            power_meta[cc] = meta
    build_power_monthly(power_meta, out)

    borders = merge_borders(flows, tl)
    flows_meta = build_flows(borders, tl, out)
    build_countries(power_meta, flows_meta, flows, out)
    removed = out.prune()
    log.info("site/data: %d files, %d changed, %d removed", len(out.written), out.changed, removed)

    if not args.no_sqlite:
        build_sqlite(power, borders, tl, power_meta, config.SQLITE_PATH)
        log.info("sqlite: %s (%.1f MB)", config.SQLITE_PATH.relative_to(config.ROOT),
                 config.SQLITE_PATH.stat().st_size / 1e6)
    return 0


if __name__ == "__main__":
    sys.exit(main())
