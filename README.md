# Code Workbench

Local single-user AI code workbench for repository sessions, candidate review, module registry composition, blueprints, and tmux-backed Claude Code jobs.

## Commands

- `make backend-test` runs Go backend tests.
- `make frontend-test` runs frontend unit/component tests.
- `make test` runs OpenAPI drift check, backend tests, and frontend tests.
- `make dev` starts the Go backend and Vite frontend with `/api/*` proxied to the backend.
- `make build` builds production frontend assets and the Go backend.

Use Go `1.26.3` or a later `1.26.x` patch release for backend development and verification.
