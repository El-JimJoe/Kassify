import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

DATA_DIR = os.environ.get("KASSIFY_DATA", "/data")
DB_PATH = os.path.join(DATA_DIR, "kassify.db")

lock = threading.RLock()
CONN = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS accesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cashbox_id INTEGER,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    access_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    success INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS cashboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    drink_price_cents INTEGER NOT NULL,
    account_name TEXT NOT NULL DEFAULT '',
    account_url TEXT NOT NULL DEFAULT '',
    opening_balance_cents INTEGER NOT NULL,
    opening_date TEXT NOT NULL,
    opening_source TEXT NOT NULL DEFAULT '',
    fee_free INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cashbox_id INTEGER NOT NULL,
    booked_on TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    source TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cashbox_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cashbox_id INTEGER NOT NULL,
    member_id INTEGER,
    kind TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    money_cents INTEGER NOT NULL,
    booked_on TEXT NOT NULL,
    ref_type TEXT,
    ref_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drink_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cashbox_id INTEGER NOT NULL,
    booked_on TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    price_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drink_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drink_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    revision_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cashbox_id INTEGER NOT NULL,
    booked_on TEXT NOT NULL,
    vendor TEXT NOT NULL,
    description TEXT NOT NULL,
    receipt_cents INTEGER NOT NULL,
    pfand_cents INTEGER NOT NULL DEFAULT 0,
    pfand_given INTEGER NOT NULL DEFAULT 0,
    advanced_by TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reimbursements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    booked_on TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cashbox_id INTEGER,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    action TEXT NOT NULL,
    role TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
"""


def now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def migrate(conn):
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(drink_events)")}
    if "price_cents" not in columns:
        conn.execute("ALTER TABLE drink_events ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0")
    conn.execute(
        """
        UPDATE drink_events
        SET price_cents = (SELECT drink_price_cents FROM cashboxes WHERE cashboxes.id = drink_events.cashbox_id)
        WHERE price_cents = 0
        """
    )


def connect():
    global CONN
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    migrate(conn)
    conn.commit()
    CONN = conn
    return conn


def db():
    if CONN is None:
        return connect()
    return CONN


def rows(query, params=()):
    return [dict(r) for r in db().execute(query, params).fetchall()]


def one(query, params=()):
    r = db().execute(query, params).fetchone()
    return dict(r) if r else None


def execute(query, params=()):
    cur = db().execute(query, params)
    db().commit()
    return cur.lastrowid


def dump(value):
    return json.dumps(value, ensure_ascii=False, default=str)


def audit(cashbox_id, object_type, object_id, action, role, before=None, after=None, note=""):
    execute(
        """
        INSERT INTO audit(cashbox_id, object_type, object_id, action, role, before_json, after_json, note, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            cashbox_id,
            object_type,
            str(object_id),
            action,
            role,
            dump(before) if before is not None else None,
            dump(after) if after is not None else None,
            note,
            now(),
        ),
    )


def audits_for(object_type, object_id, cashbox_id=None):
    if cashbox_id is None:
        return rows(
            """
            SELECT * FROM audit
            WHERE object_type = ? AND object_id = ?
            ORDER BY id DESC
            """,
            (object_type, str(object_id)),
        )
    return rows(
        """
        SELECT * FROM audit
        WHERE object_type = ? AND object_id = ? AND (cashbox_id = ? OR cashbox_id IS NULL)
        ORDER BY id DESC
        """,
        (object_type, str(object_id), cashbox_id),
    )
