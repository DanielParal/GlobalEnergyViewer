#!/usr/bin/env python3
"""Download production and cross-border flow data from the Energy-Charts API
and merge it (hourly, UTC) into data/raw/<kind>/<cc>/<yyyy-mm>.json.

Examples
    python pipeline/fetch.py                         # all countries, last 5 days
    python pipeline/fetch.py --countries cz --days 3
    python pipeline/fetch.py --from 2024-01-01 --to 2024-12-31 --chunk-months 3
    python pipeline/fetch.py --dry-run
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
from common import (  # noqa: E402
    HOUR, UTC, fmt_hour, merge_rows, month_of, raw_header, raw_path,
    read_raw, render_raw, write_if_changed,
)

log = logging.getLogger("fetch")


# --------------------------------------------------------------------------
# Request planning
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Window:
    start: datetime  # inclusive, UTC midnight
    end: datetime    # exclusive, UTC midnight

    def params(self) -> dict:
        # The API treats `end` as inclusive, so ask up to the last minute.
        return {
            "start": self.start.strftime("%Y-%m-%dT%H:%MZ"),
            "end": (self.end - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%MZ"),
        }

    def __str__(self) -> str:
        return f"{(self.start + timedelta(hours=12)):%Y-%m-%d}..{(self.end - timedelta(days=1)):%Y-%m-%d}"


def utc_midnight(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=UTC)


def add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    return date(d.year + m // 12, m % 12 + 1, 1)


# Local days start up to 4 h before UTC midnight (Georgia, UTC+4), so the
# first window starts a bit earlier to make its first local day complete.
LEAD_HOURS = 4


def plan_windows(start: date, end_incl: date, chunk_months: int) -> list[Window]:
    """Short ranges -> one request. Long ranges -> chunks aligned to months."""
    end = end_incl + timedelta(days=1)
    lead = timedelta(hours=LEAD_HOURS)
    if (end - start).days <= 31:
        return [Window(utc_midnight(start) - lead, utc_midnight(end))]
    out, cur = [], start
    while cur < end:
        nxt = min(add_months(date(cur.year, cur.month, 1), chunk_months), end)
        out.append(Window(utc_midnight(cur) - (lead if cur == start else timedelta(0)), utc_midnight(nxt)))
        cur = nxt
    return out


# --------------------------------------------------------------------------
# HTTP with pacing, retry and cache
# --------------------------------------------------------------------------
class FetchError(Exception):
    pass


class Client:
    def __init__(self, use_cache: bool):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = config.USER_AGENT
        self.use_cache = use_cache
        self.last_request: dict[str, float] = {}
        self.requests_sent = 0
        self.cache_hits = 0

    # -- cache ---------------------------------------------------------
    def _cache_file(self, endpoint: str, params: dict) -> Path:
        key = "&".join(f"{k}={params[k]}" for k in sorted(params))
        digest = hashlib.sha1(key.encode()).hexdigest()[:10]
        name = f"{params['country']}_{params['start'][:13]}_{params['end'][:10]}_{digest}.json".replace(":", "")
        return config.CACHE_DIR / endpoint.strip("/").replace("/", "_") / name

    @staticmethod
    def _cache_valid(path: Path, window: Window) -> bool:
        if not path.exists():
            return False
        recent = window.end >= datetime.now(UTC) - timedelta(days=config.RECENT_DAYS)
        if not recent:
            return True
        age_h = (time.time() - path.stat().st_mtime) / 3600
        return age_h < config.RECENT_CACHE_TTL_H

    # -- pacing --------------------------------------------------------
    def _pace(self, endpoint: str):
        last = self.last_request.get(endpoint)
        if last is None:
            return
        wait = last + config.REQUEST_INTERVAL_S - time.monotonic()
        if wait > 0:
            log.debug("rate limit: waiting %.0f s before next %s", wait, endpoint)
            time.sleep(wait)

    def get(self, endpoint: str, params: dict, window: Window) -> dict:
        cache_file = self._cache_file(endpoint, params)
        if self.use_cache and self._cache_valid(cache_file, window):
            self.cache_hits += 1
            log.debug("cache hit %s", cache_file.name)
            return json.loads(cache_file.read_text(encoding="utf-8"))

        url = config.API_BASE + endpoint
        attempts_429 = attempts_5xx = 0
        while True:
            self._pace(endpoint)
            self.last_request[endpoint] = time.monotonic()
            self.requests_sent += 1
            log.debug("GET %s %s", url, params)
            try:
                resp = self.session.get(url, params=params, timeout=config.HTTP_TIMEOUT)
            except requests.RequestException as e:
                resp, err = None, str(e)
            else:
                err = f"HTTP {resp.status_code}"

            if resp is not None and resp.status_code == 200:
                data = resp.json()
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                cache_file.write_text(json.dumps(data), encoding="utf-8")
                return data

            if resp is not None and resp.status_code == 429:
                attempts_429 += 1
                if attempts_429 > config.MAX_429_RETRIES:
                    raise FetchError("HTTP 429 (too many retries)")
                try:
                    wait = float(resp.headers.get("Retry-After", config.DEFAULT_RETRY_AFTER_S))
                except ValueError:
                    wait = config.DEFAULT_RETRY_AFTER_S
                log.warning("429 rate limited, retrying in %.0f s", wait)
                time.sleep(wait)
                continue

            if resp is None or resp.status_code >= 500:
                if attempts_5xx >= config.SERVER_ERROR_RETRIES:
                    raise FetchError(f"{err} (after {attempts_5xx} retries)")
                wait = config.SERVER_ERROR_BACKOFF_S[min(attempts_5xx, len(config.SERVER_ERROR_BACKOFF_S) - 1)]
                attempts_5xx += 1
                log.warning("%s, retry %d/%d in %d s", err, attempts_5xx, config.SERVER_ERROR_RETRIES, wait)
                time.sleep(wait)
                continue

            body = resp.text[:200].replace("\n", " ")
            raise FetchError(f"{err}: {body}")


# --------------------------------------------------------------------------
# Parsing: API envelope -> {hour 't': {key: value}}
# --------------------------------------------------------------------------
_warned: set[str] = set()


def warn_once(msg: str):
    if msg not in _warned:
        _warned.add(msg)
        log.warning(msg)


def power_key(series_id: str) -> str | None:
    if series_id in config.POWER_SERIES_SKIP:
        return None
    key = config.POWER_SERIES.get(series_id)
    if key is None:
        warn_once(f"unknown public_power series '{series_id}' - stored as-is; add it to config.POWER_SERIES")
        return series_id
    return key


def flow_key(series_id: str) -> str | None:
    if series_id in config.NEIGHBOUR_SKIP:
        return None
    code = config.NEIGHBOUR_NAMES.get(series_id)
    if code is None:
        warn_once(f"unknown cbpf neighbour '{series_id}' - stored as-is; add it to config.NEIGHBOUR_NAMES")
        return series_id
    return code


def to_hourly(doc: dict, kind: str, window: Window) -> dict[str, dict[str, float | None]]:
    """Average sub-hourly values to hourly means. An hour is only filled when
    all of its sub-intervals are present; otherwise it stays null."""
    interval = int(doc.get("interval_minutes") or 60)
    if interval > 60 or 60 % interval:
        raise FetchError(f"unsupported interval_minutes={interval}")
    expected = 60 // interval

    if kind == "power":
        unit = doc.get("unit")
        if unit != "MW":
            raise FetchError(f"unexpected unit '{unit}' for public_power")
        keymap = {s["id"]: power_key(s["id"]) for s in doc.get("series", []) if s.get("unit") in (None, "MW")}
        scale = 1.0
    else:
        unit = doc.get("unit")
        # cbpf: GW, positive = import. We store MW, positive = export.
        scale = {"GW": -1000.0, "MW": -1.0}.get(unit)
        if scale is None:
            raise FetchError(f"unexpected unit '{unit}' for cbpf")
        sign = (doc.get("attributes") or {}).get("sign_convention", "")
        if sign and not sign.startswith("positive = import"):
            raise FetchError(f"unexpected cbpf sign convention: {sign}")
        keymap = {s["id"]: flow_key(s["id"]) for s in doc.get("series", [])}

    # Hourly mean per API series first; several series may map to one key
    # (e.g. GB's 'ireland' + 'northern_ireland' -> 'ie') and are then summed.
    sums: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    seen_hours: set[str] = set()
    for rec in doc.get("data", []):
        ts = datetime.fromisoformat(rec["timestamp"]).astimezone(UTC)
        if not (window.start <= ts < window.end):
            continue
        hour = fmt_hour(ts.replace(minute=0, second=0, microsecond=0))
        seen_hours.add(hour)
        for sid, v in (rec.get("values") or {}).items():
            if keymap.get(sid) is None or v is None:
                continue
            sums[hour][sid] += v * scale
            counts[hour][sid] += 1

    out: dict[str, dict[str, float | None]] = {}
    for hour in seen_hours:
        row: dict[str, float | None] = {}
        for sid, key in keymap.items():
            if key is None:
                continue
            n = counts[hour].get(sid, 0)
            if n == expected:
                row[key] = (row.get(key) or 0.0) + sums[hour][sid] / n
            else:
                row.setdefault(key, None)
        out[hour] = row
    return out


# --------------------------------------------------------------------------
# Merge into monthly files
# --------------------------------------------------------------------------
def store(kind: str, country: str, rows: dict) -> tuple[int, list[str]]:
    by_month: dict[str, dict] = defaultdict(dict)
    for t, vals in rows.items():
        by_month[month_of(t)][t] = vals
    changed = []
    filled = 0
    for month, new_rows in sorted(by_month.items()):
        path = raw_path(config.ENDPOINTS[kind]["dir"], country, month)
        _, old_rows = read_raw(path)
        merged = merge_rows(old_rows, new_rows)
        if not merged:
            continue
        filled += sum(1 for t in new_rows if t in merged)
        if write_if_changed(path, render_raw(raw_header(kind, country, month), merged, kind)):
            changed.append(str(path.relative_to(config.ROOT)))
    return filled, changed


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--countries", help="comma separated API codes (default: all from config)")
    p.add_argument("--days", type=int, default=config.DEFAULT_DAYS,
                   help=f"re-download the last N days plus today (default {config.DEFAULT_DAYS})")
    p.add_argument("--from", dest="date_from", type=date.fromisoformat, help="start date YYYY-MM-DD")
    p.add_argument("--to", dest="date_to", type=date.fromisoformat, help="end date YYYY-MM-DD (inclusive, default today)")
    p.add_argument("--chunk-months", type=int, default=config.DEFAULT_CHUNK_MONTHS,
                   help="months per request for long ranges (default 1; the API handles 3 fine)")
    p.add_argument("--endpoints", default="power,flows", help="comma separated: power,flows")
    p.add_argument("--dry-run", action="store_true", help="print the planned requests and exit")
    p.add_argument("--no-cache", action="store_true", help="ignore .cache/ and always hit the API")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args(argv)

    args.countries = [c.strip().lower() for c in args.countries.split(",")] if args.countries else list(config.COUNTRIES)
    args.endpoints = [e.strip() for e in args.endpoints.split(",") if e.strip()]
    for e in args.endpoints:
        if e not in config.ENDPOINTS:
            p.error(f"unknown endpoint '{e}' (use: {', '.join(config.ENDPOINTS)})")
    if args.date_to and not args.date_from:
        p.error("--to needs --from")
    return args


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S",
    )
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    today = datetime.now(UTC).date()
    if args.date_from:
        windows = plan_windows(args.date_from, args.date_to or today, args.chunk_months)
    else:
        windows = plan_windows(today - timedelta(days=args.days), today, args.chunk_months)

    # Interleave endpoints so each one's rate-limit pause overlaps the other's.
    jobs = [(w, c, e) for w in windows for c in args.countries for e in args.endpoints
            if c not in config.SKIP.get(e, ())]
    est_min = len(jobs) / max(1, len(args.endpoints)) * config.REQUEST_INTERVAL_S / 60
    log.info("%d requests (%d windows x %d countries x %d endpoints), ~%.0f min without cache",
             len(jobs), len(windows), len(args.countries), len(args.endpoints), est_min)

    if args.dry_run:
        for w, c, e in jobs:
            params = {"country": c, **w.params()}
            print(f"GET {config.API_BASE}{config.ENDPOINTS[e]['path']}?"
                  + "&".join(f"{k}={v}" for k, v in params.items()))
        return 0

    client = Client(use_cache=not args.no_cache)
    results: dict[tuple[str, str], dict] = defaultdict(lambda: {"ok": 0, "failed": [], "hours": 0, "files": set()})
    for i, (w, c, e) in enumerate(jobs, 1):
        res = results[(c, e)]
        params = {"country": c, **w.params()}
        try:
            doc = client.get(config.ENDPOINTS[e]["path"], params, w)
            rows = to_hourly(doc, e, w)
            filled, changed = store(e, c, rows)
        except (FetchError, ValueError, KeyError) as ex:
            log.error("[%d/%d] %s %s %s: FAILED %s", i, len(jobs), e, c, w, ex)
            res["failed"].append(f"{w}: {ex}")
            continue
        res["ok"] += 1
        res["hours"] += filled
        res["files"].update(changed)
        log.info("[%d/%d] %-5s %s %s: %d hours, %d file(s) changed",
                 i, len(jobs), e, c, w, filled, len(changed))

    # Summary
    print("\nSummary")
    print(f"  requests sent: {client.requests_sent}, cache hits: {client.cache_hits}")
    failed_any = False
    for (c, e), r in sorted(results.items()):
        status = "OK " if not r["failed"] else "ERR"
        failed_any |= bool(r["failed"])
        print(f"  {status} {c:3} {e:5} hours={r['hours']:6d} files_changed={len(r['files'])}")
        for f in r["failed"]:
            print(f"        ! {f}")
    write_github_summary(results)
    return 1 if failed_any else 0


def write_github_summary(results: dict):
    """In GitHub Actions, add a short report to the run's summary page."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    changed = sorted({c for (c, _), r in results.items() if r["files"]})
    failed = [(c, e, f) for (c, e), r in sorted(results.items()) for f in r["failed"]]
    lines = ["### Download"]
    if changed:
        lines.append(f"New or corrected data for: **{', '.join(c.upper() for c in changed)}**")
    else:
        lines.append("No new data from the API - already up to date.")
    if failed:
        lines.append(f"\n**{len(failed)} failed request(s)** (other countries were processed normally):")
        lines += [f"- `{c}` {e}: {f}" for c, e, f in failed]
    with open(path, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n\n")


if __name__ == "__main__":
    sys.exit(main())
