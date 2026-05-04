// Command server runs the location-history read API.
//
// Configuration via environment variables:
//
//	DATABASE_URL          postgresql://locuser:locpass@127.0.0.1:5432/location_history
//	LISTEN                127.0.0.1:8000  (default; bind address)
//	TILE_CACHE_DIR        /var/cache/tiles  (default; disk cache root)
//	TILE_UPSTREAM_URL     https://tile.openstreetmap.org/{z}/{x}/{y}.png  (default)
//	TILE_USER_AGENT       location-history/0.1 (+https://example.invalid)  (default)
//	TILE_RATE_PER_SEC     5   (default)
//	TILE_BURST            20  (default)
//
// All endpoints are read-only. The server is intended to be exposed
// to localhost only; the CORS middleware is permissive for that
// reason.
package main

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/locationhistory/api/internal/db"
	"github.com/locationhistory/api/internal/handlers"
	"github.com/locationhistory/api/internal/httpx"
	"github.com/locationhistory/api/internal/tiles"
)

// uiFiles is the static SPA bundled into the binary at build time.
// The Dockerfile copies the ui/ directory into api/cmd/server/ui
// before `go build`, so this embed always finds it.
//
//go:embed all:ui
var uiFiles embed.FS

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgresql://locuser:locpass@127.0.0.1:5432/location_history"
	}
	listen := os.Getenv("LISTEN")
	if listen == "" {
		listen = "127.0.0.1:8000"
	}

	// Root context: cancelled on SIGINT / SIGTERM. Every request derives
	// its own context from r.Context(), but we want startup work
	// (DB pool ping) to also be interruptible.
	rootCtx, stop := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.New(rootCtx, dsn)
	if err != nil {
		logger.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	logger.Info("connected to database")

	// Tile cache. The directory is configurable but we hardwire a
	// sensible default and log what we're using.
	tileDir := envOr("TILE_CACHE_DIR", "/var/cache/tiles")
	tileUpstream := envOr("TILE_UPSTREAM_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png")
	tileUA := envOr("TILE_USER_AGENT", "location-history/0.1 (+https://example.invalid)")
	tileRate := envOrInt("TILE_RATE_PER_SEC", 5)
	tileBurst := envOrInt("TILE_BURST", 20)

	if err := os.MkdirAll(tileDir, 0o755); err != nil {
		logger.Warn("tile cache dir not writable; cache disabled", "dir", tileDir, "err", err)
	}
	tileCache := &tiles.Cache{
		Store:   &tiles.Store{Root: tileDir},
		Fetcher: tiles.NewFetcher(tileUpstream, tileUA, tileRate, tileBurst),
		MaxAge:  tiles.MaxAge,
	}
	logger.Info("tile cache configured",
		"dir", tileDir, "upstream", tileUpstream,
		"rate_per_sec", tileRate, "burst", tileBurst)

	api := &handlers.API{Pool: pool, Logger: logger, TileCache: tileCache}

	r := chi.NewRouter()
	r.Use(httpx.LogRequests(logger))
	r.Use(httpx.CORSLocal)

	r.Get("/health", api.Health)
	r.Get("/coverage", api.Coverage)
	r.Get("/extent", api.Extent)
	r.Get("/signals", api.Signals)
	r.Get("/segments", api.Segments)
	r.Get("/points-near", api.PointsNear)
	r.Get("/tiles/{z}/{x}/{y}.png", api.Tiles)
	r.Get("/tile-stats", api.TileStats)

	// Serve the embedded UI from /. The embed includes a "ui/"
	// prefix; we strip it via fs.Sub so the file at ui/index.html
	// is served at /index.html (and / via http.FileServer's
	// directory-index behavior).
	uiSub, err := fs.Sub(uiFiles, "ui")
	if err != nil {
		logger.Error("ui sub", "err", err)
		os.Exit(1)
	}
	uiHandler := http.FileServer(http.FS(uiSub))
	// Mount on /. chi's router supports a wildcard catch-all at the
	// end; everything not matched by an API route falls through here.
	r.Handle("/*", uiHandler)

	srv := &http.Server{
		Addr:              listen,
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
		// We deliberately don't set WriteTimeout — streaming endpoints
		// can legitimately take a while. Per-query statement_timeout
		// in pgx and per-request context cancellation are the real
		// guards against runaway queries.
		BaseContext: func(_ net.Listener) context.Context { return rootCtx },
	}

	// Run the server. ListenAndServe returns immediately on Shutdown.
	go func() {
		logger.Info("listening", "addr", listen)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server", "err", err)
			stop()
		}
	}()

	<-rootCtx.Done()
	logger.Info("shutdown signal received, draining...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown", "err", err)
	}
	logger.Info("bye")
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envOrInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
