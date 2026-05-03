// Package httpx contains small HTTP helpers shared by handlers:
// request logging, error JSON, and a CORS wrapper for local-only use.
package httpx

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

// statusRecorder wraps a ResponseWriter so the logging middleware can
// see what status code the handler ultimately wrote.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}
func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// Flush forwards to the underlying writer if it supports it. Required
// for streaming endpoints to play nicely with the logging wrapper.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// LogRequests is a middleware that logs each request with method,
// path, status, bytes, duration, and whether the client disconnected
// (context.Canceled).
func LogRequests(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)
			attrs := []slog.Attr{
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.String("query", r.URL.RawQuery),
				slog.Int("status", rec.status),
				slog.Int("bytes", rec.bytes),
				slog.Duration("dur", time.Since(start)),
			}
			if err := r.Context().Err(); err != nil {
				attrs = append(attrs, slog.String("ctx_err", err.Error()))
			}
			logger.LogAttrs(r.Context(), slog.LevelInfo, "http", attrs...)
		})
	}
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
