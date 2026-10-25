Pro version with API link straight to EventBrite and docker deployment.

planned -
assign specific design to certain user in event (so they can have different designs such as exhibitor / staff etc)

issues -
clicking + new organization cannot be backed out of, page has to be refreshed to close window
once page is refreshed cannot enter existing event, have to start new one

## Running

```bash
cp .env.example .env   # then set SECRET_KEY and BASE_URL
docker compose up -d --build
```
