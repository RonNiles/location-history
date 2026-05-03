// Package db wraps a pgx connection pool and provides small helpers
// shared by handlers.
//
// We use pgxpool rather than database/sql because:
//  1. pgx's binary protocol is dramatically faster for the
//     high-row-count point queries this API runs.
//  2. Context cancellation propagates cleanly through pgx into the
//     backend, so a client disconnect actually cancels the running
//     query (libpq via database/sql does not do this).
//
// PostGIS values come back as text or pre-projected lng/lat columns
// from ST_X / ST_Y. We never decode raw WKB on the Go side.
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// New constructs and pings a pool. The DSN should be a libpq URL
// like postgresql://user:pass@host:port/dbname.
func New(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse pool config: %w", err)
	}
	// Tunables. These defaults are reasonable for a single-user API
	// fronting a desktop Postgres instance; bump pool size if you
	// expose this to more clients.
	cfg.MaxConns = 8
	cfg.MinConns = 1
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 10 * time.Minute
	// Statement-level timeout, applied per-connection on acquire.
	// Long-running queries can still exceed this if they're cooperatively
	// cancelled via context, but this is the absolute backstop.
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "60000" // 60s

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}
