package logging

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type JSONL struct {
	mu sync.Mutex
	w  io.WriteCloser
}

func NewJSONL(path string) (*JSONL, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	return &JSONL{w: f}, nil
}

func (l *JSONL) Close() error {
	if l == nil || l.w == nil {
		return nil
	}
	return l.w.Close()
}

func (l *JSONL) Event(kind string, attrs map[string]any) {
	if l == nil {
		return
	}
	row := map[string]any{"time": time.Now().UTC().Format(time.RFC3339Nano), "kind": kind}
	for k, v := range attrs {
		row[k] = v
	}
	b, err := json.Marshal(row)
	if err != nil {
		slog.Error("log marshal failed", "err", err)
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.w.Write(append(b, '\n'))
}
