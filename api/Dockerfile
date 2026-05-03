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
# (for nonroot user), and tzdata. No shell, no package manager.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/server /server

EXPOSE 8000
USER nonroot:nonroot

# DATABASE_URL and LISTEN are read from env. compose sets them.
ENTRYPOINT ["/server"]
