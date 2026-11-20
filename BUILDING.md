# Building BadgeCraft

BadgeCraft is a FastAPI backend with SQLite and a plain JavaScript frontend served by nginx. Docker Compose runs both.

## Running

```sh
cp .env.example .env   # set SECRET_KEY and BASE_URL
docker compose up -d --build
```

nginx serves `nginx/html` on port 80 and proxies `/api` and `/ws` to the backend. Frontend changes show on refresh if you bind-mount `nginx/html`; backend changes need `docker compose up -d --build`.

To run the backend without Docker:

```sh
cd backend
pip install -r requirements.txt
DATABASE_URL=sqlite:///./dev.db uvicorn main:app --port 8000
```

## Checks

CI runs:

```sh
cd backend
pipx run ruff check --select E9,F .    # syntax errors and pyflakes
uvicorn main:app --port 8000 &         # must start and serve /openapi.json
docker build -t badgecraft-backend-ci .
```

and checks `nginx/default.conf` with `nginx -t`.

For testing Eventbrite sync without the real API, set `EVENTBRITE_API_URL` to point the backend at a mock server.

## Source layout

| Path | What |
| --- | --- |
| `backend/main.py` | API routes: auth, organisations, events, attendees, Eventbrite, public registration, WebSocket |
| `backend/models.py` | Database models and the automatic column migration |
| `backend/eventbrite.py` | Eventbrite API client and attendee mapping |
| `backend/auth.py` | Accounts, tokens and Google sign-in |
| `backend/ws_manager.py` | Live updates between desks |
| `backend/email_utils.py`, `pdf_utils.py` | Invite emails and server-side PDFs |
| `nginx/html/index.html` | App markup |
| `nginx/html/js/app.js` | Accounts, events, check-in desk, attendees, printing, settings |
| `nginx/html/js/designer.js` | Badge designer, layout, preview, PDF export, high-res badge rendering |
| `nginx/html/register.html`, `js/register.js` | Public registration and kiosk page (`/r/<code>`) |
| `nginx/html/js/vendor/` | jsPDF, JSZip and QRCode.js, served locally. See its README for versions and how to update |
