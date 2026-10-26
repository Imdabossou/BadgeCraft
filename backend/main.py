import csv
import json
import io
import os
import re
import secrets
import time
import traceback
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import case, func
from sqlmodel import Session, select

from auth import (
    create_access_token, decode_token, get_current_user,
    google_auth_url, google_exchange_code,
    hash_password, verify_password, require_org_role,
)
from email_utils import send_invite_email
from eventbrite import CORE_FIELDS, EventbriteClient, event_summary, flatten_attendee, is_cancelled
from models import (
    Attendee, BadgeDesign, Event, Invite, OrgMember,
    Organisation, User, create_db, get_session, engine,
)
from ws_manager import manager
from pdf_utils import generate_bulk_pdf

BASE_URL = os.getenv("BASE_URL", "https://badgecraft.example.com")
EXTRA_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]

@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db()
    yield


app = FastAPI(title="BadgeCraft API", docs_url="/api/docs", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[BASE_URL, "http://localhost", *EXTRA_ORIGINS],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ════════════════════════════════════════════════════════════════════════════
# AUTH ROUTES
# ════════════════════════════════════════════════════════════════════════════

class RegisterRequest(BaseModel):
    email: str
    name: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


@app.post("/api/auth/register")
def register(req: RegisterRequest, session: Session = Depends(get_session)):
    existing = session.exec(select(User).where(User.email == req.email)).first()
    if existing:
        raise HTTPException(400, "Email already registered")
    if len(req.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    user = User(
        email=req.email,
        name=req.name,
        hashed_password=hash_password(req.password),
        is_verified=True,  # skip email verification for now
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    token = create_access_token(user.id)
    return {"token": token, "user": _user_dict(user)}


@app.post("/api/auth/login")
def login(req: LoginRequest, session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.email == req.email)).first()
    if not user or not user.hashed_password or not verify_password(req.password, user.hashed_password):
        raise HTTPException(401, "Invalid email or password")
    token = create_access_token(user.id)
    return {"token": token, "user": _user_dict(user)}


@app.get("/api/auth/google")
def google_login():
    state = secrets.token_urlsafe(16)
    return {"url": google_auth_url(state)}


@app.get("/api/auth/google/callback")
async def google_callback(code: str, state: str = "", session: Session = Depends(get_session)):
    try:
        guser = await google_exchange_code(code)
    except Exception as e:
        return RedirectResponse(f"/?error=google_failed")

    google_id = guser.get("sub")
    email = guser.get("email", "")
    name = guser.get("name", email.split("@")[0])
    avatar = guser.get("picture")

    # Find by google_id first, then by email
    user = session.exec(select(User).where(User.google_id == google_id)).first()
    if not user:
        user = session.exec(select(User).where(User.email == email)).first()
    if user:
        user.google_id = google_id
        user.avatar_url = avatar
        session.add(user)
        session.commit()
        session.refresh(user)
    else:
        user = User(
            email=email, name=name, google_id=google_id,
            avatar_url=avatar, is_verified=True,
        )
        session.add(user)
        session.commit()
        session.refresh(user)

    token = create_access_token(user.id)
    return RedirectResponse(f"/?token={token}")


@app.get("/api/auth/me")
def me(current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    memberships = session.exec(
        select(OrgMember, Organisation)
        .join(Organisation, OrgMember.org_id == Organisation.id)
        .where(OrgMember.user_id == current_user.id)
    ).all()
    orgs = [
        {"id": org.id, "name": org.name, "slug": org.slug, "role": member.role}
        for member, org in memberships
    ]
    return {**_user_dict(current_user), "organisations": orgs}


# ════════════════════════════════════════════════════════════════════════════
# ORGANISATION ROUTES
# ════════════════════════════════════════════════════════════════════════════

class CreateOrgRequest(BaseModel):
    name: str


class UpdateOrgRequest(BaseModel):
    name: Optional[str] = None
    eventbrite_token: Optional[str] = None


@app.post("/api/orgs")
def create_org(
    req: CreateOrgRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    slug = _slugify(req.name)
    # ensure unique slug
    base_slug = slug
    i = 2
    while session.exec(select(Organisation).where(Organisation.slug == slug)).first():
        slug = f"{base_slug}-{i}"
        i += 1

    org = Organisation(name=req.name, slug=slug)
    session.add(org)
    session.commit()
    session.refresh(org)

    member = OrgMember(org_id=org.id, user_id=current_user.id, role="owner")
    session.add(member)
    session.commit()

    return {"id": org.id, "name": org.name, "slug": org.slug, "role": "owner"}


@app.get("/api/orgs/{org_id}")
def get_org(
    org_id: int,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    org = session.get(Organisation, org_id)
    if not org:
        raise HTTPException(404, "Organisation not found")
    members = session.exec(
        select(OrgMember, User)
        .join(User, OrgMember.user_id == User.id)
        .where(OrgMember.org_id == org_id)
    ).all()
    return {
        "id": org.id,
        "name": org.name,
        "slug": org.slug,
        "has_eventbrite": bool(org.eventbrite_token),
        "members": [
            {"user_id": u.id, "name": u.name, "email": u.email, "avatar": u.avatar_url, "role": m.role}
            for m, u in members
        ],
    }


@app.patch("/api/orgs/{org_id}")
def update_org(
    org_id: int,
    req: UpdateOrgRequest,
    session: Session = Depends(get_session),
    membership: OrgMember = Depends(require_org_role("admin")),
):
    org = session.get(Organisation, org_id)
    if not org:
        raise HTTPException(404)
    if req.name:
        org.name = req.name
    if req.eventbrite_token is not None:
        org.eventbrite_token = req.eventbrite_token
    session.add(org)
    session.commit()
    return {"ok": True}


@app.delete("/api/orgs/{org_id}/members/{user_id}")
def remove_member(
    org_id: int,
    user_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    membership: OrgMember = Depends(require_org_role("admin")),
):
    ROLE_RANK = {"member": 0, "admin": 1, "owner": 2}
    target = session.exec(
        select(OrgMember).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id)
    ).first()
    if not target:
        raise HTTPException(404)
    if ROLE_RANK.get(target.role, 0) >= ROLE_RANK.get(membership.role, 0):
        raise HTTPException(403, "Cannot remove a member with equal or higher role")
    session.delete(target)
    session.commit()
    return {"ok": True}


@app.patch("/api/orgs/{org_id}/members/{user_id}/role")
def update_member_role(
    org_id: int,
    user_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    membership: OrgMember = Depends(require_org_role("owner")),
):
    new_role = body.get("role")
    if new_role not in ("admin", "member"):
        raise HTTPException(400, "Role must be admin or member")
    target = session.exec(
        select(OrgMember).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id)
    ).first()
    if not target:
        raise HTTPException(404)
    if target.role == "owner":
        raise HTTPException(403, "Cannot change owner role")
    target.role = new_role
    session.add(target)
    session.commit()
    return {"ok": True}


# ════════════════════════════════════════════════════════════════════════════
# INVITE ROUTES
# ════════════════════════════════════════════════════════════════════════════

class InviteRequest(BaseModel):
    email: Optional[str] = None    # if set, sends email invite
    role: str = "member"


@app.post("/api/orgs/{org_id}/invites")
async def create_invite(
    org_id: int,
    req: InviteRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    membership: OrgMember = Depends(require_org_role("admin")),
):
    if req.role not in ("admin", "member"):
        raise HTTPException(400, "Role must be admin or member")

    org = session.get(Organisation, org_id)
    code = secrets.token_urlsafe(12)
    invite = Invite(
        org_id=org_id,
        created_by=current_user.id,
        code=code,
        email=req.email,
        role=req.role,
        expires_at=datetime.utcnow() + timedelta(days=7),
    )
    session.add(invite)
    session.commit()

    if req.email:
        await send_invite_email(req.email, org.name, current_user.name, code)

    return {
        "code": code,
        "link": f"{BASE_URL}/?invite={code}",
        "email": req.email,
        "role": req.role,
    }


@app.get("/api/invites/{code}")
def get_invite(code: str, session: Session = Depends(get_session)):
    invite = session.exec(select(Invite).where(Invite.code == code)).first()
    if not invite or invite.used:
        raise HTTPException(404, "Invite not found or already used")
    if invite.expires_at and datetime.utcnow() > invite.expires_at:
        raise HTTPException(410, "Invite has expired")
    org = session.get(Organisation, invite.org_id)
    return {"org_name": org.name, "role": invite.role, "code": code}


@app.post("/api/invites/{code}/accept")
def accept_invite(
    code: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    invite = session.exec(select(Invite).where(Invite.code == code)).first()
    if not invite or invite.used:
        raise HTTPException(404, "Invite not found or already used")
    if invite.expires_at and datetime.utcnow() > invite.expires_at:
        raise HTTPException(410, "Invite expired")

    # Check not already a member
    existing = session.exec(
        select(OrgMember).where(
            OrgMember.org_id == invite.org_id,
            OrgMember.user_id == current_user.id,
        )
    ).first()
    if existing:
        raise HTTPException(409, "Already a member of this organisation")

    member = OrgMember(org_id=invite.org_id, user_id=current_user.id, role=invite.role)
    session.add(member)
    invite.used = True
    invite.used_by = current_user.id
    session.add(invite)
    session.commit()

    org = session.get(Organisation, invite.org_id)
    return {"org_id": invite.org_id, "org_name": org.name, "role": invite.role}


# ════════════════════════════════════════════════════════════════════════════
# EVENTS
# ════════════════════════════════════════════════════════════════════════════

# Form used for walk-ins and online registration unless the event defines its own
DEFAULT_FIELDS = [
    {"key": "first_name", "label": "First name", "type": "text", "required": True, "options": []},
    {"key": "last_name", "label": "Last name", "type": "text", "required": True, "options": []},
    {"key": "company", "label": "Company", "type": "text", "required": False, "options": []},
    {"key": "job_title", "label": "Job title", "type": "text", "required": False, "options": []},
    {"key": "email", "label": "Email", "type": "email", "required": False, "options": []},
]
FIELD_TYPES = {"text", "email", "tel", "select"}
MAX_VALUE_LEN = 500
ROLE_RANK = {"member": 0, "admin": 1, "owner": 2}


class FieldDef(BaseModel):
    key: str = ""
    label: str = ""
    type: str = "text"
    required: bool = False
    options: list[str] = []


class DesignRules(BaseModel):
    field: str
    rules: dict[str, int] = {}


class CreateEventRequest(BaseModel):
    name: str
    start_date: Optional[str] = None
    location: Optional[str] = None
    description: Optional[str] = None
    fields: Optional[list[FieldDef]] = None


class UpdateEventRequest(BaseModel):
    name: Optional[str] = None
    start_date: Optional[str] = None
    location: Optional[str] = None
    description: Optional[str] = None
    design_id: Optional[int] = None
    design_rules: Optional[DesignRules] = None
    fields: Optional[list[FieldDef]] = None
    registration_open: Optional[bool] = None


def _field_key(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (s or "").strip().lower()).strip("_")[:50]


def _clean_fields(fields: list[FieldDef]) -> list[dict]:
    out, seen = [], set()
    for f in fields[:30]:
        key = _field_key(f.key or f.label)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({
            "key": key,
            "label": (f.label or key).strip()[:80],
            "type": f.type if f.type in FIELD_TYPES else "text",
            "required": bool(f.required),
            "options": [o.strip()[:80] for o in f.options if o.strip()][:50],
        })
    if not out:
        raise HTTPException(400, "The form needs at least one field")
    return out


def _event_fields(e: Event) -> list[dict]:
    if e.fields_json:
        try:
            return json.loads(e.fields_json)
        except ValueError:
            pass
    return [dict(f) for f in DEFAULT_FIELDS]


def _clean_data(data: dict) -> dict:
    out = {}
    for k, v in list((data or {}).items())[:100]:
        k = str(k).strip()[:64]
        if not k or k.startswith("_"):
            continue
        out[k] = ("" if v is None else str(v)).strip()[:MAX_VALUE_LEN]
    return out


def _check_required(fields: list[dict], data: dict):
    missing = [f["label"] for f in fields if f.get("required") and not data.get(f["key"])]
    if missing:
        raise HTTPException(400, "Please fill in: " + ", ".join(missing))


def _new_public_code(session: Session) -> str:
    while True:
        code = secrets.token_urlsafe(6).replace("-", "").replace("_", "")[:8]
        if len(code) == 8 and not session.exec(select(Event).where(Event.public_code == code)).first():
            return code


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() + "Z" if dt else None


def _event_counts(session: Session, org_id: int, event_key: Optional[str] = None) -> dict[str, dict]:
    def count_if(cond):
        return func.sum(case((cond, 1), else_=0))

    q = (
        select(
            Attendee.event_id,
            func.count(Attendee.id),
            count_if(Attendee.printed == True),  # noqa: E712
            count_if(Attendee.checked_in == True),  # noqa: E712
            count_if(Attendee.source == "walk_in"),
            count_if(Attendee.source == "registration"),
            count_if(Attendee.cancelled == True),  # noqa: E712
        )
        .where(Attendee.org_id == org_id)
        .group_by(Attendee.event_id)
    )
    if event_key:
        q = q.where(Attendee.event_id == event_key)
    keys = ["total", "printed", "checked_in", "walk_in", "registered", "cancelled"]
    return {row[0]: dict(zip(keys, [v or 0 for v in row[1:]])) for row in session.exec(q).all()}


def _event_dict(e: Event, counts: Optional[dict] = None) -> dict:
    c = counts or {}
    return {
        "id": e.id,
        "event_id": e.eventbrite_id,
        "name": e.name,
        "source": e.source,
        "status": e.status,
        "design_id": e.design_id,
        "design_rules": json.loads(e.design_rules_json) if e.design_rules_json else None,
        "fields": _event_fields(e),
        "start_date": e.start_date,
        "location": e.location,
        "description": e.description,
        "capacity": e.capacity,
        "registration_open": e.registration_open,
        "public_code": e.public_code,
        "registration_url": f"{BASE_URL}/r/{e.public_code}" if e.public_code else None,
        "created_at": _iso(e.created_at),
        "synced_at": _iso(e.synced_at),
        "attendee_count": c.get("total", 0),
        "printed_count": c.get("printed", 0),
        "checked_in_count": c.get("checked_in", 0),
        "walk_in_count": c.get("walk_in", 0),
        "registered_count": c.get("registered", 0),
        "cancelled_count": c.get("cancelled", 0),
    }


def _attendee_dict(a: Attendee) -> dict:
    return {
        "id": a.id,
        "external_id": a.eventbrite_attendee_id,
        "data": json.loads(a.data),
        "source": a.source,
        "cancelled": a.cancelled,
        "printed": a.printed,
        "printed_at": _iso(a.printed_at),
        "printed_by": a.printed_by,
        "print_count": a.print_count or 0,
        "checked_in": a.checked_in,
        "checked_in_at": _iso(a.checked_in_at),
        "checked_in_by": a.checked_in_by,
        "created_at": _iso(a.created_at),
    }


def _get_event(session: Session, org_id: int, event_id: str) -> Event:
    e = session.exec(select(Event).where(Event.org_id == org_id, Event.eventbrite_id == event_id)).first()
    if not e:
        raise HTTPException(404, "Event not found")
    return e


def _get_attendee(session: Session, org_id: int, attendee_id: int) -> Attendee:
    a = session.get(Attendee, attendee_id)
    if not a or a.org_id != org_id:
        raise HTTPException(404, "Attendee not found")
    return a


def _check_design(session: Session, org_id: int, design_id: int):
    d = session.get(BadgeDesign, design_id)
    if not d or d.org_id != org_id:
        raise HTTPException(400, f"Design {design_id} not found")


async def _push_attendee(org_id: int, a: Attendee):
    await manager.broadcast(org_id, a.event_id, {"type": "attendee", "attendee": _attendee_dict(a)})


async def _push_reload(org_id: int, event_key: str):
    await manager.broadcast(org_id, event_key, {"type": "reload"})


def _create_event(session: Session, org_id: int, req: CreateEventRequest) -> Event:
    name = (req.name or "").strip()
    if not name:
        raise HTTPException(400, "Event name is required")
    event = Event(
        org_id=org_id,
        eventbrite_id=f"manual-{secrets.token_hex(8)}",
        name=name[:200],
        source="manual",
        status="custom",
        start_date=req.start_date or None,
        location=(req.location or "").strip()[:200] or None,
        description=(req.description or "").strip()[:2000] or None,
        fields_json=json.dumps(_clean_fields(req.fields)) if req.fields else None,
    )
    session.add(event)
    session.commit()
    session.refresh(event)
    return event


@app.get("/api/orgs/{org_id}/events")
def list_events(
    org_id: int,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    events = session.exec(
        select(Event).where(Event.org_id == org_id).order_by(Event.created_at.desc())
    ).all()
    counts = _event_counts(session, org_id)
    return [_event_dict(e, counts.get(e.eventbrite_id)) for e in events]


@app.post("/api/orgs/{org_id}/events")
@app.post("/api/orgs/{org_id}/events/manual")
def create_event(
    org_id: int,
    req: CreateEventRequest,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    return _event_dict(_create_event(session, org_id, req))


@app.get("/api/orgs/{org_id}/events/{event_id}")
def get_event(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    e = _get_event(session, org_id, event_id)
    return _event_dict(e, _event_counts(session, org_id, event_id).get(event_id))


@app.patch("/api/orgs/{org_id}/events/{event_id}")
async def update_event(
    org_id: int,
    event_id: str,
    req: UpdateEventRequest,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    event = _get_event(session, org_id, event_id)
    sent = req.model_fields_set

    if "name" in sent and req.name is not None:
        if not req.name.strip():
            raise HTTPException(400, "Event name is required")
        event.name = req.name.strip()[:200]
    if "start_date" in sent:
        event.start_date = req.start_date or None
    if "location" in sent:
        event.location = (req.location or "").strip()[:200] or None
    if "description" in sent:
        event.description = (req.description or "").strip()[:2000] or None
    if "design_id" in sent:
        # 0 / null unlinks the design
        if req.design_id:
            _check_design(session, org_id, req.design_id)
        event.design_id = req.design_id or None
    if "design_rules" in sent:
        if req.design_rules and req.design_rules.field and req.design_rules.rules:
            rules = {str(k)[:100]: v for k, v in req.design_rules.rules.items() if v}
            for design_id in set(rules.values()):
                _check_design(session, org_id, design_id)
            event.design_rules_json = json.dumps({"field": req.design_rules.field[:64], "rules": rules})
        else:
            event.design_rules_json = None
    if "fields" in sent:
        event.fields_json = json.dumps(_clean_fields(req.fields)) if req.fields else None
    if "registration_open" in sent and req.registration_open is not None:
        event.registration_open = req.registration_open
        if req.registration_open and not event.public_code:
            event.public_code = _new_public_code(session)

    session.add(event)
    session.commit()
    session.refresh(event)
    data = _event_dict(event, _event_counts(session, org_id, event_id).get(event_id))
    await manager.broadcast(org_id, event_id, {"type": "event", "event": data})
    return data


@app.post("/api/orgs/{org_id}/events/{event_id}/registration-link/reset")
def reset_registration_link(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    event = _get_event(session, org_id, event_id)
    event.public_code = _new_public_code(session)
    session.add(event)
    session.commit()
    session.refresh(event)
    return _event_dict(event, _event_counts(session, org_id, event_id).get(event_id))


@app.delete("/api/orgs/{org_id}/events/{event_id}")
async def delete_event(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    event = _get_event(session, org_id, event_id)
    for a in session.exec(select(Attendee).where(Attendee.org_id == org_id, Attendee.event_id == event_id)).all():
        session.delete(a)
    session.delete(event)
    session.commit()
    await manager.broadcast(org_id, event_id, {"type": "event_deleted"})
    return {"status": "ok"}


@app.delete("/api/orgs/{org_id}/events/{event_id}/attendees")
async def clear_attendees(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    _get_event(session, org_id, event_id)
    for a in session.exec(select(Attendee).where(Attendee.org_id == org_id, Attendee.event_id == event_id)).all():
        session.delete(a)
    session.commit()
    await _push_reload(org_id, event_id)
    return {"status": "ok"}


async def _set_all_printed(session: Session, org_id: int, event_id: str, user_id: int, printed: bool) -> dict:
    _get_event(session, org_id, event_id)
    attendees = session.exec(
        select(Attendee).where(Attendee.org_id == org_id, Attendee.event_id == event_id)
    ).all()
    now = datetime.utcnow()
    for a in attendees:
        a.printed = printed
        a.printed_at = now if printed else None
        a.printed_by = user_id if printed else None
        session.add(a)
    session.commit()
    await _push_reload(org_id, event_id)
    return {"updated": len(attendees)}


@app.post("/api/orgs/{org_id}/events/{event_id}/mark-all-printed")
async def mark_all_printed(
    org_id: int,
    event_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    return await _set_all_printed(session, org_id, event_id, current_user.id, True)


@app.post("/api/orgs/{org_id}/events/{event_id}/reset-printed")
async def reset_printed(
    org_id: int,
    event_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    return await _set_all_printed(session, org_id, event_id, current_user.id, False)


# ════════════════════════════════════════════════════════════════════════════
# ATTENDEES
# ════════════════════════════════════════════════════════════════════════════

class AddAttendeeRequest(BaseModel):
    data: dict[str, Any]
    source: str = "walk_in"        # walk_in (on the day) | manual (added beforehand)
    check_in: bool = False


class ImportAttendeesRequest(BaseModel):
    rows: list[dict[str, Any]]
    replace: bool = False


class UpdateAttendeeRequest(BaseModel):
    data: dict[str, Any]


class AttendeeStatusRequest(BaseModel):
    checked_in: Optional[bool] = None
    printed: Optional[bool] = None


class BulkStatusRequest(AttendeeStatusRequest):
    ids: list[int]


@app.get("/api/orgs/{org_id}/events/{event_id}/attendees")
def list_event_attendees(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    _get_event(session, org_id, event_id)
    attendees = session.exec(
        select(Attendee).where(Attendee.org_id == org_id, Attendee.event_id == event_id).order_by(Attendee.id)
    ).all()
    return [_attendee_dict(a) for a in attendees]


@app.get("/api/orgs/{org_id}/attendees")
def list_attendees(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    m: OrgMember = Depends(require_org_role("member")),
):
    return list_event_attendees(org_id, event_id, session, m)


@app.post("/api/orgs/{org_id}/events/{event_id}/attendees")
async def add_attendee(
    org_id: int,
    event_id: str,
    req: AddAttendeeRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    event = _get_event(session, org_id, event_id)
    data = _clean_data(req.data)
    if not any(data.values()):
        raise HTTPException(400, "Enter at least one detail for the attendee")
    _check_required(_event_fields(event), data)
    source = req.source if req.source in ("walk_in", "manual") else "walk_in"
    now = datetime.utcnow()
    a = Attendee(
        org_id=org_id,
        event_id=event_id,
        eventbrite_attendee_id=f"{source}-{secrets.token_hex(6)}",
        data=json.dumps(data),
        source=source,
        checked_in=req.check_in,
        checked_in_at=now if req.check_in else None,
        checked_in_by=current_user.id if req.check_in else None,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    await _push_attendee(org_id, a)
    return _attendee_dict(a)


@app.post("/api/orgs/{org_id}/events/{event_id}/attendees/import")
async def import_attendees(
    org_id: int,
    event_id: str,
    req: ImportAttendeesRequest,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    _get_event(session, org_id, event_id)
    if len(req.rows) > 20000:
        raise HTTPException(400, "Too many rows (max 20,000)")

    existing = session.exec(
        select(Attendee).where(Attendee.org_id == org_id, Attendee.event_id == event_id)
    ).all()
    if req.replace:
        for a in existing:
            session.delete(a)
        existing = []

    # Re-importing the same list updates people (matched by email) instead of duplicating them
    by_email = {}
    for a in existing:
        email = json.loads(a.data).get("email", "").lower()
        if email:
            by_email[email] = a

    added = updated = 0
    for raw in req.rows:
        data = _clean_data(raw)
        if not any(data.values()):
            continue
        match = by_email.get(data.get("email", "").lower()) if data.get("email") else None
        if match:
            match.data = json.dumps({**json.loads(match.data), **data})
            match.synced_at = datetime.utcnow()
            session.add(match)
            updated += 1
        else:
            a = Attendee(
                org_id=org_id,
                event_id=event_id,
                eventbrite_attendee_id=f"csv-{secrets.token_hex(6)}",
                data=json.dumps(data),
                source="csv",
            )
            session.add(a)
            if data.get("email"):
                by_email[data["email"].lower()] = a
            added += 1
    session.commit()
    await _push_reload(org_id, event_id)
    return {"added": added, "updated": updated}


@app.patch("/api/orgs/{org_id}/attendees/{attendee_id}")
async def update_attendee(
    org_id: int,
    attendee_id: int,
    req: UpdateAttendeeRequest,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    a = _get_attendee(session, org_id, attendee_id)
    data = _clean_data(req.data)
    if not any(data.values()):
        raise HTTPException(400, "Enter at least one detail for the attendee")
    a.data = json.dumps(data)
    session.add(a)
    session.commit()
    session.refresh(a)
    await _push_attendee(org_id, a)
    return _attendee_dict(a)


@app.delete("/api/orgs/{org_id}/attendees/{attendee_id}")
async def delete_attendee(
    org_id: int,
    attendee_id: int,
    session: Session = Depends(get_session),
    membership: OrgMember = Depends(require_org_role("member")),
):
    a = _get_attendee(session, org_id, attendee_id)
    # Reception staff can remove people added on the day (e.g. a duplicate walk-in);
    # imported/Eventbrite attendees need an admin.
    if a.source not in ("walk_in", "manual", "registration") and ROLE_RANK.get(membership.role, 0) < ROLE_RANK["admin"]:
        raise HTTPException(403, "Only admins can delete imported attendees")
    event_key = a.event_id
    session.delete(a)
    session.commit()
    await manager.broadcast(org_id, event_key, {"type": "attendee_deleted", "id": attendee_id})
    return {"ok": True}


@app.patch("/api/orgs/{org_id}/attendees/{attendee_id}/status")
async def set_attendee_status(
    org_id: int,
    attendee_id: int,
    req: AttendeeStatusRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    a = _get_attendee(session, org_id, attendee_id)
    _apply_status(a, req, current_user.id)
    session.add(a)
    session.commit()
    session.refresh(a)
    await _push_attendee(org_id, a)
    return _attendee_dict(a)


@app.post("/api/orgs/{org_id}/attendees/status")
async def set_attendees_status(
    org_id: int,
    req: BulkStatusRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    """Update several attendees at once (e.g. after printing a batch of badges)."""
    if len(req.ids) > 5000:
        raise HTTPException(400, "Too many attendees in one request")
    attendees = session.exec(
        select(Attendee).where(Attendee.org_id == org_id, Attendee.id.in_(req.ids))
    ).all()
    for a in attendees:
        _apply_status(a, req, current_user.id)
        session.add(a)
    session.commit()
    result = []
    for a in attendees:
        session.refresh(a)
        await _push_attendee(org_id, a)
        result.append(_attendee_dict(a))
    return result


def _apply_status(a: Attendee, req: AttendeeStatusRequest, user_id: int):
    now = datetime.utcnow()
    if req.checked_in is not None:
        if req.checked_in and not a.checked_in:
            a.checked_in_at = now
            a.checked_in_by = user_id
        elif not req.checked_in:
            a.checked_in_at = None
            a.checked_in_by = None
        a.checked_in = req.checked_in
    if req.printed is not None:
        if req.printed:
            a.printed_at = now
            a.printed_by = user_id
            a.print_count = (a.print_count or 0) + 1
        else:
            a.printed_at = None
            a.printed_by = None
        a.printed = req.printed


@app.patch("/api/orgs/{org_id}/attendees/{attendee_id}/printed")
async def mark_printed(
    org_id: int,
    attendee_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    m: OrgMember = Depends(require_org_role("member")),
):
    req = AttendeeStatusRequest(printed=bool(body.get("printed", True)))
    return await set_attendee_status(org_id, attendee_id, req, current_user, session, m)


@app.patch("/api/orgs/{org_id}/attendees/{attendee_id}/checked_in")
async def mark_checked_in(
    org_id: int,
    attendee_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    m: OrgMember = Depends(require_org_role("member")),
):
    req = AttendeeStatusRequest(checked_in=bool(body.get("checked_in", True)))
    return await set_attendee_status(org_id, attendee_id, req, current_user, session, m)


@app.get("/api/orgs/{org_id}/events/{event_id}/attendees.csv")
def export_attendees_csv(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    event = _get_event(session, org_id, event_id)
    attendees = session.exec(
        select(Attendee).where(Attendee.org_id == org_id, Attendee.event_id == event_id).order_by(Attendee.id)
    ).all()
    names = {u.id: u.name for u in session.exec(
        select(User).join(OrgMember, OrgMember.user_id == User.id).where(OrgMember.org_id == org_id)
    ).all()}

    rows = [json.loads(a.data) for a in attendees]
    columns = [f["key"] for f in _event_fields(event)]
    for key in CORE_FIELDS + [k for r in rows for k in r]:
        if key not in columns and any(r.get(key) for r in rows):
            columns.append(key)
    status_cols = ["source", "cancelled", "checked_in", "checked_in_at", "checked_in_by", "printed", "print_count"]

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(columns + status_cols)
    for a, r in zip(attendees, rows):
        writer.writerow([r.get(c, "") for c in columns] + [
            a.source, "yes" if a.cancelled else "", "yes" if a.checked_in else "no",
            a.checked_in_at.strftime("%Y-%m-%d %H:%M:%S") if a.checked_in_at else "",
            names.get(a.checked_in_by, ""), "yes" if a.printed else "no", a.print_count or 0,
        ])
    filename = f"attendees_{_slugify(event.name) or 'event'}.csv"
    return StreamingResponse(
        iter(["﻿" + buf.getvalue()]),  # BOM so Excel opens UTF-8 correctly
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ════════════════════════════════════════════════════════════════════════════
# EVENTBRITE
# ════════════════════════════════════════════════════════════════════════════

class EventbriteImportRequest(BaseModel):
    eventbrite_event_id: str


async def _sync_eventbrite(session: Session, org: Organisation, event: Event) -> dict:
    async with EventbriteClient(org.eventbrite_token) as eb:
        info = event_summary(await eb.get_event(event.eventbrite_id))
        eb_attendees = await eb.list_attendees(event.eventbrite_id)

    now = datetime.utcnow()
    event.name, event.start_date = info["name"], info["start"]
    event.capacity, event.status = info["capacity"], info["status"]
    event.synced_at = now
    session.add(event)

    existing = session.exec(
        select(Attendee).where(Attendee.org_id == org.id, Attendee.event_id == event.eventbrite_id)
    ).all()
    by_ext = {a.eventbrite_attendee_id: a for a in existing}
    added = updated = cancelled = 0
    for att in eb_attendees:
        ext = str(att["id"])
        row = flatten_attendee(att)
        is_canc = is_cancelled(att)
        a = by_ext.get(ext)
        if a is None:
            # Older versions keyed Eventbrite attendees by order id — adopt those rows
            legacy = by_ext.get(row["order_id"])
            if legacy and json.loads(legacy.data).get("email", "") == row["email"]:
                del by_ext[row["order_id"]]
                legacy.eventbrite_attendee_id = ext
                a = by_ext[ext] = legacy
        if a is None:
            a = Attendee(
                org_id=org.id, event_id=event.eventbrite_id, eventbrite_attendee_id=ext,
                data=json.dumps(row), source="eventbrite", cancelled=is_canc,
            )
            by_ext[ext] = a
            added += 1
        else:
            a.data = json.dumps({**json.loads(a.data), **row})
            a.cancelled = is_canc
            a.synced_at = now
            updated += 1
        cancelled += is_canc
        session.add(a)
    session.commit()
    session.refresh(event)
    await _push_reload(org.id, event.eventbrite_id)
    return {"total": len(eb_attendees), "added": added, "updated": updated, "cancelled": cancelled}


@app.get("/api/orgs/{org_id}/eventbrite/events")
async def eventbrite_events(
    org_id: int,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    org = session.get(Organisation, org_id)
    async with EventbriteClient(org.eventbrite_token) as eb:
        events = [event_summary(e) for e in await eb.list_events()]
    imported = {
        e.eventbrite_id for e in session.exec(
            select(Event).where(Event.org_id == org_id, Event.source == "eventbrite")
        ).all()
    }
    for e in events:
        e["imported"] = e["id"] in imported
    return events


@app.post("/api/orgs/{org_id}/eventbrite/import")
async def eventbrite_import(
    org_id: int,
    req: EventbriteImportRequest,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    org = session.get(Organisation, org_id)
    eb_id = req.eventbrite_event_id.strip()
    if not eb_id.isdigit():
        raise HTTPException(400, "Invalid Eventbrite event id")
    event = session.exec(select(Event).where(Event.org_id == org_id, Event.eventbrite_id == eb_id)).first()
    if not event:
        event = Event(org_id=org_id, eventbrite_id=eb_id, name=f"Event {eb_id}", source="eventbrite")
    result = await _sync_eventbrite(session, org, event)
    return {"event": _event_dict(event, _event_counts(session, org_id, eb_id).get(eb_id)), "sync": result}


@app.post("/api/orgs/{org_id}/events/{event_id}/sync")
async def eventbrite_sync(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    event = _get_event(session, org_id, event_id)
    if event.source != "eventbrite":
        raise HTTPException(400, "This event is not linked to Eventbrite")
    result = await _sync_eventbrite(session, session.get(Organisation, org_id), event)
    return {"event": _event_dict(event, _event_counts(session, org_id, event_id).get(event_id)), "sync": result}


# ════════════════════════════════════════════════════════════════════════════
# PUBLIC REGISTRATION (no login — online sign-up and self-service kiosk)
# ════════════════════════════════════════════════════════════════════════════

class PublicRegisterRequest(BaseModel):
    data: dict[str, Any]
    kiosk: bool = False        # signed up on the reception kiosk, so they're here now
    website: str = ""          # honeypot: hidden field that only bots fill in


_register_hits: dict[str, deque] = defaultdict(deque)


def _rate_limit(request: Request, limit: int = 20, window: int = 300):
    ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "?")
    hits, now = _register_hits[ip], time.monotonic()
    while hits and now - hits[0] > window:
        hits.popleft()
    if len(hits) >= limit:
        raise HTTPException(429, "Too many registrations from this device — please ask at reception")
    hits.append(now)


def _public_event(session: Session, code: str) -> Event:
    event = session.exec(select(Event).where(Event.public_code == code)).first()
    if not event or not event.registration_open:
        raise HTTPException(404, "Registration for this event is closed")
    return event


@app.get("/api/public/events/{code}")
def public_event(code: str, session: Session = Depends(get_session)):
    event = _public_event(session, code)
    org = session.get(Organisation, event.org_id)
    return {
        "name": event.name,
        "org_name": org.name if org else "",
        "start_date": event.start_date,
        "location": event.location,
        "description": event.description,
        "fields": _event_fields(event),
    }


@app.post("/api/public/events/{code}/register")
async def public_register(
    code: str,
    req: PublicRegisterRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    event = _public_event(session, code)
    if req.website:
        return {"ok": True}  # silently drop bot submissions
    _rate_limit(request)

    fields = _event_fields(event)
    allowed = {f["key"]: f for f in fields}
    data = {k: v for k, v in _clean_data(req.data).items() if k in allowed}
    _check_required(fields, data)
    for key, f in allowed.items():
        if f["type"] == "select" and data.get(key) and f["options"] and data[key] not in f["options"]:
            raise HTTPException(400, f"Please choose a valid option for {f['label']}")
        if f["type"] == "email" and data.get(key) and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", data[key]):
            raise HTTPException(400, f"Please enter a valid {f['label'].lower()}")
    if not any(data.values()):
        raise HTTPException(400, "Please fill in your details")

    email = data.get("email", "").lower()
    if email:
        for a in session.exec(select(Attendee).where(Attendee.org_id == event.org_id, Attendee.event_id == event.eventbrite_id)).all():
            if json.loads(a.data).get("email", "").lower() == email:
                raise HTTPException(409, "You're already registered for this event — please see reception")

    a = Attendee(
        org_id=event.org_id,
        event_id=event.eventbrite_id,
        eventbrite_attendee_id=f"registration-{secrets.token_hex(6)}",
        data=json.dumps(data),
        source="registration",
        checked_in=req.kiosk,
        checked_in_at=datetime.utcnow() if req.kiosk else None,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    await manager.broadcast(event.org_id, a.event_id, {
        "type": "attendee", "attendee": _attendee_dict(a), "kiosk": req.kiosk,
    })
    return {"ok": True}


# ════════════════════════════════════════════════════════════════════════════
# WEBSOCKET
# ════════════════════════════════════════════════════════════════════════════

@app.websocket("/ws/{org_id}/{event_id}")
async def websocket_endpoint(websocket: WebSocket, org_id: int, event_id: str, token: str = Query(...)):
    try:
        payload = decode_token(token)
        with Session(engine) as session:
            membership = session.exec(
                select(OrgMember).where(OrgMember.org_id == org_id, OrgMember.user_id == int(payload["sub"]))
            ).first()
    except Exception:
        membership = None
    if not membership:
        await websocket.close(code=4003)
        return

    await manager.connect(websocket, org_id, event_id)
    await manager.broadcast(org_id, event_id, {
        "type": "presence",
        "users_online": manager.room_size(org_id, event_id),
    })
    try:
        while True:
            await websocket.receive_text()  # client pings keep the connection alive
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket, org_id, event_id)
        await manager.broadcast(org_id, event_id, {
            "type": "presence",
            "users_online": manager.room_size(org_id, event_id),
        })

# ════════════════════════════════════════════════════════════════════════════
# BADGE DESIGNS
# ════════════════════════════════════════════════════════════════════════════

class SaveDesignRequest(BaseModel):
    name: str
    design_json: str


@app.get("/api/orgs/{org_id}/designs")
def list_designs(
    org_id: int,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    designs = session.exec(
        select(BadgeDesign).where(BadgeDesign.org_id == org_id)
    ).all()
    return [{"id": d.id, "name": d.name, "updated_at": d.updated_at.isoformat()} for d in designs]


@app.post("/api/orgs/{org_id}/designs")
def save_design(
    org_id: int,
    req: SaveDesignRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    design = BadgeDesign(
        org_id=org_id,
        name=req.name,
        design_json=req.design_json,
        created_by=current_user.id,
    )
    session.add(design)
    session.commit()
    session.refresh(design)
    return {"id": design.id, "name": design.name}


@app.get("/api/orgs/{org_id}/designs/{design_id}")
def get_design(
    org_id: int,
    design_id: int,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    d = session.get(BadgeDesign, design_id)
    if not d or d.org_id != org_id:
        raise HTTPException(404)
    return {"id": d.id, "name": d.name, "design_json": d.design_json}


@app.delete("/api/orgs/{org_id}/designs/{design_id}")
def delete_design(
    org_id: int,
    design_id: int,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    d = session.get(BadgeDesign, design_id)
    if not d or d.org_id != org_id:
        raise HTTPException(404)
    session.delete(d)
    session.commit()
    return {"ok": True}


class UpdateDesignRequest(BaseModel):
    name: Optional[str] = None
    design_json: Optional[str] = None


@app.patch("/api/orgs/{org_id}/designs/{design_id}")
def update_design(
    org_id: int,
    design_id: int,
    req: UpdateDesignRequest,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    design = session.get(BadgeDesign, design_id)
    if not design or design.org_id != org_id:
        raise HTTPException(404, "Design not found")
    if req.name is not None:
        design.name = req.name
    if req.design_json is not None:
        design.design_json = req.design_json
    design.updated_at = datetime.utcnow()
    session.add(design)
    session.commit()
    session.refresh(design)
    return {"id": design.id, "name": design.name}


# ════════════════════════════════════════════════════════════════════════════
# HELPERS
# ════════════════════════════════════════════════════════════════════════════

def _user_dict(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "avatar": user.avatar_url,
    }


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


# ════════════════════════════════════════════════════════════════════════════
# SERVER-SIDE PDF GENERATION
# (the web app renders badges in the browser; these remain for API use)
# ════════════════════════════════════════════════════════════════════════════

def _pdf_response(design_json: str, records: list[dict], filename: str, disposition: str = "attachment"):
    try:
        output = io.BytesIO()
        generate_bulk_pdf(design_json, records, output)
        output.seek(0)
    except Exception as e:
        print(f"PDF generation error: {traceback.format_exc()}")
        raise HTTPException(500, detail=f"PDF Generation Failed: {e}")
    return StreamingResponse(
        output,
        media_type="application/pdf",
        headers={"Content-Disposition": f"{disposition}; filename={filename}"},
    )


@app.get("/api/orgs/{org_id}/events/{event_id}/pdf")
def get_event_pdf(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    event = _get_event(session, org_id, event_id)
    if not event.design_id:
        raise HTTPException(400, "No design linked to this event")
    design = session.get(BadgeDesign, event.design_id)
    if not design:
        raise HTTPException(404, "Design not found")
    attendees = session.exec(
        select(Attendee).where(Attendee.org_id == org_id, Attendee.event_id == event_id)
    ).all()
    if not attendees:
        raise HTTPException(400, "No attendees found for this event")
    return _pdf_response(design.design_json, [json.loads(a.data) for a in attendees],
                         f"badges_{_slugify(event.name)}.pdf")


@app.get("/api/orgs/{org_id}/attendees/{attendee_id}/pdf")
def get_attendee_pdf(
    org_id: int,
    attendee_id: int,
    design_id: Optional[int] = None,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    att = _get_attendee(session, org_id, attendee_id)
    target_design_id = design_id
    if not target_design_id:
        event = session.exec(
            select(Event).where(Event.org_id == org_id, Event.eventbrite_id == att.event_id)
        ).first()
        target_design_id = event.design_id if event else None
    design = session.get(BadgeDesign, target_design_id) if target_design_id else None
    if not design or design.org_id != org_id:
        raise HTTPException(400, "No design linked to this attendee's event")
    return _pdf_response(design.design_json, [json.loads(att.data)], "badge.pdf", "inline")
