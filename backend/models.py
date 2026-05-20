from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel, create_engine, Session, select
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:////data/badgecraft.db")
engine = create_engine(DATABASE_URL, echo=False, connect_args={"check_same_thread": False})


# ── Users ────────────────────────────────────────────────────────────────────

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    email: str = Field(unique=True, index=True)
    name: str
    hashed_password: Optional[str] = None          # None for OAuth-only users
    google_id: Optional[str] = Field(default=None, unique=True, index=True)
    avatar_url: Optional[str] = None
    is_verified: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ── Organisations ─────────────────────────────────────────────────────────────

class Organisation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    slug: str = Field(unique=True, index=True)
    eventbrite_token: Optional[str] = None         # encrypted at rest
    created_at: datetime = Field(default_factory=datetime.utcnow)


class OrgMember(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(foreign_key="organisation.id", index=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    role: str = Field(default="member")            # owner | admin | member
    joined_at: datetime = Field(default_factory=datetime.utcnow)


# ── Invites ───────────────────────────────────────────────────────────────────

class Invite(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(foreign_key="organisation.id", index=True)
    created_by: int = Field(foreign_key="user.id")
    code: str = Field(unique=True, index=True)
    email: Optional[str] = None                    # set for email invites
    role: str = Field(default="member")
    used: bool = False
    used_by: Optional[int] = None
    expires_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ── Events (cached from Eventbrite) ──────────────────────────────────────────

class Event(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(foreign_key="organisation.id", index=True)
    eventbrite_id: str = Field(index=True)
    name: str
    start_date: Optional[str] = None
    capacity: Optional[int] = None
    status: Optional[str] = None
    synced_at: datetime = Field(default_factory=datetime.utcnow)


# ── Attendees ─────────────────────────────────────────────────────────────────

class Attendee(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(foreign_key="organisation.id", index=True)
    event_id: str = Field(index=True)              # eventbrite event id
    eventbrite_attendee_id: str = Field(index=True)
    data: str                                       # JSON blob of all fields
    printed: bool = False
    printed_at: Optional[datetime] = None
    printed_by: Optional[int] = Field(default=None, foreign_key="user.id")
    checked_in: bool = False
    checked_in_at: Optional[datetime] = None
    checked_in_by: Optional[int] = Field(default=None, foreign_key="user.id")
    synced_at: datetime = Field(default_factory=datetime.utcnow)


# ── Badge Designs ─────────────────────────────────────────────────────────────

class BadgeDesign(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(foreign_key="organisation.id", index=True)
    name: str
    design_json: str                               # full badge designer state
    created_by: int = Field(foreign_key="user.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


def create_db():
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session
