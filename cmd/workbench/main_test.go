package main

import (
	"net"
	"strconv"
	"strings"
	"testing"

	"code_workbench/internal/config"
)

func TestListenDevProbesNextAvailablePort(t *testing.T) {
	blocked, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer blocked.Close()
	_, portText, err := net.SplitHostPort(blocked.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	ln, addr, err := listen(config.Config{Host: "127.0.0.1", Port: port, Dev: true})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if strings.HasSuffix(addr, ":"+portText) {
		t.Fatalf("dev listener reused occupied port: %s", addr)
	}
}
