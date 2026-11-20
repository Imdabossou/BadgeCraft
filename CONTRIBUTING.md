# Contributing to BadgeCraft

Thanks for helping! A few things to know first.

- **Bugs and ideas:** open an issue. For printing problems, include the printer model, the print mode (badge-sized pages or sheet layout) and the browser.
- **Branches:** open pull requests against `development`. `main` only gets tested releases.
- **Checks:** the ruff lint, the backend start-up check, the Docker build and `nginx -t` must pass. CI runs them all. See [BUILDING.md](BUILDING.md).
- **Database changes:** existing installs upgrade by adding missing columns on startup. New columns need defaults, and an old database must still load.
- **Attendee data is personal data.** Don't log it, send it to third parties, or load scripts from CDNs. New browser libraries go in `nginx/html/js/vendor/` with their version and hash.
- **Never commit `.env`** or real credentials. Use `example.com` in examples.
- **Licence:** contributions are accepted under the project's licence (AGPL-3.0-or-later). Third-party code must be AGPL-compatible.
- **Security issues:** please report them privately, see [SECURITY.md](SECURITY.md).
