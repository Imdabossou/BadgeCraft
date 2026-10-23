from datetime import datetime
from typing import Optional
from sqlalchemy import inspect
from sqlmodel import Field, SQLModel, create_engine, Session, text
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
    eventbrite_token: Optional[str] = None
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


# ── Events ────────────────────────────────────────────────────────────────────

class Event(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(foreign_key="organisation.id", index=True)
    # Public event key used in URLs. For Eventbrite events this is the
    # Eventbrite event id; for self-hosted events it is "manual-<hex>".
    eventbrite_id: str = Field(index=True)
    name: str
    source: str = Field(default="manual")          # manual | eventbrite
    design_id: Optional[int] = Field(default=None, foreign_key="badgedesign.id", nullable=True)
    design_rules_json: Optional[str] = None        # {"field": "...", "rules": {"value": design_id}}
    fields_json: Optional[str] = None              # walk-in / registration form definition
    start_date: Optional[str] = None
    location: Optional[str] = None
    description: Optional[str] = None
    capacity: Optional[int] = None
    status: Optional[str] = None
    registration_open: bool = False
    public_code: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    synced_at: datetime = Field(default_factory=datetime.utcnow)


# ── Attendees ─────────────────────────────────────────────────────────────────

class Attendee(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(foreign_key="organisation.id", index=True)
    event_id: str = Field(index=True)              # Event.eventbrite_id
    eventbrite_attendee_id: str = Field(index=True)  # external id (Eventbrite attendee id or generated)
    data: str                                       # JSON blob of all fields
    source: str = Field(default="import")          # eventbrite | csv | manual | walk_in | registration | import
    cancelled: bool = False                         # cancelled/refunded on Eventbrite
    printed: bool = False
    printed_at: Optional[datetime] = None
    printed_by: Optional[int] = Field(default=None, foreign_key="user.id")
    print_count: int = 0
    checked_in: bool = False
    checked_in_at: Optional[datetime] = None
    checked_in_by: Optional[int] = Field(default=None, foreign_key="user.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
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


def _migrate():
    """Add any model columns missing from an existing database (SQLite has no
    automatic schema migration). Returns the set of "table.column" names added."""
    insp = inspect(engine)
    added = set()
    with engine.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col.type.compile(engine.dialect)}'
                if col.default is not None and col.default.is_scalar:
                    value = col.default.arg
                    ddl += f" DEFAULT {int(value) if isinstance(value, bool) else repr(value)}"
                conn.execute(text(ddl))
                added.add(f"{table.name}.{col.name}")

        if "event.source" in added:
            # Events created before `source` existed: anything that wasn't made
            # in-app (status "custom" / generated ids) came from Eventbrite.
            conn.execute(text(
                "UPDATE event SET source = 'eventbrite' WHERE COALESCE(status, '') != 'custom' "
                "AND eventbrite_id NOT LIKE 'manual-%' AND eventbrite_id NOT LIKE 'custom-%' "
                "AND eventbrite_id NOT LIKE 'csv-%'"
            ))
    return added


def create_db():
    SQLModel.metadata.create_all(engine)
    _migrate()


def get_session():
    with Session(engine) as session:
        yield session
