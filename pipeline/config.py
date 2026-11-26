"""Shared configuration for the Energy Flows pipeline.

Everything that describes *what* we download and *how we name it* lives here,
so fetch.py and build.py stay generic.
"""
from __future__ import annotations

from pathlib import Path

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
CACHE_DIR = ROOT / ".cache"
SITE_DATA_DIR = ROOT / "site" / "data"
BUILD_DIR = ROOT / "build"
SQLITE_PATH = BUILD_DIR / "energy.sqlite"

# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
API_BASE = "https://api.energy-charts.info"
USER_AGENT = "energy-flows-pipeline/1.0 (personal, non-commercial)"
HTTP_TIMEOUT = 120  # seconds; a 3-month request is ~5 MB

# The API rate limit is a token bucket *per endpoint* (2 req/min, burst 4).
# We keep a fixed pause between two requests to the same endpoint; requests
# to different endpoints are interleaved so they don't wait for each other.
REQUEST_INTERVAL_S = 31
MAX_429_RETRIES = 6
DEFAULT_RETRY_AFTER_S = 60
SERVER_ERROR_RETRIES = 3
SERVER_ERROR_BACKOFF_S = (30, 60, 120)

# Cache of raw API responses (.cache/, git-ignored). A request whose window
# ends within RECENT_DAYS of today may still change, so its cache entry
# expires after RECENT_CACHE_TTL_H; older windows are cached forever.
RECENT_DAYS = 10
RECENT_CACHE_TTL_H = 6

DEFAULT_DAYS = 5          # daily run re-downloads this many past days (+ today)
DEFAULT_CHUNK_MONTHS = 1  # --from/--to backfill is split into chunks of N months

ENDPOINTS = {
    "power": {"path": "/v2/public_power", "dir": "power"},
    "flows": {"path": "/v2/cbpf", "dir": "flows"},
}

# Country/endpoint pairs we do not download (checked on the live API 2026-11-26).
SKIP = {
    "power": {
        "ua",  # Ukraine: API answers 404 "no content available"; only flows exist
        "uk",  # API has only ~0.4 GW of Great Britain's ~30 GW generation, no nuclear, no load
    },
    "flows": {
        "cy",  # Cyprus: island without interconnectors (404)
    },
}

# --------------------------------------------------------------------------
# Countries
# --------------------------------------------------------------------------
# Countries we download (API codes). Extend freely.
COUNTRIES = [
    "cz", "de", "at", "sk", "pl", "hu", "fr", "nl", "be", "ch", "it",
    "si", "hr", "ro", "bg", "es", "pt", "dk", "se", "no", "fi", "uk",
    # rest of Europe available in the API (aggregates 'eu' and 'all' left out)
    "ie", "lu", "gr", "ee", "lv", "lt", "rs", "ba", "me", "mk", "xk",
    "md", "ua", "cy", "ge",
]

# Metadata for every country that can appear on the map: the downloaded ones
# plus neighbours that only show up as the other side of a border.
# center = [lon, lat] used as the end point of flow arrows (visual centre,
# shifted towards the populated / interconnected part where it helps).
COUNTRY_INFO = {
    "cz": {"name": "Česko", "center": [15.4, 49.8], "tz": "Europe/Prague"},
    "de": {"name": "Německo", "center": [10.4, 51.0], "tz": "Europe/Berlin"},
    "at": {"name": "Rakousko", "center": [14.6, 47.6], "tz": "Europe/Vienna"},
    "sk": {"name": "Slovensko", "center": [19.5, 48.7], "tz": "Europe/Bratislava"},
    "pl": {"name": "Polsko", "center": [19.3, 52.1], "tz": "Europe/Warsaw"},
    "hu": {"name": "Maďarsko", "center": [19.4, 47.2], "tz": "Europe/Budapest"},
    "fr": {"name": "Francie", "center": [2.5, 46.8], "tz": "Europe/Paris"},
    "nl": {"name": "Nizozemsko", "center": [5.7, 52.3], "tz": "Europe/Amsterdam"},
    "be": {"name": "Belgie", "center": [4.6, 50.6], "tz": "Europe/Brussels"},
    "ch": {"name": "Švýcarsko", "center": [8.2, 46.8], "tz": "Europe/Zurich"},
    "it": {"name": "Itálie", "center": [11.8, 43.4], "tz": "Europe/Rome"},
    "si": {"name": "Slovinsko", "center": [14.8, 46.1], "tz": "Europe/Ljubljana"},
    "hr": {"name": "Chorvatsko", "center": [16.2, 45.4], "tz": "Europe/Zagreb"},
    "ro": {"name": "Rumunsko", "center": [25.0, 45.9], "tz": "Europe/Bucharest"},
    "bg": {"name": "Bulharsko", "center": [25.3, 42.7], "tz": "Europe/Sofia"},
    "es": {"name": "Španělsko", "center": [-3.6, 40.2], "tz": "Europe/Madrid"},
    "pt": {"name": "Portugalsko", "center": [-8.1, 39.6], "tz": "Europe/Lisbon"},
    "dk": {"name": "Dánsko", "center": [9.6, 55.9], "tz": "Europe/Copenhagen"},
    "se": {"name": "Švédsko", "center": [15.0, 60.0], "tz": "Europe/Stockholm"},
    "no": {"name": "Norsko", "center": [9.0, 61.0], "tz": "Europe/Oslo"},
    "fi": {"name": "Finsko", "center": [25.8, 62.4], "tz": "Europe/Helsinki"},
    "uk": {"name": "Velká Británie", "center": [-1.6, 52.8], "tz": "Europe/London"},
    # neighbours (not downloaded by default)
    "ie": {"name": "Irsko", "center": [-8.0, 53.2], "tz": "Europe/Dublin"},
    "lu": {"name": "Lucembursko", "center": [6.1, 49.7], "tz": "Europe/Luxembourg"},
    "gr": {"name": "Řecko", "center": [22.0, 39.6], "tz": "Europe/Athens"},
    "me": {"name": "Černá Hora", "center": [19.3, 42.8], "tz": "Europe/Podgorica"},
    "rs": {"name": "Srbsko", "center": [20.8, 44.1], "tz": "Europe/Belgrade"},
    "ba": {"name": "Bosna a Hercegovina", "center": [17.8, 44.2], "tz": "Europe/Sarajevo"},
    "mk": {"name": "Severní Makedonie", "center": [21.7, 41.6], "tz": "Europe/Skopje"},
    "al": {"name": "Albánie", "center": [20.0, 41.1], "tz": "Europe/Tirane"},
    "xk": {"name": "Kosovo", "center": [20.9, 42.6], "tz": "Europe/Belgrade"},
    "ua": {"name": "Ukrajina", "center": [30.5, 49.2], "tz": "Europe/Kyiv"},
    "md": {"name": "Moldavsko", "center": [28.5, 47.2], "tz": "Europe/Chisinau"},
    "lt": {"name": "Litva", "center": [23.9, 55.3], "tz": "Europe/Vilnius"},
    "lv": {"name": "Lotyšsko", "center": [24.9, 56.9], "tz": "Europe/Riga"},
    "ee": {"name": "Estonsko", "center": [25.5, 58.7], "tz": "Europe/Tallinn"},
    "mt": {"name": "Malta", "center": [14.4, 35.9], "tz": "Europe/Malta"},
    "by": {"name": "Bělorusko", "center": [28.0, 53.5], "tz": "Europe/Minsk"},
    "ru": {"name": "Rusko", "center": [36.0, 56.5], "tz": "Europe/Moscow"},
    "tr": {"name": "Turecko", "center": [32.5, 39.2], "tz": "Europe/Istanbul"},
    "ma": {"name": "Maroko", "center": [-6.3, 33.0], "tz": "Africa/Casablanca"},
    "cy": {"name": "Kypr", "center": [33.2, 35.0], "tz": "Asia/Nicosia"},
    "ad": {"name": "Andorra", "center": [1.6, 42.5], "tz": "Europe/Andorra"},
    "ni": {"name": "Severní Irsko", "center": [-6.6, 54.65], "tz": "Europe/London"},
    "ge": {"name": "Gruzie", "center": [43.6, 42.2], "tz": "Asia/Tbilisi"},
    "am": {"name": "Arménie", "center": [44.8, 40.2], "tz": "Asia/Yerevan"},
    "az": {"name": "Ázerbájdžán", "center": [47.5, 40.3], "tz": "Asia/Baku"},
}

# cbpf identifies neighbours by English name; map them to our codes.
NEIGHBOUR_NAMES = {
    "albania": "al", "andorra": "ad", "armenia": "am", "austria": "at",
    "azerbaijan": "az", "belarus": "by", "georgia": "ge",
    "belgium": "be", "bosnia_and_herzegovina": "ba", "bosnia_herzegovina": "ba",
    "bulgaria": "bg", "croatia": "hr", "cyprus": "cy", "czech_republic": "cz",
    "czechia": "cz", "denmark": "dk", "estonia": "ee", "finland": "fi",
    "france": "fr", "germany": "de", "greece": "gr", "hungary": "hu",
    "ireland": "ie", "italy": "it", "kosovo": "xk", "latvia": "lv",
    "lithuania": "lt", "luxembourg": "lu", "malta": "mt", "moldova": "md",
    "montenegro": "me", "morocco": "ma", "netherlands": "nl",
    "north_macedonia": "mk", "macedonia": "mk", "norway": "no", "poland": "pl",
    "portugal": "pt", "romania": "ro", "russia": "ru", "serbia": "rs",
    "slovakia": "sk", "slovenia": "si", "spain": "es", "sweden": "se",
    "switzerland": "ch", "turkey": "tr", "ukraine": "ua",
    "united_kingdom": "uk", "great_britain": "uk",
    # 'uk' data is Great Britain only; Northern Ireland (Moyle link) is neither
    # in 'uk' nor in 'ie' data, so it is a neighbour of its own.
    "northern_ireland": "ni",
}
NEIGHBOUR_SKIP = {"sum"}

# Day boundaries for the Europe-wide flow summaries (one zone for the map).
FLOWS_TZ = "Europe/Brussels"
FLOWS_HOURLY_DAYS = 30

# --------------------------------------------------------------------------
# Production types
# --------------------------------------------------------------------------
# API series id -> our stable key. Unknown ids are kept under their own id
# (and reported by fetch.py) so nothing is silently lost.
POWER_SERIES = {
    "nuclear": "nuclear",
    "fossil_brown_coal_lignite": "lignite",
    "fossil_hard_coal": "hard_coal",
    "fossil_coal_derived_gas": "coal_gas",
    "fossil_coal-derived_gas": "coal_gas",
    "fossil_gas": "gas",
    "fossil_oil": "oil",
    "fossil_oil_shale": "oil_shale",
    "fossil_peat": "peat",
    "hydro_run_of_river": "hydro_run_of_river",
    "hydro_water_reservoir": "hydro_reservoir",
    "hydro_pumped_storage": "hydro_pumped_storage",
    "hydro_pumped_storage_consumption": "hydro_pumped_storage_consumption",
    "biomass": "biomass",
    "geothermal": "geothermal",
    "wind_onshore": "wind_onshore",
    "wind_offshore": "wind_offshore",
    "solar": "solar",
    "waste": "waste",
    "others": "other",
    "other_renewables": "other_renewable",
    "battery": "battery",
    "battery_consumption": "battery_consumption",
    "battery_storage": "battery",
    "battery_storage_consumption": "battery_consumption",
    "load": "load",
}
# Derived / redundant series we don't store.
POWER_SERIES_SKIP = {
    "residual_load",
    "renewable_share_of_load",
    "renewable_share_of_generation",
    "cross_border_electricity_trading",  # commercial; physical flows come from cbpf
}

# Stable order + display metadata. kind: generation | consumption | load.
# Colours follow energy-charts.info conventions. renewable = share of the
# source counted as renewable (waste 50 %, like energy-charts.info).
SOURCES = [
    # key, Czech name, colour, renewable, kind
    ("nuclear", "Jádro", "#d62728", False, "generation"),
    ("lignite", "Hnědé uhlí", "#8b5a2b", False, "generation"),
    ("hard_coal", "Černé uhlí", "#3d3d3d", False, "generation"),
    ("coal_gas", "Koksárenský plyn", "#6b6b6b", False, "generation"),
    ("oil_shale", "Živičná břidlice", "#5a4632", False, "generation"),
    ("peat", "Rašelina", "#a07850", False, "generation"),
    ("gas", "Plyn", "#f28e2b", False, "generation"),
    ("oil", "Ropa", "#7f3f00", False, "generation"),
    ("waste", "Odpad", "#9c8c6c", 0.5, "generation"),  # half counted as renewable (biogenic)
    ("other", "Ostatní", "#a6a6a6", False, "generation"),
    ("hydro_run_of_river", "Průtočné vodní", "#1f4e9e", True, "generation"),
    ("hydro_reservoir", "Akumulační vodní", "#2f6fbf", True, "generation"),
    ("hydro_pumped_storage", "Přečerpávací (výroba)", "#5b8fd6", False, "generation"),
    ("battery", "Baterie (výroba)", "#9467bd", False, "generation"),
    ("biomass", "Biomasa", "#2ca02c", True, "generation"),
    ("geothermal", "Geotermální", "#b05a00", True, "generation"),
    ("other_renewable", "Ostatní OZE", "#76b041", True, "generation"),
    ("wind_offshore", "Vítr na moři", "#1f77b4", True, "generation"),
    ("wind_onshore", "Vítr na pevnině", "#5aa9e6", True, "generation"),
    ("solar", "Slunce", "#f5c518", True, "generation"),
    ("hydro_pumped_storage_consumption", "Přečerpávací (spotřeba)", "#9bb8e0", False, "consumption"),
    ("battery_consumption", "Baterie (nabíjení)", "#c5b0d5", False, "consumption"),
    ("load", "Zatížení (spotřeba)", "#000000", False, "load"),
]
SOURCE_ORDER = [s[0] for s in SOURCES]

# Storage output only returns energy stored earlier, so it is left out of
# the generation total when computing the renewable share (as energy-charts.info does).
STORAGE_SOURCES = {"hydro_pumped_storage", "battery"}

ATTRIBUTION = "Data: energy-charts.info (Fraunhofer ISE), původně ENTSO-E · licence CC BY 4.0"


# ==========================================================================
# World: yearly and monthly data from Ember (fetch_world.py, build_world.py)
# ==========================================================================
# Free API key: https://ember-energy.org/data/api/ - read from the environment
# variable EMBER_API_KEY or from a git-ignored .env file in the repo root.
EMBER_API_BASE = "https://api.ember-energy.org/v1"
EMBER_KEY_ENV = "EMBER_API_KEY"
EMBER_HTTP_TIMEOUT = 300           # seconds; the full monthly dataset is ~40 MB
WORLD_RAW_DIR = RAW_DIR / "world"
WORLD_START_YEAR = 2000
# Static metadata (Czech names, ISO 3166 alpha-2, region) made by tools/make_world.py
WORLD_ENTITIES_PATH = ROOT / "pipeline" / "world_entities.json"
WORLD_ATTRIBUTION = "Data: Ember (ember-energy.org) · licence CC BY 4.0"

# Ember generation series -> our key. Aggregated series (Total generation,
# Renewables, Fossil, Clean, ...) are sums of these and are not stored.
EMBER_SERIES = {
    "Bioenergy": "bioenergy",
    "Coal": "coal",
    "Gas": "gas",
    "Hydro": "hydro",
    "Nuclear": "nuclear",
    "Other fossil": "other_fossil",
    "Other renewables": "other_renewables",
    "Solar": "solar",
    "Wind": "wind",
    "Net imports": "net_imports",
}
# Field order in raw files and web summaries
WORLD_FIELDS = ["coal", "gas", "other_fossil", "nuclear", "hydro", "bioenergy", "other_renewables",
                "wind", "solar", "net_imports", "demand", "ci", "kwh_pc"]
WORLD_UNITS = {"ci": "gCO2/kWh", "kwh_pc": "kWh per person", "*": "TWh"}

WORLD_SOURCES = [
    # key, Czech name, colour, renewable, low-carbon. Stack order = this order; colours follow the
    # usual energy conventions and pass the colour-blind check for neighbouring stack segments.
    ("coal", "Uhlí", "#7b4f2c", False, False),
    ("gas", "Plyn", "#f28e2b", False, False),
    ("other_fossil", "Ropa a ostatní fosilní", "#8c8c8c", False, False),
    ("nuclear", "Jádro", "#d62728", False, True),
    ("hydro", "Voda", "#2f6fbf", True, True),
    ("bioenergy", "Biomasa", "#2ca02c", True, True),
    ("other_renewables", "Geotermální a ostatní OZE", "#9467bd", True, True),
    ("wind", "Vítr", "#5aa9e6", True, True),
    ("solar", "Slunce", "#e0b000", True, True),
]

# Ember aggregate entities (no ISO code) -> our code and Czech name.
# `region` = the key of the region the aggregate stands for in WORLD_REGIONS.
WORLD_AGGREGATES = {
    "World": ("world", "Svět"),
    "EU": ("eu", "Evropská unie"),
    "Europe": ("europe", "Evropa"),
    "Asia": ("asia", "Asie"),
    "Middle East": ("middle_east", "Blízký východ"),
    "Africa": ("africa", "Afrika"),
    "North America": ("north_america", "Severní Amerika"),
    "Latin America and Caribbean": ("latin_america", "Latinská Amerika a Karibik"),
    "Oceania": ("oceania", "Oceánie"),
    "MENA": ("mena", "Blízký východ a sev. Afrika"),
    "G7": ("g7", "G7"),
    "G20": ("g20", "G20"),
    "OECD": ("oecd", "OECD"),
    "ASEAN": ("asean", "ASEAN"),
    "AU": ("au", "Africká unie"),
}
# Regions used to group countries, with Ember's membership (checked against the
# sums of Ember's regional aggregates, see tools/make_world.py).
WORLD_REGIONS = [
    ("europe", "Evropa"),
    ("asia", "Asie"),
    ("middle_east", "Blízký východ"),
    ("africa", "Afrika"),
    ("north_america", "Severní Amerika"),
    ("latin_america", "Latinská Amerika"),
    ("oceania", "Oceánie"),
]
