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
        probe ingest ingest-dir dry-run dry-run-dir ingest-rebuild \
        stats coverage \
        api-test api-rebuild api-logs api-shell \
        db-expose db-private \
        places places-unlabeled places-labeled place-show place-label place-unlabel place-search \
        unknowns \
        tile-stats tiles-clear \
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
	@echo "  make ingest-rebuild       - rebuild the ingest image (after editing app/*.py)"
	@echo "  make ingest JSON=...      - ingest a single file into the DB"
	@echo "  make ingest-dir DIR=...   - ingest every Timeline export under a dir"
	@echo "  make dry-run-dir DIR=...  - dry-run all files under a dir"
	@echo "Inspect:"
	@echo "  make stats                - quick row counts and date span"
	@echo "  make coverage             - daily coverage summary"
	@echo "  make unknowns             - inspect unrecognized records (forensics)"
	@echo "  make tile-stats           - tile cache stats (hits / misses / bytes)"
	@echo "  make tiles-clear          - delete all cached tiles (forces re-fetch)"
	@echo "Places:"
	@echo "  make places                       - top places by visits"
	@echo "  make places-unlabeled             - places without a label, top by visits"
	@echo "  make places-labeled               - places that have a user label"
	@echo "  make place-show ID=ChIJ...        - full detail for one place"
	@echo "  make place-label ID=... NAME=...  - set a user label"
	@echo "  make place-unlabel ID=...         - clear a user label"
	@echo "  make place-search Q=foo           - substring-search labels"
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

# The ingest service is profile=tools and has no long-running command —
# `up --build` would try to start it. Just rebuild the image so the
# next `docker compose run --rm ingest ...` picks up source changes.
ingest-rebuild:
	$(COMPOSE) build ingest

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

# ---- Places (CLI labeling) ----

# All `place-*` and `places*` targets run the python CLI inside the
# ingest container. The container is rebuilt on demand via compose.
# We pass --tty so rich's tables render with proper widths and colors.

places:
	$(COMPOSE) run --rm -T ingest python -m app.places list

places-unlabeled:
	$(COMPOSE) run --rm -T ingest python -m app.places list --unlabeled

places-labeled:
	$(COMPOSE) run --rm -T ingest python -m app.places list --labeled

# Set ID=<place_id> when calling these
ID   ?=
NAME ?=
Q    ?=

place-show:
	@if [ -z "$(ID)" ]; then echo 'Usage: make place-show ID=ChIJ...'; exit 2; fi
	$(COMPOSE) run --rm -T ingest python -m app.places show "$(ID)"

place-label:
	@if [ -z "$(ID)" ] || [ -z "$(NAME)" ]; then \
	  echo 'Usage: make place-label ID=ChIJ... NAME="Mom'\''s house"'; exit 2; fi
	$(COMPOSE) run --rm -T ingest python -m app.places label "$(ID)" "$(NAME)"

place-unlabel:
	@if [ -z "$(ID)" ]; then echo 'Usage: make place-unlabel ID=ChIJ...'; exit 2; fi
	$(COMPOSE) run --rm -T ingest python -m app.places unlabel "$(ID)"

place-search:
	@if [ -z "$(Q)" ]; then echo 'Usage: make place-search Q=substring'; exit 2; fi
	$(COMPOSE) run --rm -T ingest python -m app.places search "$(Q)"

# ---- Unknowns (forensics) ----

unknowns:
	@$(COMPOSE) exec -T db psql -U locuser -d location_history -c \
	  "SELECT source_array, shape_hint, count(*) AS n \
	   FROM unknown_records \
	   GROUP BY 1, 2 \
	   ORDER BY n DESC \
	   LIMIT 50;"

# ---- Tile cache ----
#
# The API container is distroless and has no shell, so we run a
# small helper container (alpine) that mounts the same `tilecache`
# named volume to inspect or clear it.

TILE_HELPER := alpine:3.20

# Helper to discover the tilecache volume name (compose-project-prefixed).
_TILE_VOL = $$(docker inspect $$($(COMPOSE) ps -q api 2>/dev/null) \
	--format '{{range .Mounts}}{{if eq .Destination "/var/cache/tiles"}}{{.Name}}{{end}}{{end}}' \
	2>/dev/null)

tile-stats:
	@echo "=== /tile-stats (in-memory since last API start) ==="
	@curl -sf http://127.0.0.1:$(API_PORT)/tile-stats || echo "API not reachable"
	@echo ""
	@echo "=== On-disk cache ==="
	@VOL=$(_TILE_VOL); \
	if [ -z "$$VOL" ]; then \
	  echo "  (api not running — no volume to inspect)"; \
	else \
	  docker run --rm -v "$$VOL:/cache:ro" $(TILE_HELPER) sh -c '\
	    files=$$(find /cache -type f -name "*.png" 2>/dev/null | wc -l); \
	    echo "  files: $$files"; \
	    echo "  size:  $$(du -sh /cache 2>/dev/null | cut -f1)"'; \
	fi

tiles-clear:
	@echo "This will delete all cached tiles. Ctrl-C now to cancel."
	@sleep 2
	@VOL=$(_TILE_VOL); \
	if [ -z "$$VOL" ]; then \
	  echo "Could not find tile cache volume — is the api running?"; \
	  exit 1; \
	fi; \
	docker run --rm -v "$$VOL:/cache" $(TILE_HELPER) \
	  sh -c 'rm -rf /cache/* /cache/.[!.]* 2>/dev/null; echo "Cleared."'

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
