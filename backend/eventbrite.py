"""Server-side Eventbrite access, using the organisation's private token."""
import os
import re
from typing import Optional

import httpx
from fastapi import HTTPException

EB_API = os.getenv("EVENTBRITE_API_URL", "https://www.eventbriteapi.com/v3")  # overridable for testing

# Attendee fields shown first; everything else follows in discovery order.
CORE_FIELDS = [
    "first_name", "last_name", "name", "email", "company", "job_title",
    "ticket_class_name", "cell_phone", "work_phone", "website", "order_id", "barcode",
]


class EventbriteClient:
    def __init__(self, token: str):
        if not token:
            raise HTTPException(400, "No Eventbrite token configured for this organisation")
        self._client = httpx.AsyncClient(
            base_url=EB_API,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self._client.aclose()

    async def get(self, path: str, params: Optional[dict] = None) -> dict:
        try:
            res = await self._client.get(path, params=params)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Could not reach Eventbrite: {e}")
        if res.status_code == 401:
            raise HTTPException(400, "Eventbrite rejected the token — check it in organisation settings")
        if res.status_code >= 400:
            try:
                detail = res.json().get("error_description") or res.text
            except ValueError:
                detail = res.text
            raise HTTPException(502, f"Eventbrite error ({res.status_code}): {detail}")
        return res.json()

    async def paged(self, path: str, key: str, params: Optional[dict] = None, max_pages: int = 200):
        """Yield every item of a paginated list endpoint (continuation or page based)."""
        params = dict(params or {})
        page = 1
        for _ in range(max_pages):
            data = await self.get(path, params)
            for item in data.get(key, []):
                yield item
            pag = data.get("pagination") or {}
            if not pag.get("has_more_items"):
                return
            if pag.get("continuation"):
                params["continuation"] = pag["continuation"]
                params.pop("page", None)
            else:
                page += 1
                params["page"] = page

    async def list_events(self) -> list[dict]:
        orgs = await self.get("/users/me/organizations/")
        events = []
        for org in orgs.get("organizations", []):
            async for ev in self.paged(
                f"/organizations/{org['id']}/events/", "events",
                {"status": "draft,live,started,ended,completed", "order_by": "start_desc"},
                max_pages=5,
            ):
                events.append(ev)
        return events

    async def get_event(self, event_id: str) -> dict:
        return await self.get(f"/events/{event_id}/")

    async def list_attendees(self, event_id: str) -> list[dict]:
        return [a async for a in self.paged(f"/events/{event_id}/attendees/", "attendees")]


def question_key(question: str) -> str:
    return ("q_" + re.sub(r"[^a-z0-9]+", "_", (question or "custom").lower())).strip("_")[:50]


def flatten_attendee(att: dict) -> dict:
    """Turn an Eventbrite attendee object into a flat {field: str} record."""
    p = att.get("profile") or {}
    home = (p.get("addresses") or {}).get("home") or {}
    row = {
        "first_name": p.get("first_name") or "",
        "last_name": p.get("last_name") or "",
        "name": p.get("name") or " ".join(x for x in [p.get("first_name"), p.get("last_name")] if x),
        "email": p.get("email") or "",
        "company": p.get("company") or "",
        "job_title": p.get("job_title") or "",
        "ticket_class_name": att.get("ticket_class_name") or "",
        "cell_phone": p.get("cell_phone") or "",
        "work_phone": p.get("work_phone") or "",
        "website": p.get("website") or "",
        "order_id": str(att.get("order_id") or ""),
        "barcode": ((att.get("barcodes") or [{}])[0] or {}).get("barcode", ""),
    }
    if home:
        row["city"] = home.get("city") or ""
        row["country"] = home.get("country") or ""
    for ans in att.get("answers") or []:
        row[question_key(ans.get("question"))] = ans.get("answer") or ""
    return {k: str(v) for k, v in row.items()}


def is_cancelled(att: dict) -> bool:
    return bool(att.get("cancelled") or att.get("refunded") or att.get("status") == "Not Attending")


def event_summary(ev: dict) -> dict:
    return {
        "id": ev["id"],
        "name": (ev.get("name") or {}).get("text") or f"Event {ev['id']}",
        "start": (ev.get("start") or {}).get("local") or (ev.get("start") or {}).get("utc"),
        "capacity": ev.get("capacity"),
        "status": ev.get("status"),
        "venue_id": ev.get("venue_id"),
    }
