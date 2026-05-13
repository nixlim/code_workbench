package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"code_workbench/internal/config"
	"code_workbench/internal/server"
)

func main() {
	cfg, err := config.Parse(os.Args[1:])
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	app, err := server.New(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer app.Close()
	go app.RunScheduler(ctx)

	ln, addr, err := listen(cfg)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Handler: app.Handler()}
	errc := make(chan error, 1)
	go func() {
		log.Printf("code-workbench listening on http://%s", addr)
		errc <- srv.Serve(ln)
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case sig := <-stop:
		log.Printf("received %s, shutting down", sig)
		cancel()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	case err := <-errc:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}
}

func listen(cfg config.Config) (net.Listener, string, error) {
	attempts := 1
	if cfg.Dev && cfg.Port > 0 {
		attempts = 100
	}
	for i := 0; i < attempts; i++ {
		port := cfg.Port
		if cfg.Port > 0 {
			port += i
		}
		addr := fmt.Sprintf("%s:%d", cfg.Host, port)
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln, ln.Addr().String(), nil
		}
		if !cfg.Dev || !errors.Is(err, syscall.EADDRINUSE) {
			return nil, "", err
		}
	}
	return nil, "", fmt.Errorf("no available backend port starting at %d", cfg.Port)
}

func init() {
	flag.CommandLine.SetOutput(os.Stdout)
}
