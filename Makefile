.PHONY: backend-test frontend-test test dev build openapi-check

backend-test:
	go test ./...

frontend-test:
	npm --prefix frontend test -- --run

openapi-check:
	go run ./scripts/check_openapi_routes.go

test: openapi-check backend-test frontend-test

dev:
	( go run ./cmd/workbench --dev & ) && npm --prefix frontend run dev

build:
	npm --prefix frontend run build
	rm -rf internal/server/static/dist
	cp -rf frontend/dist internal/server/static/dist
	go build ./cmd/workbench

