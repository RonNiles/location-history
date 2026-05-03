# Convenience wrappers. Run `make help` for the menu.
#
# All operations run through docker compose. Postgres has no host
# port by default — only the API is exposed, on loopback at $(API_PORT)
# (default 8000, configurable via .env). To temporarily expose Postgres
# for desktop tools, see `make db-expose` / `make db-private`.

# Load .env if it exists, so API_PORT (etc.) reach this Makefile too.
# Compose loads .env automatically; this is for the curl health-check
# below and any other targets that need the same values.
-include .env
export

# Defaults used if not set in .env. The `?=` operator means
# "set only if not already set", so .env (loaded above) wins.
API_PORT ?= 8000

JSON     ?= /path/to/your/Timeline.json
DIR      ?= /path/to/your/timeline-exports

COMPOSE     := docker compose
COMPOSE_RUN := $(COMPOSE) run --rm

.PHONY: help up down build logs ps psql migrate downgrade \
        probe ingest ingest-dir dry-run dry-run-dir \
        stats coverage \
        api-test api-rebuild api-logs api-shell \
        db-expose db-private \
        reset

help:
	@echo "Lifecycle:"
	@echo "  make up                   - build (if needed) and start db + api (port: $(API_PORT))"
	@echo "  make build                - rebuild images without starting"
	@echo "  make down                 - stop everything"
	@echo "  make ps                   - show running containers"
	@echo "  make logs                 - follow logs from all services"
	@echo "  make api-logs             - follow API logs only"
	@echo "  make api-rebuild          - rebuild and restart just the API"
	@echo "Database:"
	@echo "  make migrate              - apply Alembic migrations"
	@echo "  make psql                 - open psql shell against the in-network DB"
	@echo "  make db-expose            - expose Postgres on 127.0.0.1:5432 (opt-in)"
	@echo "  make db-private           - return Postgres to private (default)"
	@echo "Ingest (runs in container):"
	@echo "  make probe JSON=...       - probe a JSON export's structure"
	@echo "  make dry-run JSON=...     - parse without writing"
	@echo "  make ingest JSON=...      - ingest a single file into the DB"
	@echo "  make ingest-dir DIR=...   - ingest every Timeline export under a dir"
	@echo "  make dry-run-dir DIR=...  - dry-run all files under a dir"
	@echo "Inspect:"
	@echo "  make stats                - quick row counts and date span"
	@echo "  make coverage             - daily coverage summary"
	@echo "Testing:"
	@echo "  make api-test             - run Go unit tests on the host"
	@echo "Configuration:"
	@echo "  Edit .env (copy from .env.example) to override defaults like API_PORT."
	@echo "Danger:"
	@echo "  make reset                - DROP all data and re-migrate"

# ---- Lifecycle ----

up:
	$(COMPOSE) up -d --build db api
	@echo "Waiting for db to be healthy..."
	@until $(COMPOSE) exec -T db pg_isready -U locuser -d location_history >/dev/null 2>&1; do sleep 1; done
	@echo "Waiting for api to respond..."
	@for i in $$(seq 1 30); do \
	  if curl -sf http://127.0.0.1:$(API_PORT)/health >/dev/null 2>&1; then echo "API ready: http://127.0.0.1:$(API_PORT)"; exit 0; fi; \
	  sleep 1; \
	done; \
	echo "API didn't come up; check 'make api-logs'"; exit 1

build:
	$(COMPOSE) build

down:
	$(COMPOSE) down

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f

api-logs:
	$(COMPOSE) logs -f api

api-rebuild:
	$(COMPOSE) up -d --build api

# ---- DB shell / migrations ----

# `psql` profile service is one-shot; we run it interactively.
# It connects to the `db` service over the compose network.
psql:
	$(COMPOSE) run --rm -it psql

migrate:
	$(COMPOSE_RUN) -e "DATABASE_URL=postgresql+psycopg://locuser:locpass@db:5432/location_history" \
	  ingest alembic upgrade head

downgrade:
	$(COMPOSE_RUN) -e "DATABASE_URL=postgresql+psycopg://locuser:locpass@db:5432/location_history" \
	  ingest alembic downgrade -1

# ---- Ingest ----
# JSON / DIR are absolute paths on the host. We mount the relevant
# directory into the container at /work/host-input/ and translate the
# path. This way users can pass any path; we don't require files to
# live inside the project tree.

# Helper: derive the host directory and basename. Note that GNU make
# `dir`/`notdir` both work on the path string, no actual file
# resolution.
JSON_DIR  := $(dir $(JSON))
JSON_NAME := $(notdir $(JSON))
DIR_ABS   := $(abspath $(DIR))
JSON_ABS  := $(abspath $(JSON))
JSON_DIR_ABS := $(abspath $(JSON_DIR))

probe:
	$(COMPOSE_RUN) -v "$(JSON_DIR_ABS):/host-input:ro" ingest \
	  python -m app.ingest "/host-input/$(JSON_NAME)" --probe

dry-run:
	$(COMPOSE_RUN) -v "$(JSON_DIR_ABS):/host-input:ro" ingest \
	  python -m app.ingest "/host-input/$(JSON_NAME)" --dry-run

ingest:
	$(COMPOSE_RUN) -v "$(JSON_DIR_ABS):/host-input:ro" ingest \
	  python -m app.ingest "/host-input/$(JSON_NAME)"

ingest-dir:
	$(COMPOSE_RUN) -v "$(DIR_ABS):/host-input:ro" ingest \
	  python -m app.ingest_dir /host-input

dry-run-dir:
	$(COMPOSE_RUN) -v "$(DIR_ABS):/host-input:ro" ingest \
	  python -m app.ingest_dir /host-input --dry-run

# ---- Inspect ----

stats:
	@$(COMPOSE) exec -T db psql -U locuser -d location_history -c \
	  "SELECT 'raw_signals' AS table, count(*), min(ts) AS first, max(ts) AS last FROM raw_signals \
	   UNION ALL \
	   SELECT 'segments', count(*)::bigint, min(start_ts), max(end_ts) FROM segments \
	   UNION ALL \
	   SELECT 'activity_records', count(*)::bigint, min(ts), max(ts) FROM activity_records;"

coverage:
	@$(COMPOSE) exec -T db psql -U locuser -d location_history -c \
	  "SELECT \
	     count(*)                          AS total_days, \
	     count(*) FILTER (WHERE has_raw)   AS with_raw, \
	     count(*) FILTER (WHERE has_segments) AS with_segments, \
	     min(day) AS first_day, max(day) AS last_day \
	   FROM daily_coverage;"

# ---- Testing ----

api-test:
	cd api && go test ./...

# ---- Optional DB exposure ----

db-expose:
	$(COMPOSE) -f docker-compose.yml -f docker-compose.expose.yml up -d db
	@echo "Postgres now exposed on 127.0.0.1:5432"

db-private:
	$(COMPOSE) up -d --force-recreate db
	@echo "Postgres returned to private (no host port)."

# ---- Danger ----

reset:
	@echo "This will DROP all data. Ctrl-C now to cancel."
	@sleep 3
	$(COMPOSE) down -v
	$(COMPOSE) up -d --build db api
	@until $(COMPOSE) exec -T db pg_isready -U locuser -d location_history >/dev/null 2>&1; do sleep 1; done
	$(MAKE) migrate
