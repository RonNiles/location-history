package tiles

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// ----- Store tests (pure filesystem) -----

func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := &Store{Root: dir}
	want := []byte("\x89PNG\r\n\x1a\nfake")

	if err := s.Put(10, 5, 7, want); err != nil {
		t.Fatal(err)
	}
	got, _, err := s.Get(10, 5, 7)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Errorf("round-trip mismatch")
	}
}

func TestStoreMissReturnsErrNotFound(t *testing.T) {
	s := &Store{Root: t.TempDir()}
	_, _, err := s.Get(0, 0, 0)
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestStorePutAtomicity(t *testing.T) {
	// We can't easily prove rename atomicity, but we can check that
	// no .tile-*.tmp file lingers in the dir after a successful Put.
	dir := t.TempDir()
	s := &Store{Root: dir}
	if err := s.Put(1, 2, 3, []byte("data")); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir + "/1/2")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".tile-") {
			t.Errorf("tempfile leaked: %s", e.Name())
		}
	}
}

func TestStorePathDoesNotEscapeRoot(t *testing.T) {
	// Sanity: negative coordinates produce paths within root, even
	// though OSM doesn't use them. (The HTTP handler is what really
	// guards this; this just confirms Path itself doesn't introduce
	// path separators.)
	s := &Store{Root: "/tmp/x"}
	if got := s.Path(-1, -1, -1); !strings.HasPrefix(got, "/tmp/x/") {
		t.Errorf("Path escaped root: %s", got)
	}
}

// ----- expandTileURL -----

func TestExpandTileURL(t *testing.T) {
	cases := []struct {
		tmpl    string
		z, x, y int
		want    string
	}{
		{"https://tile.example/{z}/{x}/{y}.png", 10, 5, 7,
			"https://tile.example/10/5/7.png"},
		{"https://t/{z}/{x}/{y}/{z}.png", 1, 2, 3,
			"https://t/1/2/3/1.png"},
		{"no-vars", 1, 2, 3, "no-vars"},
	}
	for _, c := range cases {
		got := expandTileURL(c.tmpl, c.z, c.x, c.y)
		if got != c.want {
			t.Errorf("expand(%q,%d,%d,%d) = %q, want %q", c.tmpl, c.z, c.x, c.y, got, c.want)
		}
	}
}

// ----- Fetcher with httptest -----

func TestFetcherSingleFlight(t *testing.T) {
	// Multiple concurrent calls for the same (z, x, y) must result
	// in exactly ONE upstream request.
	var hits int
	var mu sync.Mutex

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		// Slow response so concurrent calls overlap.
		time.Sleep(50 * time.Millisecond)
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte("tile"))
	}))
	defer srv.Close()

	f := NewFetcher(srv.URL+"/{z}/{x}/{y}.png", "test/1.0", 100, 10)

	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.Fetch(ctx, 1, 2, 3)
			if err != nil {
				t.Errorf("fetch: %v", err)
			}
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if hits != 1 {
		t.Errorf("expected 1 upstream hit, got %d", hits)
	}
}

func TestFetcherSendsUserAgent(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		w.Write([]byte("tile"))
	}))
	defer srv.Close()

	f := NewFetcher(srv.URL+"/{z}/{x}/{y}.png", "MyApp/1.0 (+example.com)", 100, 10)
	if _, err := f.Fetch(context.Background(), 0, 0, 0); err != nil {
		t.Fatal(err)
	}
	if gotUA != "MyApp/1.0 (+example.com)" {
		t.Errorf("user-agent not propagated: %q", gotUA)
	}
}

func TestFetcher404IsErrNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()
	f := NewFetcher(srv.URL+"/{z}/{x}/{y}.png", "test/1.0", 100, 10)
	_, err := f.Fetch(context.Background(), 0, 0, 0)
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestFetcherRespectsContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()
	f := NewFetcher(srv.URL+"/{z}/{x}/{y}.png", "test/1.0", 100, 10)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := f.Fetch(ctx, 0, 0, 0)
	if err == nil {
		t.Fatal("expected error on context timeout")
	}
}

func TestFetcherRefusesOversize(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 2 MiB
		w.Write(make([]byte, 2<<20))
	}))
	defer srv.Close()
	f := NewFetcher(srv.URL+"/{z}/{x}/{y}.png", "test/1.0", 100, 10)
	_, err := f.Fetch(context.Background(), 0, 0, 0)
	if err == nil {
		t.Fatal("expected error on oversized response")
	}
}

// ----- Cache tests (Store + Fetcher together) -----

func TestCacheHitsThenServesFromDisk(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write([]byte("tile"))
	}))
	defer srv.Close()

	c := &Cache{
		Store:   &Store{Root: t.TempDir()},
		Fetcher: NewFetcher(srv.URL+"/{z}/{x}/{y}.png", "test/1.0", 100, 10),
		MaxAge:  time.Hour,
	}
	r1, err := c.Get(context.Background(), 1, 2, 3)
	if err != nil {
		t.Fatal(err)
	}
	if r1.Source != "miss" {
		t.Errorf("first call should be miss, got %q", r1.Source)
	}
	r2, err := c.Get(context.Background(), 1, 2, 3)
	if err != nil {
		t.Fatal(err)
	}
	if r2.Source != "hit" {
		t.Errorf("second call should be hit, got %q", r2.Source)
	}
	if hits != 1 {
		t.Errorf("upstream should have been hit exactly once, got %d", hits)
	}

	stats := c.Stats()
	if stats.Hits != 1 || stats.Misses != 1 {
		t.Errorf("stats wrong: %+v", stats)
	}
}

func TestCacheStaleFallbackOnUpstreamError(t *testing.T) {
	// Seed cache with a stale tile, then make upstream fail. Cache
	// should serve the stale bytes rather than erroring.
	dir := t.TempDir()
	store := &Store{Root: dir}
	if err := store.Put(1, 2, 3, []byte("old-tile")); err != nil {
		t.Fatal(err)
	}
	// Force the file's mtime to be older than MaxAge.
	staleTime := time.Now().Add(-200 * 24 * time.Hour)
	if err := os.Chtimes(store.Path(1, 2, 3), staleTime, staleTime); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream broken", http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := &Cache{
		Store:   store,
		Fetcher: NewFetcher(srv.URL+"/{z}/{x}/{y}.png", "test/1.0", 100, 10),
		MaxAge:  90 * 24 * time.Hour,
	}
	r, err := c.Get(context.Background(), 1, 2, 3)
	if err != nil {
		t.Fatalf("expected stale-fallback, got err: %v", err)
	}
	if r.Source != "stale-fallback" {
		t.Errorf("expected stale-fallback, got %q", r.Source)
	}
	if string(r.Bytes) != "old-tile" {
		t.Errorf("expected old bytes, got %q", r.Bytes)
	}
}

func TestCacheRevalidatesStaleWhenUpstreamWorks(t *testing.T) {
	dir := t.TempDir()
	store := &Store{Root: dir}
	store.Put(1, 2, 3, []byte("old"))
	stale := time.Now().Add(-200 * 24 * time.Hour)
	os.Chtimes(store.Path(1, 2, 3), stale, stale)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("new"))
	}))
	defer srv.Close()

	c := &Cache{
		Store:   store,
		Fetcher: NewFetcher(srv.URL+"/{z}/{x}/{y}.png", "test/1.0", 100, 10),
		MaxAge:  90 * 24 * time.Hour,
	}
	r, err := c.Get(context.Background(), 1, 2, 3)
	if err != nil {
		t.Fatal(err)
	}
	if r.Source != "stale-revalidated" {
		t.Errorf("expected stale-revalidated, got %q", r.Source)
	}
	if string(r.Bytes) != "new" {
		t.Errorf("expected refreshed bytes, got %q", r.Bytes)
	}
}
