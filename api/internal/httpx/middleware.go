// Package httpx contains small HTTP helpers shared by handlers:
// request logging, error JSON, and a CORS wrapper for local-only use.
package httpx

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// MaxLoggedBodyBytes caps how much of a response body we keep in
// memory for logging. Set high enough to capture a small radius
// search response in full, low enough that streaming endpoints
// (which can be megabytes) don't bloat the log.
const MaxLoggedBodyBytes = 64 * 1024

// statusRecorder wraps a ResponseWriter so the logging middleware can
// see what status code the handler ultimately wrote, count bytes,
// and (optionally) capture a copy of the response body for logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int

	// captureBody controls whether we keep a copy of the response in
	// `body`. When true, we accumulate up to MaxLoggedBodyBytes and
	// flip overflowed=true when the limit is hit.
	captureBody bool
	body        []byte
	overflowed  bool

	// contentType is sniffed from the first WriteHeader/Write so the
	// log can tell at a glance whether this was a JSON payload or
	// (e.g.) a tile PNG that we'd never want to read.
	contentType string
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	if s.contentType == "" {
		s.contentType = s.Header().Get("Content-Type")
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	if s.contentType == "" {
		s.contentType = s.Header().Get("Content-Type")
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	if s.captureBody && !s.overflowed {
		room := MaxLoggedBodyBytes - len(s.body)
		if room <= 0 {
			s.overflowed = true
		} else if n > room {
			s.body = append(s.body, b[:room]...)
			s.overflowed = true
		} else {
			s.body = append(s.body, b[:n]...)
		}
	}
	return n, err
}

// Flush forwards to the underlying writer if it supports it. Required
// for streaming endpoints to play nicely with the logging wrapper.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// LogConfig configures the request-logging middleware.
type LogConfig struct {
	// LogBodies, when true, captures up to MaxLoggedBodyBytes of
	// each response body and includes it in the log line. Off by
	// default: useful when debugging a specific issue, expensive
	// otherwise.
	LogBodies bool
}

// pathSkipsBodyCapture returns true for paths whose response bodies
// would be useless or harmful in a log: tiles (binary PNG noise),
// embedded UI assets (large and never useful for debugging API
// calls). Always applies, even when LogBodies is on.
func pathSkipsBodyCapture(p string) bool {
	switch {
	case strings.HasPrefix(p, "/tiles/"):
		return true
	case strings.HasPrefix(p, "/vendor/"):
		return true
	case p == "/" || strings.HasSuffix(p, ".js") ||
		strings.HasSuffix(p, ".css") || strings.HasSuffix(p, ".html") ||
		strings.HasSuffix(p, ".ico"):
		return true
	}
	return false
}

// newRequestID returns 12 hex chars — short enough to read at a
// glance, long enough to be unique within a debugging session.
func newRequestID() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(b[:])
}

// LogRequests is a middleware that logs each request with method,
// path, status, bytes, duration, and whether the client disconnected
// (context.Canceled). When cfg.LogBodies is true, also captures the
// response body (capped, JSON content types only).
func LogRequests(logger *slog.Logger, cfg LogConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			reqID := newRequestID()

			capture := cfg.LogBodies && !pathSkipsBodyCapture(r.URL.Path)
			rec := &statusRecorder{ResponseWriter: w, captureBody: capture}

			// Surface the request id to handlers (and to error helpers
			// that log) via a response header — also visible to clients,
			// which makes correlating a flaky UI experience with a log
			// line trivial.
			w.Header().Set("X-Request-Id", reqID)

			next.ServeHTTP(rec, r)

			attrs := []slog.Attr{
				slog.String("request_id", reqID),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.String("query", r.URL.RawQuery),
				slog.Int("status", rec.status),
				slog.Int("bytes", rec.bytes),
				slog.Duration("dur", time.Since(start)),
			}
			if rec.contentType != "" {
				attrs = append(attrs, slog.String("content_type", rec.contentType))
			}
			if err := r.Context().Err(); err != nil {
				attrs = append(attrs, slog.String("ctx_err", err.Error()))
			}
			if capture && len(rec.body) > 0 {
				// Try to attach the body as parsed JSON when possible —
				// that way `jq` queries on the log can dive into it
				// without re-parsing a string. Fall back to the raw
				// string if it's not JSON (or we overflowed mid-token).
				attrs = append(attrs, bodyAttr(rec.body, rec.overflowed, rec.contentType))
			}
			logger.LogAttrs(r.Context(), slog.LevelInfo, "http", attrs...)
		})
	}
}

// bodyAttr returns either a structured `body` attr (parsed JSON) or
// a string attr (raw text, possibly truncated). The truncation flag
// becomes its own attr so log consumers can tell partial responses
// from complete ones.
func bodyAttr(b []byte, truncated bool, contentType string) slog.Attr {
	if strings.Contains(contentType, "application/json") && !truncated {
		var anyVal any
		if err := json.Unmarshal(b, &anyVal); err == nil {
			return slog.Any("body", anyVal)
		}
	}
	// Either non-JSON, or JSON we couldn't parse (likely because we
	// truncated mid-token). Keep as a string and flag truncation.
	if truncated {
		return slog.Group("body",
			slog.String("text", string(b)),
			slog.Bool("truncated", true),
		)
	}
	return slog.String("body", string(b))
}

// CORSLocal is a permissive CORS wrapper appropriate for local-only
// development. Don't use this if you ever expose the API publicly.
func CORSLocal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Error writes a JSON error body. We intentionally don't leak DB
// errors verbatim — the message is a short string, and the original
// is logged.
func Error(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// ErrorFrom decides what status to use given an underlying error.
// Context cancellation deliberately does NOT produce a body —
// the client is gone.
func ErrorFrom(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	if errors.Is(err, r.Context().Err()) || r.Context().Err() != nil {
		// Client disconnected. Don't bother writing a response.
		return
	}
	logger.LogAttrs(r.Context(), slog.LevelWarn, "handler error",
		slog.String("path", r.URL.Path),
		slog.String("err", err.Error()),
	)
	Error(w, http.StatusInternalServerError, "internal error")
}
