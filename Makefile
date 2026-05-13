.PHONY: backend-test frontend-test test dev build openapi-check

backend-test:
	go test ./...

frontend-test:
	npm --prefix frontend test -- --run

openapi-check:
	go run ./scripts/check_openapi_routes.go

test: openapi-check backend-test frontend-test

dev:
	@set -e; \
	frontend_port=5173; \
	while lsof -nP -iTCP:$$frontend_port -sTCP:LISTEN >/dev/null 2>&1; do \
		frontend_port=$$((frontend_port + 1)); \
	done; \
	backend_port=5174; \
	while lsof -nP -iTCP:$$backend_port -sTCP:LISTEN >/dev/null 2>&1 || [ "$$backend_port" = "$$frontend_port" ]; do \
		backend_port=$$((backend_port + 1)); \
	done; \
	echo "code-workbench frontend target: http://127.0.0.1:$$frontend_port"; \
	echo "code-workbench backend target: http://127.0.0.1:$$backend_port"; \
	go run ./cmd/workbench --dev --port $$backend_port & \
	backend_pid=$$!; \
	trap 'kill $$backend_pid 2>/dev/null || true; wait $$backend_pid 2>/dev/null || true' INT TERM EXIT; \
	CODE_WORKBENCH_API_TARGET=http://127.0.0.1:$$backend_port npm --prefix frontend run dev -- --port $$frontend_port

build:
	npm --prefix frontend run build
	rm -rf internal/server/static/dist
	cp -rf frontend/dist internal/server/static/dist
	go build ./cmd/workbench
