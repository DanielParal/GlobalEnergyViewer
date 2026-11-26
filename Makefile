# Local workflow - the same scripts the GitHub Action runs.
VENV := .venv
PY   := $(if $(wildcard $(VENV)/bin/python),$(VENV)/bin/python,python3)
PORT ?= 8000

.PHONY: setup fetch fetch-all fetch-world backfill build build-fast serve db clean help

help:
	@echo "make setup       create .venv and install requirements"
	@echo "make fetch       quick debug fetch: CZ, last 3 days (~1 min)"
	@echo "make fetch-all   all countries, last 5 days (like the daily Action)"
	@echo "make backfill FROM=2024-01-01 [TO=2024-12-31]   history, 3-month requests"
	@echo "make fetch-world world data from Ember (needs EMBER_API_KEY in env or .env)"
	@echo "make build       raw -> site/data + build/energy.sqlite"
	@echo "make build-fast  raw -> site/data only (no SQLite)"
	@echo "make serve       http://localhost:$(PORT) (also reachable from your phone on the LAN)"
	@echo "make db          open build/energy.sqlite"

setup:
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -r pipeline/requirements.txt

fetch:
	$(PY) pipeline/fetch.py --countries cz --days 3

fetch-all:
	$(PY) pipeline/fetch.py

fetch-world:
	$(PY) pipeline/fetch_world.py

backfill:
	@test -n "$(FROM)" || (echo "usage: make backfill FROM=YYYY-MM-DD [TO=YYYY-MM-DD]"; exit 2)
	$(PY) pipeline/fetch.py --from $(FROM) $(if $(TO),--to $(TO)) --chunk-months 3

build:
	$(PY) pipeline/build.py

build-fast:
	$(PY) pipeline/build.py --no-sqlite

serve:
	@echo "Open http://localhost:$(PORT)  (phone: http://<this computer's LAN IP>:$(PORT))"
	$(PY) -m http.server -d site $(PORT)

db:
	@if command -v sqlite3 >/dev/null; then sqlite3 build/energy.sqlite; \
	else $(PY) -m sqlite3 build/energy.sqlite; fi

clean:
	rm -rf build .cache site/data/power_hourly
