package httpx

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// captureLogger returns a logger writing JSON to a bytes.Buffer, plus
// the buffer. Useful for asserting on log contents.
func captureLogger() (*slog.Logger, *bytes.Buffer) {
	buf := &bytes.Buffer{}
	l := slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return l, buf
}

// firstLogLine parses the first line of the buffer as JSON. Helper
// keeps test bodies short.
func firstLogLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	line, err := buf.ReadString('\n')
	if err != nil && err != io.EOF {
		t.Fatalf("read log: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("parse log line %q: %v", line, err)
	}
	return m
}

func runReq(h http.Handler, method, target string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// ---- baseline: bodies off ----

func TestLogRequests_BodiesOffNoBodyAttr(t *testing.T) {
	logger, buf := captureLogger()
	mw := LogRequests(logger, LogConfig{LogBodies: false})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"x":1}`))
	}))
	rr := runReq(h, "GET", "/x?q=1")
	if rr.Code != 200 {
		t.Fatalf("status: %d", rr.Code)
	}
	m := firstLogLine(t, buf)
	if _, has := m["body"]; has {
		t.Errorf("body attr present when LogBodies=false")
	}
	if m["path"] != "/x" {
		t.Errorf("path missing or wrong: %v", m["path"])
	}
	if m["status"] == nil {
		t.Errorf("status missing")
	}
	if m["request_id"] == "" || m["request_id"] == nil {
		t.Errorf("request_id missing")
	}
}

func TestLogRequests_RequestIDInResponseHeader(t *testing.T) {
	logger, _ := captureLogger()
	mw := LogRequests(logger, LogConfig{})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	}))
	rr := runReq(h, "GET", "/x")
	got := rr.Header().Get("X-Request-Id")
	if got == "" {
		t.Fatal("X-Request-Id header missing")
	}
	if len(got) != 12 {
		t.Errorf("X-Request-Id should be 12 hex chars, got %q", got)
	}
}

// ---- bodies on, JSON path ----

func TestLogRequests_JSONBodyParsedIntoLog(t *testing.T) {
	logger, buf := captureLogger()
	mw := LogRequests(logger, LogConfig{LogBodies: true})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"hits":3,"items":[1,2,3]}`))
	}))
	runReq(h, "GET", "/foo")
	m := firstLogLine(t, buf)
	body, ok := m["body"].(map[string]any)
	if !ok {
		t.Fatalf("body should be parsed JSON object, got %T: %v", m["body"], m["body"])
	}
	if body["hits"] != float64(3) {
		t.Errorf("body.hits = %v", body["hits"])
	}
	items, _ := body["items"].([]any)
	if len(items) != 3 {
		t.Errorf("body.items length = %d", len(items))
	}
}

func TestLogRequests_NonJSONBodyAsString(t *testing.T) {
	logger, buf := captureLogger()
	mw := LogRequests(logger, LogConfig{LogBodies: true})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("hello world"))
	}))
	runReq(h, "GET", "/text")
	m := firstLogLine(t, buf)
	if m["body"] != "hello world" {
		t.Errorf("expected raw string body, got %T %v", m["body"], m["body"])
	}
}

// ---- truncation ----

func TestLogRequests_OverflowTruncatesAndFlags(t *testing.T) {
	logger, buf := captureLogger()
	mw := LogRequests(logger, LogConfig{LogBodies: true})
	big := strings.Repeat("A", MaxLoggedBodyBytes+1024)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte(big))
	}))
	rr := runReq(h, "GET", "/big")
	// Client got the full body
	if rr.Body.Len() != len(big) {
		t.Errorf("client body length %d, want %d", rr.Body.Len(), len(big))
	}
	m := firstLogLine(t, buf)
	bodyGroup, ok := m["body"].(map[string]any)
	if !ok {
		t.Fatalf("expected truncation body group, got %T %v", m["body"], m["body"])
	}
	if bodyGroup["truncated"] != true {
		t.Errorf("truncated flag missing/false: %v", bodyGroup)
	}
	got := bodyGroup["text"].(string)
	if len(got) != MaxLoggedBodyBytes {
		t.Errorf("truncated text len = %d, want %d", len(got), MaxLoggedBodyBytes)
	}
	// The bytes count records what we actually wrote (full body).
	if int(m["bytes"].(float64)) != len(big) {
		t.Errorf("bytes attr should reflect full write")
	}
}

// ---- skip paths ----

func TestLogRequests_SkipsTilesEvenWithBodiesOn(t *testing.T) {
	logger, buf := captureLogger()
	mw := LogRequests(logger, LogConfig{LogBodies: true})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte("\x89PNG\r\n\x1a\n"))
	}))
	runReq(h, "GET", "/tiles/10/5/7.png")
	m := firstLogLine(t, buf)
	if _, has := m["body"]; has {
		t.Errorf("tile path should never have body attr, got: %v", m["body"])
	}
}

func TestLogRequests_SkipsUIAssets(t *testing.T) {
	logger, buf := captureLogger()
	mw := LogRequests(logger, LogConfig{LogBodies: true})
	cases := []string{"/", "/index.html", "/app.js", "/style.css", "/vendor/x.js"}
	for _, p := range cases {
		buf.Reset()
		h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Write([]byte("content"))
		}))
		runReq(h, "GET", p)
		m := firstLogLine(t, buf)
		if _, has := m["body"]; has {
			t.Errorf("path %q: should skip body capture", p)
		}
	}
}

// ---- query string preserved ----

func TestLogRequests_QueryStringInLog(t *testing.T) {
	logger, buf := captureLogger()
	mw := LogRequests(logger, LogConfig{})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	}))
	runReq(h, "GET", "/x?lat=37.77&lng=-122.42&radius_m=200")
	m := firstLogLine(t, buf)
	q, _ := m["query"].(string)
	if !strings.Contains(q, "lat=37.77") || !strings.Contains(q, "radius_m=200") {
		t.Errorf("query attr missing expected params: %q", q)
	}
}
