// Package tiles is a disk-backed cache and respectful upstream fetcher
// for OSM raster tiles.
//
// Three layers:
//   * Store   — filesystem-backed key/value over (z, x, y) -> []byte.
//   * Fetcher — HTTP client that fetches one tile from upstream OSM
//               with proper User-Agent, timeouts, rate-limit, and
//               single-flight (so simultaneous identical requests
//               result in a single upstream call).
//   * Cache   — coordinates the two: serve from Store if present and
//               fresh, otherwise fetch + store + serve.
//
// Why filesystem? Tiles are large-ish blobs (10-50KB) keyed by a
// natural 3-tuple. Filesystem layout (z/x/y.png) is the simplest
// possible storage, debuggable with `ls`/`du`, and benchmarks
// favorably with anything else for this access pattern.
//
// Why no Postgres? It would couple our cache lifetime to the DB,
// inflate the WAL with binary blobs, and hurt the rest of the
// app's IO. The filesystem is the right tool.
package tiles

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// MaxAge is how long a cached tile is considered fresh. After this,
// the cache will refetch. OSM tiles are nearly static so a long TTL
// is appropriate; we mostly want to eventually pick up renderer
// upgrades and substantial map data changes.
const MaxAge = 90 * 24 * time.Hour

// MaxTileBytes guards against runaway upstream responses.
const MaxTileBytes = 1 << 20 // 1 MiB; OSM PNGs are ~5-50KB

var (
	ErrNotFound       = errors.New("tile not found upstream")
	ErrUpstreamFailed = errors.New("upstream fetch failed")
)

// -------------------------------------------------------------- Store

// Store persists tile bytes on disk under root/z/x/y.png.
//
// Concurrent reads are safe (file open is atomic in POSIX).
// Concurrent writes to the same key are safe via os.Rename atomicity:
// we write to a temp file in the same dir and rename, which is
// guaranteed atomic on POSIX filesystems.
type Store struct {
	Root string
}

// Path returns the filesystem path where (z, x, y) lives. Exposed
// for tests and for cache stats.
func (s *Store) Path(z, x, y int) string {
	return filepath.Join(s.Root,
		strconv.Itoa(z),
		strconv.Itoa(x),
		strconv.Itoa(y)+".png",
	)
}

// Get returns the cached bytes and the file's mtime, or ErrNotFound.
func (s *Store) Get(z, x, y int) ([]byte, time.Time, error) {
	p := s.Path(z, x, y)
	info, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, time.Time{}, ErrNotFound
		}
		return nil, time.Time{}, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, time.Time{}, err
	}
	return b, info.ModTime(), nil
}

// Put atomically writes tile bytes to disk.
func (s *Store) Put(z, x, y int, data []byte) error {
	dir := filepath.Join(s.Root, strconv.Itoa(z), strconv.Itoa(x))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	final := filepath.Join(dir, strconv.Itoa(y)+".png")
	// Write to a tempfile in the same directory, then rename.
	tmp, err := os.CreateTemp(dir, ".tile-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() {
		// On error paths, clean up the tempfile.
		if _, statErr := os.Stat(tmpPath); statErr == nil {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, final)
}

// ------------------------------------------------------------- Fetcher

// Fetcher pulls tiles from upstream OSM. It respects:
//   - User-Agent (OSM requires identifying the app).
//   - A simple rate-limiter (token bucket) so a cold cache doesn't
//     hammer OSM.
//   - Single-flight de-duplication: simultaneous calls for the same
//     (z, x, y) result in exactly one upstream request.
type Fetcher struct {
	UpstreamURL string // e.g. "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
	UserAgent   string // OSM policy requires this
	Client      *http.Client
	Rate        <-chan struct{} // receive blocks until a token is available
	sf          singleflight.Group
}

// NewFetcher wires a Fetcher with a token-bucket rate limiter that
// produces `rate` tokens per second, capped at `burst` outstanding.
func NewFetcher(upstream, userAgent string, ratePerSec, burst int) *Fetcher {
	tokens := make(chan struct{}, burst)
	for i := 0; i < burst; i++ {
		tokens <- struct{}{}
	}
	go func() {
		if ratePerSec <= 0 {
			return
		}
		tick := time.NewTicker(time.Second / time.Duration(ratePerSec))
		defer tick.Stop()
		for range tick.C {
			select {
			case tokens <- struct{}{}:
			default:
				// bucket full — drop the token
			}
		}
	}()
	return &Fetcher{
		UpstreamURL: upstream,
		UserAgent:   userAgent,
		Client: &http.Client{
			Timeout: 15 * time.Second,
		},
		Rate: tokens,
	}
}

// Fetch fetches a single tile from upstream. Concurrent calls for
// the same (z, x, y) coalesce into a single request.
func (f *Fetcher) Fetch(ctx context.Context, z, x, y int) ([]byte, error) {
	key := fmt.Sprintf("%d/%d/%d", z, x, y)
	v, err, _ := f.sf.Do(key, func() (interface{}, error) {
		return f.fetchOne(ctx, z, x, y)
	})
	if err != nil {
		return nil, err
	}
	return v.([]byte), nil
}

func (f *Fetcher) fetchOne(ctx context.Context, z, x, y int) ([]byte, error) {
	// Wait for a rate-limit token (or context cancellation).
	select {
	case <-f.Rate:
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	url := expandTileURL(f.UpstreamURL, z, x, y)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", f.UserAgent)
	req.Header.Set("Accept", "image/png")

	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUpstreamFailed, err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		// proceed
	case http.StatusNotFound, http.StatusGone:
		return nil, ErrNotFound
	default:
		return nil, fmt.Errorf("%w: %s", ErrUpstreamFailed, resp.Status)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxTileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: read: %v", ErrUpstreamFailed, err)
	}
	if len(body) > MaxTileBytes {
		return nil, fmt.Errorf("%w: response exceeds %d bytes", ErrUpstreamFailed, MaxTileBytes)
	}
	return body, nil
}

func expandTileURL(template string, z, x, y int) string {
	// Tiny manual expansion — avoids pulling in a templating dep.
	out := template
	out = replaceAll(out, "{z}", strconv.Itoa(z))
	out = replaceAll(out, "{x}", strconv.Itoa(x))
	out = replaceAll(out, "{y}", strconv.Itoa(y))
	return out
}
func replaceAll(s, old, new string) string {
	for {
		i := indexOf(s, old)
		if i < 0 {
			return s
		}
		s = s[:i] + new + s[i+len(old):]
	}
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// --------------------------------------------------------------- Cache

// Cache wires a Store and a Fetcher. Get is the only public entry
// point; it serves from the Store when fresh and falls back to a
// fetch + put when not.
type Cache struct {
	Store   *Store
	Fetcher *Fetcher
	MaxAge  time.Duration

	// stats — concurrent-safe via mu
	mu                          sync.Mutex
	hitCount, missCount, errCount uint64
}

// Result describes the outcome of Get for stats / Cache-Status header.
type Result struct {
	Bytes  []byte
	Source string // "hit" | "miss" | "stale-revalidated"
	Age    time.Duration
}

// Get returns tile bytes, fetching from upstream if not cached.
func (c *Cache) Get(ctx context.Context, z, x, y int) (Result, error) {
	maxAge := c.MaxAge
	if maxAge == 0 {
		maxAge = MaxAge
	}

	if data, mtime, err := c.Store.Get(z, x, y); err == nil {
		age := time.Since(mtime)
		if age < maxAge {
			c.mu.Lock(); c.hitCount++; c.mu.Unlock()
			return Result{Bytes: data, Source: "hit", Age: age}, nil
		}
		// Stale; fall through to refetch but keep the old bytes
		// as a fallback if upstream is down.
		c.mu.Lock(); c.missCount++; c.mu.Unlock()
		newBytes, ferr := c.Fetcher.Fetch(ctx, z, x, y)
		if ferr != nil {
			// Upstream failed; serve stale rather than 5xx.
			return Result{Bytes: data, Source: "stale-fallback", Age: age}, nil
		}
		_ = c.Store.Put(z, x, y, newBytes)
		return Result{Bytes: newBytes, Source: "stale-revalidated", Age: 0}, nil
	} else if !errors.Is(err, ErrNotFound) {
		c.mu.Lock(); c.errCount++; c.mu.Unlock()
		return Result{}, err
	}

	c.mu.Lock(); c.missCount++; c.mu.Unlock()
	data, err := c.Fetcher.Fetch(ctx, z, x, y)
	if err != nil {
		return Result{}, err
	}
	if perr := c.Store.Put(z, x, y, data); perr != nil {
		// Log via caller; don't fail the request just because we
		// couldn't write the cache.
		return Result{Bytes: data, Source: "miss-uncached", Age: 0}, nil
	}
	return Result{Bytes: data, Source: "miss", Age: 0}, nil
}

// Stats returns counters for monitoring.
type Stats struct {
	Hits, Misses, Errors uint64
}

func (c *Cache) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return Stats{Hits: c.hitCount, Misses: c.missCount, Errors: c.errCount}
}
