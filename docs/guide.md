# Using BadgeCraft

## Setting up

Copy `.env.example` to `.env` and fill it in:

| Setting | What it's for |
| --- | --- |
| `SECRET_KEY` | Required. Generate one with `python3 -c "import secrets; print(secrets.token_hex(32))"` |
| `BASE_URL` | Required. The public address of your install, used in invite and registration links |
| `ALLOWED_ORIGINS` | Optional extra origins allowed to call the API |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Optional Google sign-in. Set the redirect URI to `<BASE_URL>/api/auth/google/callback`, here and in Google's console |
| `SMTP_*`, `FROM_EMAIL` | Optional, for emailed invites. Invite links work without it |

Data is kept in SQLite in the `db_data` volume. Upgrading keeps your data: new database columns are added automatically on startup.

## The check-in desk

- Search by name, company or email, or scan a ticket barcode. **Enter** checks the guest in and prints their badge.
- If a search finds nobody, the typed name pre-fills the **walk-in** form.
- Cancelled or refunded Eventbrite tickets are flagged at the desk.

## Events and registration

- Create an event, import a CSV, add people by hand, or turn on **online registration**. Each event gets a shareable link and QR code.
- **Kiosk:** open the registration link with `?kiosk=1` on a tablet at reception. Sign-ups are checked in automatically, and the desk gets a "Print badge" prompt.
- **Eventbrite:** add your organisation's private token in settings to import events and sync attendees. Check-ins and walk-ins survive a re-sync.

## Badge designs

- Text can use `{{field}}` placeholders. "Fit" text shrinks long names onto one line.
- To give different attendee types different badges, map a field (ticket type, or a custom "Attendee type" choice) to a design.

## Printing

Badges render at 300 DPI in the browser.

- **Label or card printers** (Brother, Dymo, Zebra, Evolis and so on): choose *Badge-sized pages* on the Check-in tab. Set the design's badge size to match the label, and turn off headers, footers and margins in the browser's print dialog.
- **A4 badge sheets or inserts**: choose *Sheet layout*. Badges are placed using the event's page layout.
- For one-click printing at a dedicated desk, start Chrome with `--kiosk-printing` to skip the print dialog.
- Each computer remembers its own print settings, so different desks can use different printers.
- Bulk PDF or ZIP export is there for printing in advance.

## Roles

- **Members** can run the desk and add walk-ins.
- **Admins** manage events, imports and settings.
- **Owners** also manage the organisation.

## Reports

Export attendees as CSV with check-in time, who checked them in, and print count.

## Planned

- Badge scanning for session and room check-in
- Email confirmations for online registrations
