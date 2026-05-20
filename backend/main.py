import json
import io
import os
import re
import secrets
import traceback
from datetime import datetime, timedelta
from typing import Optional

import httpx
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, EmailStr
from sqlmodel import Session, select, text

from auth import (
    create_access_token, decode_token, get_current_user,
    google_auth_url, google_exchange_code,
    hash_password, verify_password, require_org_role,
)
from email_utils import send_invite_email
from models import (
    Attendee, BadgeDesign, Event, Invite, OrgMember,
    Organisation, User, create_db, get_session, engine,
)
from ws_manager import manager
from pdf_utils import generate_bulk_pdf, render_badge_to_pdf

BASE_URL = os.getenv("BASE_URL", "https://badgecraft.example.com")
EB_API = "https://www.eventbriteapi.com/v3"

app = FastAPI(title="BadgeCraft API", docs_url="/api/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[BASE_URL, "http://localhost"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    create_db()
    try:
        with Session(engine) as session:
            session.exec(text("ALTER TABLE event ADD COLUMN design_id INTEGER"))
            session.commit()
    except Exception as e:
        # Expected if column already exists
        pass



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
# EVENTBRITE PROXY (uses org's stored token)
# ════════════════════════════════════════════════════════════════════════════

@app.api_route("/api/orgs/{org_id}/eb/{path:path}", methods=["GET"])
async def eventbrite_proxy(
    org_id: int,
    path: str,
    request_params: str = Query(default=""),
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    org = session.get(Organisation, org_id)
    if not org or not org.eventbrite_token:
        raise HTTPException(400, "No Eventbrite token configured for this organisation")

    url = f"{EB_API}/{path}"
    async with httpx.AsyncClient() as client:
        res = await client.get(
            url,
            headers={"Authorization": f"Bearer {org.eventbrite_token}"},
            params={"expand": "attendees"} if "attendees" in path else {},
            timeout=30,
        )
    return JSONResponse(content=res.json(), status_code=res.status_code)


# ════════════════════════════════════════════════════════════════════════════
# ATTENDEE ROUTES
# ════════════════════════════════════════════════════════════════════════════

class SyncAttendeesRequest(BaseModel):
    event_id: str
    event_name: Optional[str] = None
    attendees: list[dict]  # raw attendee objects from Eventbrite or custom CSV


@app.post("/api/orgs/{org_id}/attendees/sync")
def sync_attendees(
    org_id: int,
    req: SyncAttendeesRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    # Ensure Event exists
    event = session.exec(
        select(Event).where(
            Event.org_id == org_id,
            Event.eventbrite_id == req.event_id,
        )
    ).first()
    if not event:
        event = Event(
            org_id=org_id,
            eventbrite_id=req.event_id,
            name=req.event_name or f"Event {req.event_id}",
            status="active",
        )
        session.add(event)
    elif req.event_name:
        event.name = req.event_name
        session.add(event)

    imported = 0
    for att in req.attendees:
        eb_id = att.get("id") or att.get("eventbrite_attendee_id", "")
        if not eb_id:
            continue
        existing = session.exec(
            select(Attendee).where(
                Attendee.org_id == org_id,
                Attendee.event_id == req.event_id,
                Attendee.eventbrite_attendee_id == str(eb_id),
            )
        ).first()
        if existing:
            existing.data = json.dumps(att)
            existing.synced_at = datetime.utcnow()
            session.add(existing)
        else:
            session.add(Attendee(
                org_id=org_id,
                event_id=req.event_id,
                eventbrite_attendee_id=str(eb_id),
                data=json.dumps(att),
            ))
            imported += 1
    session.commit()
    return {"synced": len(req.attendees), "new": imported}



@app.get("/api/orgs/{org_id}/attendees")
def list_attendees(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    attendees = session.exec(
        select(Attendee).where(
            Attendee.org_id == org_id,
            Attendee.event_id == event_id,
        )
    ).all()
    return [_attendee_dict(a) for a in attendees]


@app.patch("/api/orgs/{org_id}/attendees/{attendee_id}/printed")
async def mark_printed(
    org_id: int,
    attendee_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    att = session.get(Attendee, attendee_id)
    if not att or att.org_id != org_id:
        raise HTTPException(404)
    att.printed = body.get("printed", True)
    att.printed_at = datetime.utcnow() if att.printed else None
    att.printed_by = current_user.id if att.printed else None
    session.add(att)
    session.commit()

    # Broadcast to all connected clients in this event room
    await manager.broadcast(org_id, att.event_id, {
        "type": "printed",
        "attendee_id": attendee_id,
        "printed": att.printed,
        "printed_by": current_user.name,
        "printed_at": att.printed_at.isoformat() if att.printed_at else None,
    })
    return _attendee_dict(att)


@app.patch("/api/orgs/{org_id}/attendees/{attendee_id}/checked_in")
async def mark_checked_in(
    org_id: int,
    attendee_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    att = session.get(Attendee, attendee_id)
    if not att or att.org_id != org_id:
        raise HTTPException(404)
    att.checked_in = body.get("checked_in", True)
    att.checked_in_at = datetime.utcnow() if att.checked_in else None
    att.checked_in_by = current_user.id if att.checked_in else None
    session.add(att)
    session.commit()

    await manager.broadcast(org_id, att.event_id, {
        "type": "checked_in",
        "attendee_id": attendee_id,
        "checked_in": att.checked_in,
        "checked_in_by": current_user.name,
        "checked_in_at": att.checked_in_at.isoformat() if att.checked_in_at else None,
    })
    return _attendee_dict(att)


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


@app.get("/api/orgs/{org_id}/events")
def list_events(
    org_id: int,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    events = session.exec(
        select(Event).where(Event.org_id == org_id)
    ).all()
    return [
        {
            "id": e.id,
            "event_id": e.eventbrite_id,
            "name": e.name,
            "status": e.status,
            "design_id": e.design_id,
            "start_date": e.start_date,
            "capacity": e.capacity,
        } for e in events
    ]


class CreateEventRequest(BaseModel):
    name: str
    event_id: Optional[str] = None


@app.post("/api/orgs/{org_id}/events")
def create_event(
    org_id: int,
    req: CreateEventRequest,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    event_id = req.event_id or f"custom-{secrets.token_hex(8)}"
    existing = session.exec(
        select(Event).where(Event.org_id == org_id, Event.eventbrite_id == event_id)
    ).first()
    if existing:
        raise HTTPException(400, "Event ID already exists")

    event = Event(
        org_id=org_id,
        eventbrite_id=event_id,
        name=req.name,
        status="custom",
    )
    session.add(event)
    session.commit()
    session.refresh(event)
    return {
        "id": event.id,
        "event_id": event.eventbrite_id,
        "name": event.name,
        "status": event.status,
        "design_id": event.design_id,
    }


class UpdateEventRequest(BaseModel):
    name: Optional[str] = None
    design_id: Optional[int] = None


@app.patch("/api/orgs/{org_id}/events/{event_id}")
def update_event(
    org_id: int,
    event_id: str,
    req: UpdateEventRequest,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    event = session.exec(
        select(Event).where(Event.org_id == org_id, Event.eventbrite_id == event_id)
    ).first()
    if not event:
        raise HTTPException(404, "Event not found")
    if req.name is not None:
        event.name = req.name
    if req.design_id is not None:
        # Set to None if 0
        event.design_id = req.design_id if req.design_id else None
    session.add(event)
    session.commit()
    session.refresh(event)
    return {
        "id": event.id,
        "event_id": event.eventbrite_id,
        "name": event.name,
        "status": event.status,
        "design_id": event.design_id,
    }


# ════════════════════════════════════════════════════════════════════════════
# WEBSOCKET
# ════════════════════════════════════════════════════════════════════════════

@app.websocket("/ws/{org_id}/{event_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    org_id: int,
    event_id: str,
    token: str = Query(...),
    session: Session = Depends(get_session),
):
    # Authenticate via token query param
    try:
        payload = decode_token(token)
        user = session.get(User, int(payload["sub"]))
        if not user:
            await websocket.close(code=4001)
            return
        membership = session.exec(
            select(OrgMember).where(
                OrgMember.org_id == org_id,
                OrgMember.user_id == user.id,
            )
        ).first()
        if not membership:
            await websocket.close(code=4003)
            return
    except Exception:
        await websocket.close(code=4001)
        return

    await manager.connect(websocket, org_id, event_id)
    await manager.broadcast(org_id, event_id, {
        "type": "presence",
        "users_online": manager.room_size(org_id, event_id),
    })

    try:
        while True:
            await websocket.receive_text()  # keep alive / ping
    except WebSocketDisconnect:
        manager.disconnect(websocket, org_id, event_id)
        await manager.broadcast(org_id, event_id, {
            "type": "presence",
            "users_online": manager.room_size(org_id, event_id),
        })


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


def _attendee_dict(a: Attendee) -> dict:
    return {
        "id": a.id,
        "eventbrite_attendee_id": a.eventbrite_attendee_id,
        "data": json.loads(a.data),
        "printed": a.printed,
        "printed_at": a.printed_at.isoformat() if a.printed_at else None,
        "printed_by": a.printed_by,
        "checked_in": a.checked_in,
        "checked_in_at": a.checked_in_at.isoformat() if a.checked_in_at else None,
        "checked_in_by": a.checked_in_by,
    }


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


@app.delete("/api/orgs/{org_id}/events/{event_id}")
def delete_event(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    event = session.exec(
        select(Event).where(Event.org_id == org_id, Event.eventbrite_id == event_id)
    ).first()
    if event:
        session.delete(event)
    
    # Also delete attendees for this event
    attendees = session.exec(
        select(Attendee).where(Attendee.org_id == org_id, Attendee.event_id == event_id)
    ).all()
    for a in attendees:
        session.delete(a)
        
    session.commit()
    return {"status": "ok"}


@app.delete("/api/orgs/{org_id}/events/{event_id}/attendees")
def clear_attendees(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("admin")),
):
    attendees = session.exec(
        select(Attendee).where(Attendee.org_id == org_id, Attendee.event_id == event_id)
    ).all()
    for a in attendees:
        session.delete(a)
    session.commit()
    return {"status": "ok"}


# ════════════════════════════════════════════════════════════════════════════
# PDF GENERATION
# ════════════════════════════════════════════════════════════════════════════

@app.get("/api/orgs/{org_id}/events/{event_id}/pdf")
def get_event_pdf(
    org_id: int,
    event_id: str,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    try:
        event = session.exec(
            select(Event).where(Event.org_id == org_id, Event.eventbrite_id == event_id)
        ).first()
        if not event:
            raise HTTPException(404, "Event not found")
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

        output = io.BytesIO()
        attendees_data = [json.loads(a.data) for a in attendees]
        
        generate_bulk_pdf(design.design_json, attendees_data, output)
        output.seek(0)
        
        filename = f"badges_{_slugify(event.name)}.pdf"
        return StreamingResponse(
            output,
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"PDF Endpoint Error: {traceback.format_exc()}")
        raise HTTPException(500, detail=f"PDF Generation Failed: {str(e)}")


@app.get("/api/orgs/{org_id}/attendees/{attendee_id}/pdf")
def get_attendee_pdf(
    org_id: int,
    attendee_id: int,
    design_id: Optional[int] = None,
    session: Session = Depends(get_session),
    _: OrgMember = Depends(require_org_role("member")),
):
    try:
        att = session.get(Attendee, attendee_id)
        if not att or att.org_id != org_id:
            raise HTTPException(404, "Attendee not found")

        # If design_id provided, use it, otherwise use event's design
        target_design_id = design_id
        if not target_design_id:
            event = session.exec(
                select(Event).where(Event.org_id == org_id, Event.eventbrite_id == att.event_id)
            ).first()
            if event:
                target_design_id = event.design_id

        if not target_design_id:
            # Fallback: check if there's only one design in the org
            fallback_design = session.exec(
                select(BadgeDesign).where(BadgeDesign.org_id == org_id)
            ).first()
            if fallback_design:
                target_design_id = fallback_design.id

        if not target_design_id:
            raise HTTPException(400, "No design linked to this attendee's event and no default design found")

        design = session.get(BadgeDesign, target_design_id)
        if not design:
            raise HTTPException(404, "Design not found")

        output = io.BytesIO()
        state = json.loads(design.design_json)
        
        # Create a single-badge PDF
        badge_w = state.get('badgeW', 85)
        badge_h = state.get('badgeH', 55)
        
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import mm
        
        c = canvas.Canvas(output, pagesize=(badge_w * mm, badge_h * mm))
        
        # Determine elements
        elements = state.get('elements', [])
        if not elements and 'designs' in state:
            elements = state['designs'].get('front', [])

        render_badge_to_pdf(
            c, json.loads(att.data), 0, 0, 
            elements, 
            badge_w, badge_h, state.get('badgeBg', '#ffffff')
        )
        c.save()
        output.seek(0)
        
        return StreamingResponse(
            output,
            media_type="application/pdf",
            headers={"Content-Disposition": "inline; filename=badge.pdf"}
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"Attendee PDF Endpoint Error: {traceback.format_exc()}")
        raise HTTPException(500, detail=f"PDF Generation Failed: {str(e)}")
