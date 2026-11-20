# AGENTS.md

Event badge designer and reception check-in system. FastAPI + SQLite backend (`backend/`), plain JavaScript frontend served by nginx (`nginx/html/`), Docker Compose.

## Commands

- Run: `cp .env.example .env` (set `SECRET_KEY`, `BASE_URL`), then `docker compose up -d --build`
- Lint: `cd backend && pipx run ruff check --select E9,F .`
- Smoke test: the backend must start and serve `/openapi.json`; `nginx -t` must pass on `nginx/default.conf`
- More in [BUILDING.md](BUILDING.md)

## Conventions

- Branches: work on `development`; `main` only gets tested releases.
- `.env` is never committed. `.env.example` uses `badgecraft.example.com` and empty secrets.
- Frontend libraries are vendored in `nginx/html/js/vendor/` and checked against the cdnjs SRI hash. No CDN links.
- Light, dark and system themes, defaulting to the system, with the choice remembered.
- Keep README.md short. User how-to goes in `docs/guide.md`, developer detail in BUILDING.md.

## Traps

- `sqlmodel` is pinned to 0.0.44. Newer versions reject the naive UTC datetimes the models use.
- There's no migration tool. `models.py` adds missing columns on startup, so new columns need defaults and old databases must keep working. Test upgrades against an old database.
- The repo's compose file binds port 80. For a test copy, use a separate compose project on another port.
- Eventbrite sync can be tested against a mock by setting `EVENTBRITE_API_URL`.
- Check-ins and walk-ins must survive an Eventbrite re-sync.
- Smoke tests that need the full stack are easiest inside the backend container, using httpx or websockets against `http://nginx`.
