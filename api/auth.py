import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict

from db import audit, execute, now, one, rows

PBKDF2_ROUNDS = 180_000
_fail_times = defaultdict(list)


def hash_password(password):
    salt = os.urandom(16).hex()
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ROUNDS
    ).hex()
    return digest, salt


def verify_password(password, digest, salt):
    if not digest or not salt:
        return False
    check = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ROUNDS
    ).hex()
    return hmac.compare_digest(check, digest)


def password_taken(password, ignore_id=None):
    for access in rows("SELECT id, password_hash, password_salt FROM accesses"):
        if ignore_id is not None and access["id"] == ignore_id:
            continue
        if verify_password(password, access["password_hash"], access["password_salt"]):
            return True
    return False


def hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def setup_needed():
    row = one("SELECT COUNT(*) AS n FROM accesses WHERE role = 'admin'")
    return not row or row["n"] == 0


def create_admin(password):
    digest, salt = hash_password(password)
    access_id = execute(
        """
        INSERT INTO accesses(cashbox_id, role, password_hash, password_salt, enabled, created_at)
        VALUES(NULL, 'admin', ?, ?, 1, ?)
        """,
        (digest, salt, now()),
    )
    audit(None, "access", access_id, "password_set", "admin", None, {"role": "admin"})
    return access_id


def throttle(ip):
    window = time.time() - 15 * 60
    recent = [t for t in _fail_times[ip] if t > window]
    _fail_times[ip] = recent
    if len(recent) >= 5:
        time.sleep(min(2 + len(recent) * 0.4, 8))
    if len(recent) >= 12:
        return True
    return False


def record_attempt(ip, success, note=""):
    execute(
        "INSERT INTO login_attempts(at, ip, success, note) VALUES(?, ?, ?, ?)",
        (now(), ip or "", 1 if success else 0, note),
    )
    if not success:
        _fail_times[ip].append(time.time())


def find_access_for_password(password):
    for access in rows("SELECT * FROM accesses"):
        if verify_password(password, access["password_hash"], access["password_salt"]):
            return access
    return None


def create_session(access_id):
    token = secrets.token_urlsafe(32)
    stamp = now()
    session_id = execute(
        """
        INSERT INTO sessions(access_id, token_hash, created_at, last_seen, revoked)
        VALUES(?, ?, ?, ?, 0)
        """,
        (access_id, hash_token(token), stamp, stamp),
    )
    return session_id, token


def session_from_token(token):
    if not token:
        return None
    row = one(
        """
        SELECT s.id AS session_id, s.revoked, s.access_id, a.role, a.cashbox_id, a.enabled
        FROM sessions s
        JOIN accesses a ON a.id = s.access_id
        WHERE s.token_hash = ?
        """,
        (hash_token(token),),
    )
    if not row or row["revoked"]:
        return None
    if not row["enabled"]:
        execute("UPDATE sessions SET revoked = 1 WHERE access_id = ?", (row["access_id"],))
        return None
    execute("UPDATE sessions SET last_seen = ? WHERE id = ?", (now(), row["session_id"]))
    return row


def revoke_session(session_id):
    execute("UPDATE sessions SET revoked = 1 WHERE id = ?", (session_id,))


def revoke_access_sessions(access_id):
    execute("UPDATE sessions SET revoked = 1 WHERE access_id = ?", (access_id,))


def set_access_password(access_id, password, role, cashbox_id):
    if password_taken(password, ignore_id=access_id):
        raise ValueError("Dieses Passwort ist bereits vergeben.")
    digest, salt = hash_password(password)
    execute(
        "UPDATE accesses SET password_hash = ?, password_salt = ? WHERE id = ?",
        (digest, salt, access_id),
    )
    audit(cashbox_id, "access", access_id, "password_set", "admin", None, {"role": role})


def upsert_role_access(cashbox_id, role, password=None, enabled=None):
    existing = one(
        "SELECT * FROM accesses WHERE cashbox_id = ? AND role = ?",
        (cashbox_id, role),
    )
    if existing is None:
        digest, salt = hash_password(password or secrets.token_urlsafe(18))
        enabled_val = 1 if (enabled is None and password) else (1 if enabled else 0)
        if password:
            if password_taken(password):
                raise ValueError("Dieses Passwort ist bereits vergeben.")
            digest, salt = hash_password(password)
        access_id = execute(
            """
            INSERT INTO accesses(cashbox_id, role, password_hash, password_salt, enabled, created_at)
            VALUES(?, ?, ?, ?, ?, ?)
            """,
            (cashbox_id, role, digest, salt, enabled_val, now()),
        )
        if password:
            audit(cashbox_id, "access", access_id, "password_set", "admin", None, {"role": role})
        if enabled is not None:
            audit(
                cashbox_id,
                "access",
                access_id,
                "role_enabled" if enabled_val else "role_disabled",
                "admin",
                {"enabled": None},
                {"enabled": bool(enabled_val), "role": role},
            )
        if enabled_val == 0:
            revoke_access_sessions(access_id)
        return access_id
    if password:
        set_access_password(existing["id"], password, role, cashbox_id)
    if enabled is not None:
        before = {"enabled": bool(existing["enabled"]), "role": role}
        execute("UPDATE accesses SET enabled = ? WHERE id = ?", (1 if enabled else 0, existing["id"]))
        if not enabled:
            revoke_access_sessions(existing["id"])
        audit(
            cashbox_id,
            "access",
            existing["id"],
            "role_enabled" if enabled else "role_disabled",
            "admin",
            before,
            {"enabled": bool(enabled), "role": role},
        )
    return existing["id"]
