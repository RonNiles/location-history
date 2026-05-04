# ---- builder ----
# Pinned to 1.22 because the project's go.mod targets 1.22 and pgx 5.7.x
# is the latest pgx that supports it.
FROM golang:1.22-bookworm AS builder

WORKDIR /src

# Copy go.mod first and download deps so this layer caches across
# source-only changes.
COPY go.mod ./
RUN go mod download || true

# Copy everything (Go source + the embedded UI under cmd/server/ui).
COPY . .

# Static build: CGO disabled, GOOS=linux. Resulting binary has no
# libc dependency and runs in distroless/static.
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
RUN go mod tidy && \
    go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ---- runtime ----
# distroless/static is ~2MB and contains only ca-certs, /etc/passwd
# and tzdata. No shell, no package manager.
#
# We deliberately run as root inside this container. Reasoning:
#   * The api binary needs to write to a Docker named volume mounted
#     at /var/cache/tiles. Named volumes are created root-owned by
#     default, and there's no portable way to chown them at mount
#     time without an init container or a non-distroless base.
#   * The container has no shell, no exec capability beyond running
#     the Go binary, and the api only opens the network port + cache
#     dir. Root inside a sealed container with this attack surface
#     is acceptable.
#   * The host port is loopback-only.
# If you'd rather run unprivileged: switch to alpine, add a tini
# entrypoint that chowns /var/cache/tiles, and `USER 1000`.
FROM gcr.io/distroless/static-debian12

COPY --from=builder /out/server /server

EXPOSE 8000

# DATABASE_URL and LISTEN are read from env. compose sets them.
ENTRYPOINT ["/server"]
