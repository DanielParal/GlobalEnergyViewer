# Energy Flows

Osobní webová aplikace (primárně pro mobil), která ukazuje, kolik elektřiny se v evropských
zemích vyrábí, z jakých zdrojů a kam teče přes hranice (část **Evropa**, hodinová data), a jak
vypadá výroba elektřiny ve zbytku světa (část **Svět**, měsíční a roční data). Běží bez serveru:
data se stahují skriptem do JSON souborů v repu, web je statická stránka.

Data:
- **Evropa:** [energy-charts.info](https://energy-charts.info) (Fraunhofer ISE), původně ENTSO-E,
  licence [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Data v repu jsou upravená:
  čtvrthodinové hodnoty jsou zprůměrované na hodiny, toky přepočtené na MW se znaménkem
  „kladná = export“ a pro web sečtené po dnech a měsících. Ceny elektřiny (day-ahead) se kvůli
  licenci neukládají.
- **Svět:** [Ember](https://ember-energy.org) (roční a měsíční data o elektřině), licence
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Upraveno: součty za období,
  podíly a průměry dopočítané.
- Mapy: Natural Earth (public domain).

## Rychlý start (lokálně)

Potřeba: Python 3.12+ s modulem `venv`, `make`. Na Debianu/Ubuntu:
`sudo apt install make python3-venv`.

```bash
make setup      # .venv + requests
make fetch      # ČR, poslední 3 dny (~1 min)
make build      # data/raw -> site/data + build/energy.sqlite
make serve      # http://localhost:8000
```

Na mobilu v domácí síti otevři `http://<IP počítače>:8000` a přes menu prohlížeče
„Přidat na plochu“.

Data pro část **Svět** potřebují bezplatný API klíč od Emberu
([registrace](https://ember-energy.org/data/api/)). Ulož ho do souboru `.env` v kořeni repa
(je v `.gitignore`, do gitu se nedostane), nebo do proměnné prostředí:

```bash
echo 'EMBER_API_KEY=…tvůj klíč…' > .env
make fetch-world   # ~20 s, všechny země světa
make build
```

Bez `make` stačí totéž přímo:

```bash
python3 pipeline/fetch.py --countries cz --days 3
python3 pipeline/build.py
python3 -m http.server -d site 8000
```

(Pokud venv nemáš, použije Makefile systémový `python3`; potřebuje jen balík `requests`.)

## Příkazy

| Příkaz | Co dělá |
| --- | --- |
| `make fetch` | rychlý debug: ČR, poslední 3 dny |
| `make fetch-all` | všechny země z `pipeline/config.py`, posledních 5 dní + dnešek (jako denní Action, ~12 min) |
| `make backfill FROM=2024-01-01 [TO=2024-12-31]` | historie po 3měsíčních dotazech |
| `make fetch-world` | svět z Emberu: roční (od 2000) a měsíční data všech zemí a regionů |
| `make build` | souhrny pro web + SQLite |
| `make build-fast` | jen souhrny pro web (bez SQLite) |
| `make serve` | lokální web na portu 8000 (`PORT=…` změní port) |
| `make db` | otevře `build/energy.sqlite` (`sqlite3`, jinak `python -m sqlite3`) |

### fetch.py

```
python pipeline/fetch.py [--countries cz,de] [--days 5] [--from 2026-01-01 [--to 2026-01-31]]
                         [--chunk-months 3] [--endpoints power,flows]
                         [--dry-run] [--no-cache] [--verbose]
```

- Mezi dvěma dotazy na **stejný endpoint** čeká 31 s (limit API je 2 dotazy/min na endpoint).
  Dotazy na výrobu a toky se střídají, takže běží souběžně a celkový čas je poloviční.
- HTTP 429 → čeká podle `Retry-After`; chyba 5xx/síť → 3 pokusy s pauzou 30/60/120 s.
  Chyba jedné země nezastaví ostatní; na konci je souhrn a nenulový návratový kód.
- Odpovědi API se ukládají do `.cache/`. Okna starší než 10 dní se berou z cache vždy,
  novější jen 6 hodin (data se zpětně doplňují). `--no-cache` cache obejde.
- Zápis je idempotentní: hodiny se slučují podle času, nová ne-null hodnota přepíše starou,
  `null` nikdy nesmaže existující hodnotu.

**Doba běhu historie:** API unese i 3 měsíce v jednom dotazu (~5 MB), proto
`make backfill` používá `--chunk-months 3`. 22 zemí × 1 rok ≈ 4 okna × 22 zemí × 31 s ≈ 45 min.
Celá historie od 1. 1. 2024 ≈ 2–2,5 hodiny.

### fetch_world.py

```
python pipeline/fetch_world.py [--dry-run] [--no-cache] [--verbose]
```

- Šest hromadných dotazů na [Ember API](https://api.ember-energy.org/v1/docs) (výroba podle
  zdroje, spotřeba a emisní intenzita, každé ročně i měsíčně), každý vrátí všechny země najednou.
  Ember nemá rate limit, celý běh trvá ~20 s a stáhne ~30 MB.
- Klíč se čte z `EMBER_API_KEY` (prostředí nebo `.env`) a posílá se jen Emberu. Odpovědi se
  6 hodin drží v `.cache/world/`.
- Zápis je idempotentní, stejně jako u Evropy: nová ne-null hodnota přepíše starou (Ember zpětně
  reviduje), `null` nic nesmaže.

### build.py

Bez sítě, deterministický (stejná vstupní data = byte po bytu stejný výstup, ověřeno).
Čte `data/raw/`, zapisuje `site/data/` a `build/energy.sqlite`, staré soubory v `site/data/` maže.
Světové souhrny dělá `pipeline/build_world.py` (volá ho `build.py`).

## Struktura

```
pipeline/config.py     země, mapování názvů z API, barvy a pořadí zdrojů, rate limit
pipeline/common.py     čas a čtení/zápis raw souborů
pipeline/fetch.py      energy-charts API -> data/raw/power, data/raw/flows
pipeline/fetch_world.py  Ember API -> data/raw/world
pipeline/build.py      data/raw/ -> site/data/ + build/energy.sqlite
pipeline/build_world.py  světová část buildu
pipeline/world_entities.json  české názvy, ISO kódy a regiony zemí světa (z tools/make_world.py)
data/raw/power/<cc>/<yyyy-mm>.json   hodinová výroba podle zdroje + zatížení (MW = MWh/h, UTC)
data/raw/flows/<cc>/<yyyy-mm>.json   hodinové toky se sousedy (MW, kladné = export z <cc>)
data/raw/world/yearly/<kód>.json     roční data Emberu (TWh podle zdroje, čistý dovoz, spotřeba,
                                     g CO₂/kWh, kWh/obyv.); kód = ISO 3166 alfa-3 nebo region (world, eu, asia…)
data/raw/world/monthly/<kód>.json    totéž po měsících (bez kWh/obyv.)
site/                  statický web (index.html, app.js, world.js, style.css, europe.geojson,
                       world.geojson, manifest)
site/data/             generované souhrny pro web (commitují se)
tools/                 jednorázové skripty: mapy (Natural Earth), názvy a regiony zemí, ikony
docs/samples/          vzorové odpovědi API
.github/workflows/daily.yml   denní Action (stažení, build, commit dat, nasazení na Pages)
```

### Souhrny pro web (`site/data/`)

| Soubor | Obsah |
| --- | --- |
| `countries.json` | země, názvy, středy pro mapu, dostupná období, metadata zdrojů (barvy), hranice |
| `power_daily/<cc>/<rok>.json` | denní GWh podle zdroje + zatížení + saldo toků (dny v místním čase země) |
| `power_monthly.json` | měsíční GWh pro všechny země |
| `power_hourly/<cc>/<yyyy-mm>.json` | hodinové MW (pro krok „hodina“); generuje se, **necommituje** (duplikuje raw) |
| `flows_daily/<rok>.json` | denní GWh pro každou hranici v obou směrech (dny v čase Europe/Brussels) |
| `flows_hourly/<yyyy-mm-dd>.json` | hodinový čistý tok na každé hranici, posledních 30 dní |
| `ranking.json` | pro pohled Žebříček: za každou zemi denně (posledních 31 dní) a měsíčně výroba celkem, OZE po skupinách (slunce, vítr, voda, biomasa), spotřeba, hrubý vývoz a dovoz |
| `world/meta.json` | svět: země a regiony (české názvy, region, dostupné roky a měsíce), zdroje a barvy |
| `world/yearly.json` | svět: všechny země a regiony × roky 2000–… (TWh podle zdroje, čistý dovoz, spotřeba, g CO₂/kWh, kWh/obyv.) + posledních 12 měsíců u zemí s měsíčními daty |
| `world/monthly/<kód>.json` | svět: měsíční data jedné země nebo regionu (načítá se až v pohledu Výroba) |

### Pohledy webu

- **Výroba:** skládaný graf výroby podle zdroje a čára spotřeby, souhrn (výroba, spotřeba, saldo, podíl OZE), porovnání více zemí.
- **Toky:** mapa Evropy se saldem států a šipkami toků, po dnech/obdobích nebo po hodinách s přehráváním.
- **Žebříček:** země seřazené podle podílu OZE na výrobě (nebo TWh z OZE) a podle salda toků
  (TWh nebo % spotřeby), nahoře největší vývozci, dole největší dovozci.

Přepínač **Evropa | Svět** v hlavičce. Část Svět (Ember):

- **Výroba:** mix zdrojů po měsících (~90 zemí a regionů) nebo po letech od roku 2000 (~210 zemí),
  v TWh nebo v %, se spotřebou. Souhrn: výroba, spotřeba, saldo, podíl OZE, bezemisní zdroje
  (OZE + jádro), emise g CO₂/kWh. Porovnání více zemí nebo regionů (Čína × USA × EU…).
- **Mapa:** svět obarvený podle zvoleného ukazatele (podíl OZE, vítr + slunce, bezemisní zdroje,
  uhlí, g CO₂/kWh, dovoz/vývoz v % spotřeby, spotřeba na obyvatele, výroba celkem), za nejnovější
  rok, konkrétní rok nebo posledních 12 měsíců. Klepnutím na zemi detail s mixem zdrojů.
- **Žebříček:** stejné ukazatele jako mapa; 30 největších zemí, regiony (svět, kontinenty, EU,
  G7, G20, OECD…), jednotlivé kontinenty nebo všechny země.
- **Srovnání:** EU × USA × Čína × Rusko (volitelně i svět): souhrnná tabulka za poslední rok
  nebo 12 měsíců (výroba, podíl na světě, spotřeba na obyvatele, OZE, jádro, uhlí, plyn, emise),
  mix zdrojů a vývoj od roku 2000 po letech nebo posledních 5 let po měsících (výroba, OZE,
  vítr + slunce, uhlí, g CO₂/kWh, Mt CO₂, spotřeba na obyvatele).

Toky po hranicích pro svět nejsou: nikdo je jednotně nepublikuje, Ember má jen roční/měsíční
čistý dovoz za celou zemi.

### SQLite (`build/energy.sqlite`)

- `power(country, ts, source, mw)`: hodinový průměr MW (= MWh), `ts` = začátek hodiny v UTC
  (`2026-11-01T00:00Z`). `source = 'load'` je spotřeba (zatížení).
- `flows(from_country, to_country, ts, mw)`: hodinový čistý fyzický tok na hranici, vždy ve směru
  toku (`mw >= 0`).
- pohledy `power_daily_utc` a `net_export_hourly`, tabulky `countries`, `sources`, `meta`.
- svět (Ember): `world_entities(code, name, ember_name, region, iso2, is_aggregate)`,
  `world_yearly(entity, year, field, value)` a `world_monthly(entity, month, field, value)`;
  `field` = zdroj (TWh), `net_imports` (TWh, kladné = dovoz), `demand` (TWh), `ci` (g CO₂/kWh),
  `kwh_pc` (kWh na obyvatele, jen ročně).

```sql
-- denní výroba ČR podle zdroje
SELECT day, source, gwh FROM power_daily_utc WHERE country = 'cz' AND day >= '2026-11-01';
-- kolik ČR vyvezla do Německa za rok 2026 (GWh)
SELECT sum(mw) / 1000 FROM flows WHERE from_country = 'cz' AND to_country = 'de' AND ts LIKE '2026%';
-- výroba ze slunce v Číně po letech (TWh)
SELECT year, value FROM world_yearly WHERE entity = 'CHN' AND field = 'solar' ORDER BY year;
```

## Poznámky k API (ověřeno na živém API 26. 11. 2026)

- `/v2/public_power`: 15min data v MW, časy v místním čase s offsetem. Řady: viz `POWER_SERIES`
  v `config.py`. Obsahuje i `load` (zatížení). Neukládáme odvozené řady (`residual_load`,
  podíly OZE) ani `cross_border_electricity_trading` (obchodní toky).
- `/v2/cbpf`: jednotka **GW** a konvence **kladná = import**. Ukládáme MW a **kladná = export**
  (`fetch.py` převádí). Sousedé jsou pojmenovaní anglicky (`czech_republic`, `united_kingdom`),
  mapují se v `NEIGHBOUR_NAMES`. Řada `sum` se neukládá.
- Parametr `end` je **včetně**, `fetch.py` proto posílá `end = …T23:59Z`.
- Limit 2 dotazy/min je **na endpoint**. Tři měsíce v jednom dotazu projdou bez problému.
- Francie hlásí i `battery` / `battery_consumption`. Neznámá řada se uloží pod svým id a
  `fetch.py` vypíše varování, ať ji doplníš do `config.py`.
- Kontrola: denní součty výroby ČR z `power_daily` sedí s daty grafu energy-charts.info
  (`energy-charts.info/charts/energy/data/cz/day_2026.json`) s odchylkou < 0,01 %.
- **Podíl OZE** = OZE / výroba bez přečerpávacích elektráren a baterií; odpad se počítá z 50 %
  jako obnovitelný. Je to stejná definice jako řada `renewable_share_of_generation` v API:
  za 27. 10.–25. 11. 2026 se naše čísla od ní liší průměrně o 0,16 p. b. (max. 1,4 p. b., Litva).
  Výjimky jsou na straně API: u Norska vrací 17 % (ve skutečnosti ~97 %, vodní + vítr) a u Černé Hory 46 %.
  Roční čísla pro kontrolu: Eurostat 2024 (čistá výroba) Dánsko 88,4 %, Portugalsko 87,5 %,
  Chorvatsko 73,7 %, Česko 15,9 %, EU 46,9 %.
- **Neúplná nebo vynechaná data ze zdroje:** výroba Velké Británie (`uk`) má v API jen ~0,4 GW
  z ~30 GW (bez jádra a spotřeby), proto se nestahuje; toky UK jsou v pořádku. Ukrajina nemá výrobu
  (404), Kypr nemá toky (ostrov). Irsko má výrobu jen ~60 % spotřeby (část zdrojů v datech chybí),
  Kosovo nemá OZE. Velká Británie v datech toků = Velká Británie bez Severního Irska; Severní Irsko
  je samostatný soused (`ni`).

## Poznámky k Ember API (ověřeno 26. 11. 2026)

- Roční data: 209 zemí + 15 regionů/skupin od roku 1985 (stahujeme od 2000), poslední rok 2025
  (u 99 zemí zatím jen 2024 nebo starší; web pak ukazuje nejnovější rok dané země s hvězdičkou).
  Měsíční data: 88 zemí + 11 regionů, nejčerstvější měsíc je obvykle 1–2 měsíce zpátky.
- Ukládáme jen základní řady (uhlí, plyn, ostatní fosilní, jádro, voda, biomasa, ostatní OZE,
  vítr, slunce, čistý dovoz); součty (OZE, fosilní, celkem) se dopočítají. Kontrola: podíly OZE,
  bezemisních zdrojů, uhlí a větru+slunce spočítané webem se od podílů publikovaných Emberem liší
  nejvýš o 0,05 p. b. u zemí nad 10 TWh (zaokrouhlení TWh na 2 desetinná místa).
- Regiony v pohledu Žebříček odpovídají agregacím Emberu (Arménie, Ázerbájdžán a Gruzie patří do
  Asie, Turecko a Kypr do Evropy, Írán na Blízký východ); součty zemí sedí s regionálními součty
  Emberu. Výjimka: Ukrajina od roku 2023 nemá vlastní data (válka) a Ember ji v součtu Evropy odhaduje.
- Na mapě chybí šest malých ostrovních států (např. Maledivy, Nauru), které Natural Earth 1:50m
  nemá; v žebříčku a ve výrobě jsou.

## Nasazení (později)

1. Vytvořit veřejné repo na GitHubu a pushnout.
2. Settings → Pages → Source: **GitHub Actions**.
3. Settings → Secrets and variables → Actions → **New repository secret**: `EMBER_API_KEY` = klíč
   od Emberu. Bez něj Action světová data přeskočí (jen varování) a Evropa se aktualizuje dál.
4. Action `daily` běží v 4:17 UTC a jde spustit i ručně (Actions → daily → Run workflow), s volitelnými
   vstupy `countries`, `days`, `from`, `to`. Prvotní historii lze dotáhnout ručním spuštěním s `from`
   (job má limit ~6 h, celá historie se do něj vejde), nebo lokálně přes `make backfill` a commit.
5. Action commitne změny v `data/raw/` a `site/data/`, nahraje `energy.sqlite.gz` do Release `latest`
   a nasadí `site/` na Pages. Selhání stahování jedné země nasazení nezastaví (jen varování).
6. Na stránce běhu (Summary) je krátký přehled: buď „already up to date“, nebo které země dostaly
   nová data a kolik souborů se commitlo.

**Minuty Actions:** jeden běh trvá ~15 min (svět z toho ~20 s) (většinu času čeká na rate limit API), tj. ~450 min/měsíc.
U veřejného repa jsou standardní GitHub runnery zdarma; u soukromého se to vejde do 2 000 min
free plánu. Kdo chce aktualizovat jen ručně, smaže v `daily.yml` blok `schedule` a spouští
tlačítkem **Run workflow** (jde i z mobilní aplikace GitHub). GitHub ve veřejném repu vypne
plánované workflow po 60 dnech bez aktivity; denní commity dat se ale jako aktivita počítají.
