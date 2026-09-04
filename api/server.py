#!/usr/bin/env python3
import json
import os
import re
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import auth
import backup
import db
import logic

CORS = os.environ.get("KASSIFY_CORS", "*")
HOST = os.environ.get("KASSIFY_HOST", "127.0.0.1")
PORT = int(os.environ.get("KASSIFY_PORT", "3000"))


class HttpError(Exception):
    def __init__(self, code, message):
        self.code = code
        self.message = message


def require(ctx, *roles):
    if ctx["role"] not in roles:
        raise HttpError(403, "Keine Berechtigung.")


def require_write(ctx):
    if ctx["role"] == "reader":
        raise HttpError(403, "Nur Leserecht.")


def scoped(ctx, cashbox_id):
    if ctx["role"] != "admin" and int(ctx["cashbox_id"] or 0) != int(cashbox_id):
        raise HttpError(403, "Kein Zugriff auf diese Kasse.")
    box = db.one("SELECT * FROM cashboxes WHERE id = ?", (cashbox_id,))
    if not box:
        raise HttpError(404, "Kasse nicht gefunden.")
    return box


def cashbox_payload(box):
    stats = logic.metrics(box)
    return {**box, **stats}


def member_payload(member):
    return {**member, "balanceCents": logic.member_balance(member["id"])}


def current_drink_qtys(event_id):
    rev = db.one(
        "SELECT id FROM drink_revisions WHERE event_id = ? ORDER BY id DESC",
        (event_id,),
    )
    if not rev:
        return {}
    qtys = {}
    for line in db.rows("SELECT member_id, qty FROM drink_lines WHERE revision_id = ?", (rev["id"],)):
        qtys[line["member_id"]] = line["qty"]
    return qtys


def apply_drink_ledger(box, event, qtys, previous, kind, booked_on):
    price = box["drink_price_cents"]
    keys = set(previous) | set(qtys)
    for member_id in keys:
        delta = int(qtys.get(member_id, 0)) - int(previous.get(member_id, 0))
        if delta == 0:
            continue
        amount = -(delta * price)
        db.execute(
            """
            INSERT INTO ledger(cashbox_id, member_id, kind, amount_cents, money_cents, booked_on, ref_type, ref_id, note, created_at)
            VALUES(?, ?, ?, ?, 0, ?, 'drink_event', ?, ?, ?)
            """,
            (box["id"], member_id, kind, amount, booked_on, event["id"], f"{delta}× Getränk", db.now()),
        )


def name_key(value):
    return " ".join((value or "").strip().lower().split())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"api: {self.address_string()} {format % args}")

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", CORS)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")

    def send_json(self, code, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def token(self):
        header = self.headers.get("Authorization") or ""
        if header.startswith("Bearer "):
            return header[7:].strip()
        return ""

    def context(self):
        row = auth.session_from_token(self.token())
        if not row:
            raise HttpError(401, "Bitte anmelden.")
        return row

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        try:
            with db.lock:
                payload = self.route(method, path, qs)
            if payload is None:
                return
            self.send_json(200, payload)
        except HttpError as err:
            self.send_json(err.code, {"error": err.message})
        except ValueError as err:
            self.send_json(400, {"error": str(err)})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "Interner Fehler."})

    def route(self, method, path, qs):
        if method == "GET" and path == "/api/health":
            return {"ok": True, "setupRequired": auth.setup_needed()}
        if method == "POST" and path == "/api/setup":
            return self.setup()
        if method == "POST" and path == "/api/login":
            return self.login()
        if method == "POST" and path == "/api/logout":
            return self.logout()
        if method == "GET" and path == "/api/me":
            return self.me()
        if method == "GET" and path == "/api/sessions":
            return self.list_sessions()
        if method == "POST" and path == "/api/sessions/revoke":
            return self.revoke_one()

        ctx = self.context()
        m = re.fullmatch(r"/api/cashboxes", path)
        if m and method == "GET":
            return self.list_cashboxes(ctx)
        if m and method == "POST":
            return self.create_cashbox(ctx)

        m = re.fullmatch(r"/api/backup/export", path)
        if m and method == "GET":
            return self.export_all(ctx, qs)
        m = re.fullmatch(r"/api/backup/preview", path)
        if m and method == "POST":
            return self.import_preview(ctx)
        m = re.fullmatch(r"/api/backup/import", path)
        if m and method == "POST":
            return self.import_run(ctx)
        m = re.fullmatch(r"/api/backup/csv", path)
        if m and method == "GET":
            return self.csv_export(ctx, qs)

        m = re.fullmatch(r"/api/cashboxes/(\d+)", path)
        if m and method == "GET":
            return self.get_cashbox(ctx, int(m.group(1)))
        if m and method == "PUT":
            return self.update_cashbox(ctx, int(m.group(1)))
        if m and method == "DELETE":
            return self.delete_cashbox(ctx, int(m.group(1)))

        m = re.fullmatch(r"/api/cashboxes/(\d+)/access", path)
        if m and method == "GET":
            return self.get_access(ctx, int(m.group(1)))
        if m and method == "PUT":
            return self.put_access(ctx, int(m.group(1)))

        m = re.fullmatch(r"/api/cashboxes/(\d+)/audit", path)
        if m and method == "GET":
            return self.box_audit(ctx, int(m.group(1)))

        m = re.fullmatch(r"/api/cashboxes/(\d+)/members", path)
        if m and method == "GET":
            return self.list_members(ctx, int(m.group(1)), qs)
        if m and method == "POST":
            return self.add_member(ctx, int(m.group(1)))

        m = re.fullmatch(r"/api/cashboxes/(\d+)/members/(\d+)", path)
        if m and method == "GET":
            return self.get_member(ctx, int(m.group(1)), int(m.group(2)))
        if m and method == "PUT":
            return self.edit_member(ctx, int(m.group(1)), int(m.group(2)))

        m = re.fullmatch(r"/api/cashboxes/(\d+)/members/(\d+)/deactivate", path)
        if m and method == "POST":
            return self.deactivate_member(ctx, int(m.group(1)), int(m.group(2)))
        m = re.fullmatch(r"/api/cashboxes/(\d+)/members/(\d+)/reactivate", path)
        if m and method == "POST":
            return self.reactivate_member(ctx, int(m.group(1)), int(m.group(2)))
        m = re.fullmatch(r"/api/cashboxes/(\d+)/members/(\d+)/deposit", path)
        if m and method == "POST":
            return self.member_money(ctx, int(m.group(1)), int(m.group(2)), "deposit")
        m = re.fullmatch(r"/api/cashboxes/(\d+)/members/(\d+)/correction", path)
        if m and method == "POST":
            return self.member_correction(ctx, int(m.group(1)), int(m.group(2)))
        m = re.fullmatch(r"/api/cashboxes/(\d+)/members/(\d+)/settle", path)
        if m and method == "POST":
            return self.settle_member(ctx, int(m.group(1)), int(m.group(2)))

        m = re.fullmatch(r"/api/cashboxes/(\d+)/drinks", path)
        if m and method == "GET":
            return self.list_drinks(ctx, int(m.group(1)))
        if m and method == "POST":
            return self.create_drink(ctx, int(m.group(1)))
        m = re.fullmatch(r"/api/cashboxes/(\d+)/drinks/(\d+)", path)
        if m and method == "GET":
            return self.get_drink(ctx, int(m.group(1)), int(m.group(2)))
        if m and method == "PUT":
            return self.edit_drink(ctx, int(m.group(1)), int(m.group(2)))
        m = re.fullmatch(r"/api/cashboxes/(\d+)/drinks/(\d+)/void", path)
        if m and method == "POST":
            return self.void_drink(ctx, int(m.group(1)), int(m.group(2)))

        m = re.fullmatch(r"/api/cashboxes/(\d+)/snapshots", path)
        if m and method == "GET":
            return self.list_snapshots(ctx, int(m.group(1)))
        if m and method == "POST":
            return self.add_snapshot(ctx, int(m.group(1)))

        m = re.fullmatch(r"/api/cashboxes/(\d+)/purchases", path)
        if m and method == "GET":
            return self.list_purchases(ctx, int(m.group(1)))
        if m and method == "POST":
            return self.add_purchase(ctx, int(m.group(1)))
        m = re.fullmatch(r"/api/cashboxes/(\d+)/purchases/(\d+)", path)
        if m and method == "GET":
            return self.get_purchase(ctx, int(m.group(1)), int(m.group(2)))
        if m and method == "PUT":
            return self.edit_purchase(ctx, int(m.group(1)), int(m.group(2)))
        m = re.fullmatch(r"/api/cashboxes/(\d+)/purchases/(\d+)/reimburse", path)
        if m and method == "POST":
            return self.reimburse(ctx, int(m.group(1)), int(m.group(2)))

        m = re.fullmatch(r"/api/cashboxes/(\d+)/reminders", path)
        if m and method == "GET":
            return self.reminders(ctx, int(m.group(1)))

        raise HttpError(404, "Nicht gefunden.")

    def setup(self):
        if not auth.setup_needed():
            raise HttpError(400, "Admin-Passwort ist bereits gesetzt.")
        password = str(self.read_json().get("password") or "")
        if len(password) < 8:
            raise HttpError(400, "Passwort mindestens 8 Zeichen.")
        auth.create_admin(password)
        session_id, token = auth.create_session(
            db.one("SELECT id FROM accesses WHERE role = 'admin'")["id"]
        )
        return {"token": token, "sessionId": session_id, "role": "admin", "cashboxId": None}

    def login(self):
        ip = self.client_address[0]
        if auth.throttle(ip):
            auth.record_attempt(ip, False, "throttled")
            raise HttpError(429, "Zu viele Fehlversuche. Bitte warten.")
        password = str(self.read_json().get("password") or "")
        access = auth.find_access_for_password(password)
        if not access:
            auth.record_attempt(ip, False, "unknown")
            raise HttpError(401, "Passwort unbekannt.")
        if not access["enabled"]:
            auth.record_attempt(ip, False, f"disabled:{access['role']}")
            raise HttpError(401, "Dieser Zugang ist stillgelegt.")
        session_id, token = auth.create_session(access["id"])
        auth.record_attempt(ip, True, access["role"])
        db.audit(access["cashbox_id"], "session", session_id, "login", access["role"])
        return {
            "token": token,
            "sessionId": session_id,
            "role": access["role"],
            "cashboxId": access["cashbox_id"],
        }

    def logout(self):
        row = auth.session_from_token(self.token())
        if row:
            auth.revoke_session(row["session_id"])
        return {"ok": True}

    def me(self):
        ctx = self.context()
        box = db.one("SELECT * FROM cashboxes WHERE id = ?", (ctx["cashbox_id"],)) if ctx["cashbox_id"] else None
        last_export = db.one(
            "SELECT created_at FROM audit WHERE action IN ('export','import') ORDER BY id DESC"
        )
        return {
            "role": ctx["role"],
            "cashboxId": ctx["cashbox_id"],
            "sessionId": ctx["session_id"],
            "cashboxName": box["name"] if box else None,
            "setupRequired": False,
            "lastBackupAt": last_export["created_at"] if last_export else None,
        }

    def list_sessions(self):
        ctx = self.context()
        items = db.rows(
            """
            SELECT id, created_at, last_seen, revoked FROM sessions
            WHERE access_id = ? ORDER BY id DESC
            """,
            (ctx["access_id"],),
        )
        return {"sessions": items, "currentId": ctx["session_id"]}

    def revoke_one(self):
        ctx = self.context()
        session_id = int(self.read_json().get("sessionId"))
        row = db.one("SELECT * FROM sessions WHERE id = ?", (session_id,))
        if not row or row["access_id"] != ctx["access_id"]:
            raise HttpError(404, "Sitzung nicht gefunden.")
        auth.revoke_session(session_id)
        db.audit(ctx["cashbox_id"], "session", session_id, "revoke", ctx["role"])
        return {"ok": True}

    def list_cashboxes(self, ctx):
        if ctx["role"] != "admin":
            box = scoped(ctx, ctx["cashbox_id"])
            return {"cashboxes": [cashbox_payload(box)]}
        return {"cashboxes": [cashbox_payload(box) for box in db.rows("SELECT * FROM cashboxes ORDER BY name")]}

    def create_cashbox(self, ctx):
        require(ctx, "admin")
        body = self.read_json()
        name = str(body.get("name") or "").strip()
        if not name:
            raise HttpError(400, "Bezeichnung fehlt.")
        if not body.get("feeFree", True):
            raise HttpError(400, "Zahlungen mit Gebührenabzug werden in dieser Version nicht unterstützt.")
        cashbox_id = db.execute(
            """
            INSERT INTO cashboxes(name, drink_price_cents, account_name, account_url, opening_balance_cents, opening_date, opening_source, fee_free, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?)
            """,
            (
                name,
                int(body.get("drinkPriceCents") or 100),
                str(body.get("accountName") or "").strip(),
                str(body.get("accountUrl") or "").strip(),
                int(body.get("openingBalanceCents") or 0),
                str(body.get("openingDate") or ""),
                str(body.get("openingSource") or "").strip(),
                db.now(),
            ),
        )
        db.audit(cashbox_id, "cashbox", cashbox_id, "create", "admin", None, body)
        return cashbox_payload(db.one("SELECT * FROM cashboxes WHERE id = ?", (cashbox_id,)))

    def get_cashbox(self, ctx, cashbox_id):
        box = scoped(ctx, cashbox_id)
        payload = cashbox_payload(box)
        payload["surplusHistory"] = logic.surplus_history(box)
        payload["audit"] = db.audits_for("cashbox", cashbox_id, cashbox_id)
        return payload

    def update_cashbox(self, ctx, cashbox_id):
        require(ctx, "admin")
        box = scoped(ctx, cashbox_id)
        body = self.read_json()
        if body.get("feeFree") is False:
            raise HttpError(400, "Zahlungen mit Gebührenabzug werden in dieser Version nicht unterstützt.")
        after = {
            "name": str(body.get("name") or box["name"]).strip(),
            "drink_price_cents": int(body.get("drinkPriceCents") or box["drink_price_cents"]),
            "account_name": str(body.get("accountName") or box["account_name"]).strip(),
            "account_url": str(body.get("accountUrl") or box["account_url"]).strip(),
            "opening_balance_cents": int(body.get("openingBalanceCents") if "openingBalanceCents" in body else box["opening_balance_cents"]),
            "opening_date": str(body.get("openingDate") or box["opening_date"]),
            "opening_source": str(body.get("openingSource") or box["opening_source"]).strip(),
        }
        db.execute(
            """
            UPDATE cashboxes
            SET name=?, drink_price_cents=?, account_name=?, account_url=?, opening_balance_cents=?, opening_date=?, opening_source=?
            WHERE id=?
            """,
            (*after.values(), cashbox_id),
        )
        db.audit(cashbox_id, "cashbox", cashbox_id, "update", "admin", dict(box), after)
        return cashbox_payload(db.one("SELECT * FROM cashboxes WHERE id = ?", (cashbox_id,)))

    def delete_cashbox(self, ctx, cashbox_id):
        require(ctx, "admin")
        box = scoped(ctx, cashbox_id)
        body = self.read_json()
        if str(body.get("confirmName") or "") != box["name"]:
            raise HttpError(400, "Kassename stimmt nicht.")
        dump = backup.dump_cashbox(cashbox_id)
        conn = db.db()
        conn.execute("DELETE FROM drink_lines WHERE revision_id IN (SELECT id FROM drink_revisions WHERE event_id IN (SELECT id FROM drink_events WHERE cashbox_id=?))", (cashbox_id,))
        conn.execute("DELETE FROM drink_revisions WHERE event_id IN (SELECT id FROM drink_events WHERE cashbox_id=?)", (cashbox_id,))
        conn.execute("DELETE FROM drink_events WHERE cashbox_id=?", (cashbox_id,))
        conn.execute("DELETE FROM reimbursements WHERE purchase_id IN (SELECT id FROM purchases WHERE cashbox_id=?)", (cashbox_id,))
        conn.execute("DELETE FROM purchases WHERE cashbox_id=?", (cashbox_id,))
        conn.execute("DELETE FROM ledger WHERE cashbox_id=?", (cashbox_id,))
        conn.execute("DELETE FROM account_snapshots WHERE cashbox_id=?", (cashbox_id,))
        conn.execute("DELETE FROM members WHERE cashbox_id=?", (cashbox_id,))
        conn.execute("DELETE FROM sessions WHERE access_id IN (SELECT id FROM accesses WHERE cashbox_id=?)", (cashbox_id,))
        conn.execute("DELETE FROM accesses WHERE cashbox_id=?", (cashbox_id,))
        conn.execute("DELETE FROM audit WHERE cashbox_id=?", (cashbox_id,))
        conn.execute("DELETE FROM cashboxes WHERE id=?", (cashbox_id,))
        conn.commit()
        db.audit(None, "cashbox", cashbox_id, "delete", "admin", {"name": box["name"]}, None)
        return {"ok": True, "export": dump}

    def get_access(self, ctx, cashbox_id):
        require(ctx, "admin")
        scoped(ctx, cashbox_id)
        items = db.rows(
            "SELECT id, role, enabled FROM accesses WHERE cashbox_id = ?",
            (cashbox_id,),
        )
        return {"accesses": items}

    def put_access(self, ctx, cashbox_id):
        require(ctx, "admin")
        scoped(ctx, cashbox_id)
        body = self.read_json()
        role = body.get("role")
        if role not in ("editor", "reader"):
            raise HttpError(400, "Ungültige Rolle.")
        password = body.get("password") or None
        enabled = body.get("enabled")
        try:
            auth.upsert_role_access(
                cashbox_id,
                role,
                password=password,
                enabled=None if enabled is None else bool(enabled),
            )
        except ValueError as err:
            raise HttpError(400, str(err)) from err
        return self.get_access(ctx, cashbox_id)

    def box_audit(self, ctx, cashbox_id):
        require(ctx, "admin")
        scoped(ctx, cashbox_id)
        return {
            "audit": db.rows(
                "SELECT * FROM audit WHERE cashbox_id = ? AND object_type IN ('cashbox','access') ORDER BY id DESC",
                (cashbox_id,),
            )
        }

    def list_members(self, ctx, cashbox_id, qs):
        scoped(ctx, cashbox_id)
        minus = qs.get("minus", [""])[0] == "1"
        items = [member_payload(m) for m in db.rows("SELECT * FROM members WHERE cashbox_id = ?", (cashbox_id,))]
        if minus:
            items = [m for m in items if m["balanceCents"] < 0]
        return {"members": items}

    def add_member(self, ctx, cashbox_id):
        require_write(ctx)
        scoped(ctx, cashbox_id)
        body = self.read_json()
        name = str(body.get("name") or "").strip()
        if not name:
            raise HttpError(400, "Name fehlt.")
        key = name_key(name)
        for member in db.rows("SELECT name FROM members WHERE cashbox_id = ?", (cashbox_id,)):
            if name_key(member["name"]) == key:
                raise HttpError(400, f"„{member['name']}“ gibt es in dieser Kasse schon.")
        member_id = db.execute(
            """
            INSERT INTO members(cashbox_id, name, short_name, note, active, created_at)
            VALUES(?, ?, ?, ?, 1, ?)
            """,
            (
                cashbox_id,
                name,
                str(body.get("shortName") or "").strip(),
                str(body.get("note") or "").strip(),
                db.now(),
            ),
        )
        start = int(body.get("startBalanceCents") or 0)
        if start:
            db.execute(
                """
                INSERT INTO ledger(cashbox_id, member_id, kind, amount_cents, money_cents, booked_on, ref_type, ref_id, note, created_at)
                VALUES(?, ?, 'start', ?, 0, ?, 'member', ?, 'Startguthaben', ?)
                """,
                (cashbox_id, member_id, start, str(body.get("date") or db.now()[:10]), member_id, db.now()),
            )
        db.audit(cashbox_id, "member", member_id, "create", ctx["role"], None, body)
        return member_payload(db.one("SELECT * FROM members WHERE id = ?", (member_id,)))

    def get_member(self, ctx, cashbox_id, member_id):
        scoped(ctx, cashbox_id)
        member = db.one("SELECT * FROM members WHERE id = ? AND cashbox_id = ?", (member_id, cashbox_id))
        if not member:
            raise HttpError(404, "Mitglied nicht gefunden.")
        ledger = db.rows(
            "SELECT * FROM ledger WHERE member_id = ? ORDER BY booked_on, id",
            (member_id,),
        )
        running = 0
        history = []
        for entry in ledger:
            running += entry["amount_cents"]
            history.append({**entry, "runningCents": running})
        return {
            **member_payload(member),
            "ledger": list(reversed(history)),
            "audit": db.rows(
                "SELECT * FROM audit WHERE object_type = 'member' AND object_id = ? ORDER BY id DESC",
                (str(member_id),),
            ),
        }

    def edit_member(self, ctx, cashbox_id, member_id):
        require_write(ctx)
        member = self.get_member(ctx, cashbox_id, member_id)
        body = self.read_json()
        name = str(body.get("name") or member["name"]).strip()
        key = name_key(name)
        for other in db.rows("SELECT id, name FROM members WHERE cashbox_id = ?", (cashbox_id,)):
            if other["id"] != member_id and name_key(other["name"]) == key:
                raise HttpError(400, f"„{other['name']}“ gibt es in dieser Kasse schon.")
        after = {
            "name": name,
            "short_name": str(body.get("shortName") or "").strip(),
            "note": str(body.get("note") or "").strip(),
        }
        db.execute(
            "UPDATE members SET name=?, short_name=?, note=? WHERE id=?",
            (after["name"], after["short_name"], after["note"], member_id),
        )
        db.audit(cashbox_id, "member", member_id, "update", ctx["role"], member, after)
        return self.get_member(ctx, cashbox_id, member_id)

    def deactivate_member(self, ctx, cashbox_id, member_id):
        require_write(ctx)
        member = self.get_member(ctx, cashbox_id, member_id)
        if member["balanceCents"] != 0:
            n = abs(member["balanceCents"])
            euro = f"{'-' if member['balanceCents'] < 0 else ''}{n // 100},{n % 100:02d}"
            raise HttpError(
                400,
                f"{member['name']} hat noch einen Saldo von {euro} €. Bitte zuerst ausgleichen.",
            )
        db.execute("UPDATE members SET active = 0 WHERE id = ?", (member_id,))
        db.audit(cashbox_id, "member", member_id, "deactivate", ctx["role"], {"active": True}, {"active": False})
        return self.get_member(ctx, cashbox_id, member_id)

    def reactivate_member(self, ctx, cashbox_id, member_id):
        require_write(ctx)
        self.get_member(ctx, cashbox_id, member_id)
        db.execute("UPDATE members SET active = 1 WHERE id = ?", (member_id,))
        db.audit(cashbox_id, "member", member_id, "reactivate", ctx["role"], {"active": False}, {"active": True})
        return self.get_member(ctx, cashbox_id, member_id)

    def member_money(self, ctx, cashbox_id, member_id, kind):
        require_write(ctx)
        member = self.get_member(ctx, cashbox_id, member_id)
        body = self.read_json()
        amount = int(body.get("amountCents") or 0)
        if amount <= 0:
            raise HttpError(400, "Betrag muss größer als 0 sein.")
        booked_on = str(body.get("date") or "")
        note = str(body.get("note") or "").strip()
        money = amount if kind == "deposit" else -amount
        delta = amount if kind == "deposit" else -amount
        db.execute(
            """
            INSERT INTO ledger(cashbox_id, member_id, kind, amount_cents, money_cents, booked_on, ref_type, ref_id, note, created_at)
            VALUES(?, ?, ?, ?, ?, ?, 'member', ?, ?, ?)
            """,
            (cashbox_id, member_id, kind, delta, money, booked_on, member_id, note, db.now()),
        )
        db.audit(
            cashbox_id,
            "member",
            member_id,
            kind,
            ctx["role"],
            {"balanceCents": member["balanceCents"]},
            {"amountCents": amount, "note": note},
        )
        return self.get_member(ctx, cashbox_id, member_id)

    def member_correction(self, ctx, cashbox_id, member_id):
        require_write(ctx)
        member = self.get_member(ctx, cashbox_id, member_id)
        body = self.read_json()
        amount = int(body.get("amountCents") or 0)
        if amount == 0:
            raise HttpError(400, "Korrekturbetrag fehlt.")
        note = str(body.get("note") or "").strip()
        if not note:
            raise HttpError(400, "Korrektur braucht eine Begründung.")
        db.execute(
            """
            INSERT INTO ledger(cashbox_id, member_id, kind, amount_cents, money_cents, booked_on, ref_type, ref_id, note, created_at)
            VALUES(?, ?, 'correction', ?, 0, ?, 'member', ?, ?, ?)
            """,
            (cashbox_id, member_id, amount, str(body.get("date") or ""), member_id, note, db.now()),
        )
        db.audit(cashbox_id, "member", member_id, "correction", ctx["role"], {"balanceCents": member["balanceCents"]}, body)
        return self.get_member(ctx, cashbox_id, member_id)

    def settle_member(self, ctx, cashbox_id, member_id):
        require_write(ctx)
        member = self.get_member(ctx, cashbox_id, member_id)
        body = self.read_json()
        reason = body.get("reason")
        balance = member["balanceCents"]
        if balance == 0:
            raise HttpError(400, "Saldo ist schon 0,00 €.")
        booked_on = str(body.get("date") or "")
        if reason == "payout" and balance > 0:
            kind, delta, money, note = "payout", -balance, -balance, "Saldo ausgleichen · Auszahlung"
        elif reason == "deposit" and balance < 0:
            kind, delta, money, note = "deposit", -balance, -balance, "Saldo ausgleichen · Einzahlung"
        elif reason == "writeoff" and balance < 0:
            explanation = str(body.get("note") or "").strip()
            if not explanation:
                raise HttpError(400, "Ausfall braucht eine Begründung.")
            kind, delta, money, note = "writeoff", -balance, 0, explanation
        else:
            raise HttpError(400, "Grund passt nicht zum Saldo.")
        db.execute(
            """
            INSERT INTO ledger(cashbox_id, member_id, kind, amount_cents, money_cents, booked_on, ref_type, ref_id, note, created_at)
            VALUES(?, ?, ?, ?, ?, ?, 'member', ?, ?, ?)
            """,
            (cashbox_id, member_id, kind, delta, money, booked_on, member_id, note, db.now()),
        )
        db.audit(cashbox_id, "member", member_id, "settle", ctx["role"], {"balanceCents": balance}, {"reason": reason})
        return self.get_member(ctx, cashbox_id, member_id)

    def list_drinks(self, ctx, cashbox_id):
        box = scoped(ctx, cashbox_id)
        events = db.rows("SELECT * FROM drink_events WHERE cashbox_id = ? ORDER BY booked_on DESC, id DESC", (cashbox_id,))
        out = []
        for event in events:
            qtys = current_drink_qtys(event["id"])
            total_qty = sum(qtys.values())
            people = sum(1 for q in qtys.values() if q > 0)
            out.append({**event, "qty": total_qty, "people": people, "totalCents": total_qty * box["drink_price_cents"]})
        return {"events": out}

    def drink_detail(self, ctx, cashbox_id, event_id):
        box = scoped(ctx, cashbox_id)
        event = db.one("SELECT * FROM drink_events WHERE id = ? AND cashbox_id = ?", (event_id, cashbox_id))
        if not event:
            raise HttpError(404, "Vorgang nicht gefunden.")
        qtys = current_drink_qtys(event_id)
        lines = []
        for member_id, qty in qtys.items():
            member = db.one("SELECT name FROM members WHERE id = ?", (member_id,))
            lines.append({"memberId": member_id, "name": member["name"] if member else "?", "qty": qty, "cents": qty * box["drink_price_cents"]})
        return {
            **event,
            "lines": lines,
            "priceCents": box["drink_price_cents"],
            "audit": db.rows(
                "SELECT * FROM audit WHERE object_type = 'drink_event' AND object_id = ? ORDER BY id DESC",
                (str(event_id),),
            ),
        }

    def get_drink(self, ctx, cashbox_id, event_id):
        return self.drink_detail(ctx, cashbox_id, event_id)

    def save_revision(self, event_id, role, lines):
        rev_id = db.execute(
            "INSERT INTO drink_revisions(event_id, created_at, role) VALUES(?, ?, ?)",
            (event_id, db.now(), role),
        )
        for line in lines:
            qty = int(line.get("qty") or 0)
            if qty <= 0:
                continue
            db.execute(
                "INSERT INTO drink_lines(revision_id, member_id, qty) VALUES(?, ?, ?)",
                (rev_id, int(line["memberId"]), qty),
            )
        return rev_id

    def create_drink(self, ctx, cashbox_id):
        require_write(ctx)
        box = scoped(ctx, cashbox_id)
        body = self.read_json()
        event_id = db.execute(
            """
            INSERT INTO drink_events(cashbox_id, booked_on, label, status, created_at)
            VALUES(?, ?, ?, 'open', ?)
            """,
            (cashbox_id, str(body.get("date") or ""), str(body.get("label") or "").strip(), db.now()),
        )
        event = db.one("SELECT * FROM drink_events WHERE id = ?", (event_id,))
        self.save_revision(event_id, ctx["role"], body.get("lines") or [])
        qtys = current_drink_qtys(event_id)
        apply_drink_ledger(box, event, qtys, {}, "drink", event["booked_on"])
        db.audit(cashbox_id, "drink_event", event_id, "create", ctx["role"], None, body)
        return self.drink_detail(ctx, cashbox_id, event_id)

    def edit_drink(self, ctx, cashbox_id, event_id):
        require_write(ctx)
        box = scoped(ctx, cashbox_id)
        detail = self.drink_detail(ctx, cashbox_id, event_id)
        if detail["status"] == "voided":
            raise HttpError(400, "Stornierter Vorgang lässt sich nicht ändern.")
        body = self.read_json()
        previous = current_drink_qtys(event_id)
        db.execute(
            "UPDATE drink_events SET booked_on = ?, label = ? WHERE id = ?",
            (str(body.get("date") or detail["booked_on"]), str(body.get("label") or "").strip(), event_id),
        )
        self.save_revision(event_id, ctx["role"], body.get("lines") or [])
        qtys = current_drink_qtys(event_id)
        event = db.one("SELECT * FROM drink_events WHERE id = ?", (event_id,))
        apply_drink_ledger(box, event, qtys, previous, "drink_correction", event["booked_on"])
        db.audit(cashbox_id, "drink_event", event_id, "update", ctx["role"], previous, qtys)
        return self.drink_detail(ctx, cashbox_id, event_id)

    def void_drink(self, ctx, cashbox_id, event_id):
        require_write(ctx)
        box = scoped(ctx, cashbox_id)
        detail = self.drink_detail(ctx, cashbox_id, event_id)
        if detail["status"] == "voided":
            raise HttpError(400, "Bereits storniert.")
        previous = current_drink_qtys(event_id)
        event = db.one("SELECT * FROM drink_events WHERE id = ?", (event_id,))
        apply_drink_ledger(box, event, {}, previous, "drink_void", event["booked_on"])
        db.execute("UPDATE drink_events SET status = 'voided' WHERE id = ?", (event_id,))
        db.audit(cashbox_id, "drink_event", event_id, "void", ctx["role"], previous, {})
        return self.drink_detail(ctx, cashbox_id, event_id)

    def list_snapshots(self, ctx, cashbox_id):
        box = scoped(ctx, cashbox_id)
        return {
            "account": {
                "name": box["account_name"],
                "url": box["account_url"],
                "openingBalanceCents": box["opening_balance_cents"],
                "openingDate": box["opening_date"],
                "openingSource": box["opening_source"],
            },
            "metrics": logic.metrics(box),
            "surplusHistory": logic.surplus_history(box),
            "snapshots": db.rows(
                "SELECT * FROM account_snapshots WHERE cashbox_id = ? ORDER BY booked_on DESC, id DESC",
                (cashbox_id,),
            ),
            "audit": db.rows(
                "SELECT * FROM audit WHERE cashbox_id = ? AND object_type IN ('snapshot','cashbox','reimbursement') ORDER BY id DESC",
                (cashbox_id,),
            ),
        }

    def add_snapshot(self, ctx, cashbox_id):
        require_write(ctx)
        scoped(ctx, cashbox_id)
        body = self.read_json()
        snap_id = db.execute(
            """
            INSERT INTO account_snapshots(cashbox_id, booked_on, amount_cents, source, note, created_at)
            VALUES(?, ?, ?, ?, ?, ?)
            """,
            (
                cashbox_id,
                str(body.get("date") or ""),
                int(body.get("amountCents") or 0),
                str(body.get("source") or "").strip(),
                str(body.get("note") or "").strip(),
                db.now(),
            ),
        )
        db.audit(cashbox_id, "snapshot", snap_id, "create", ctx["role"], None, body)
        return self.list_snapshots(ctx, cashbox_id)

    def list_purchases(self, ctx, cashbox_id):
        scoped(ctx, cashbox_id)
        items = []
        for purchase in db.rows("SELECT * FROM purchases WHERE cashbox_id = ? ORDER BY booked_on DESC, id DESC", (cashbox_id,)):
            items.append({**purchase, **logic.purchase_status(purchase)})
        return {"purchases": items}

    def get_purchase(self, ctx, cashbox_id, purchase_id):
        scoped(ctx, cashbox_id)
        purchase = db.one("SELECT * FROM purchases WHERE id = ? AND cashbox_id = ?", (purchase_id, cashbox_id))
        if not purchase:
            raise HttpError(404, "Einkauf nicht gefunden.")
        return {
            **purchase,
            **logic.purchase_status(purchase),
            "goodsCents": purchase["receipt_cents"] + (purchase["pfand_cents"] if purchase["pfand_given"] else 0),
            "reimbursements": db.rows(
                "SELECT * FROM reimbursements WHERE purchase_id = ? ORDER BY booked_on, id",
                (purchase_id,),
            ),
            "audit": db.rows(
                "SELECT * FROM audit WHERE object_type IN ('purchase','reimbursement') AND object_id IN (?, ?) ORDER BY id DESC",
                (str(purchase_id), f"purchase:{purchase_id}"),
            ),
        }

    def add_purchase(self, ctx, cashbox_id):
        require_write(ctx)
        scoped(ctx, cashbox_id)
        body = self.read_json()
        purchase_id = db.execute(
            """
            INSERT INTO purchases(cashbox_id, booked_on, vendor, description, receipt_cents, pfand_cents, pfand_given, advanced_by, note, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cashbox_id,
                str(body.get("date") or ""),
                str(body.get("vendor") or "").strip(),
                str(body.get("description") or "").strip(),
                int(body.get("receiptCents") or 0),
                int(body.get("pfandCents") or 0),
                1 if body.get("pfandGiven") else 0,
                str(body.get("advancedBy") or "").strip(),
                str(body.get("note") or "").strip(),
                db.now(),
            ),
        )
        db.audit(cashbox_id, "purchase", purchase_id, "create", ctx["role"], None, body)
        if body.get("reimburseNow"):
            self._reimburse(
                ctx,
                cashbox_id,
                purchase_id,
                int(body.get("reimburseCents") or body.get("receiptCents") or 0),
                str(body.get("reimburseDate") or body.get("date") or ""),
                str(body.get("reimburseRef") or "").strip(),
            )
        return self.get_purchase(ctx, cashbox_id, purchase_id)

    def edit_purchase(self, ctx, cashbox_id, purchase_id):
        require_write(ctx)
        before = self.get_purchase(ctx, cashbox_id, purchase_id)
        body = self.read_json()
        db.execute(
            """
            UPDATE purchases
            SET booked_on=?, vendor=?, description=?, receipt_cents=?, pfand_cents=?, pfand_given=?, advanced_by=?, note=?
            WHERE id=?
            """,
            (
                str(body.get("date") or before["booked_on"]),
                str(body.get("vendor") or before["vendor"]).strip(),
                str(body.get("description") or before["description"]).strip(),
                int(body.get("receiptCents") if "receiptCents" in body else before["receipt_cents"]),
                int(body.get("pfandCents") if "pfandCents" in body else before["pfand_cents"]),
                1 if body.get("pfandGiven", before["pfand_given"]) else 0,
                str(body.get("advancedBy") or before["advanced_by"]).strip(),
                str(body.get("note") or before["note"]).strip(),
                purchase_id,
            ),
        )
        db.audit(cashbox_id, "purchase", purchase_id, "update", ctx["role"], before, body)
        return self.get_purchase(ctx, cashbox_id, purchase_id)

    def _reimburse(self, ctx, cashbox_id, purchase_id, amount, booked_on, reference):
        if amount <= 0:
            raise HttpError(400, "Erstattungsbetrag fehlt.")
        reimb_id = db.execute(
            """
            INSERT INTO reimbursements(purchase_id, booked_on, amount_cents, reference, created_at)
            VALUES(?, ?, ?, ?, ?)
            """,
            (purchase_id, booked_on, amount, reference, db.now()),
        )
        db.execute(
            """
            INSERT INTO ledger(cashbox_id, member_id, kind, amount_cents, money_cents, booked_on, ref_type, ref_id, note, created_at)
            VALUES(?, NULL, 'reimbursement', 0, ?, ?, 'purchase', ?, ?, ?)
            """,
            (cashbox_id, -amount, booked_on, purchase_id, reference or "Erstattung", db.now()),
        )
        db.audit(cashbox_id, "reimbursement", reimb_id, "create", ctx["role"], None, {"amountCents": amount})
        return reimb_id

    def reimburse(self, ctx, cashbox_id, purchase_id):
        require_write(ctx)
        self.get_purchase(ctx, cashbox_id, purchase_id)
        body = self.read_json()
        self._reimburse(
            ctx,
            cashbox_id,
            purchase_id,
            int(body.get("amountCents") or 0),
            str(body.get("date") or ""),
            str(body.get("reference") or "").strip(),
        )
        return self.get_purchase(ctx, cashbox_id, purchase_id)

    def reminders(self, ctx, cashbox_id):
        require(ctx, "admin", "editor")
        scoped(ctx, cashbox_id)
        members = [
            m
            for m in (member_payload(x) for x in db.rows("SELECT * FROM members WHERE cashbox_id = ?", (cashbox_id,)))
            if m["balanceCents"] < 0
        ]
        members.sort(key=lambda m: m["balanceCents"])
        return {"members": members}

    def export_all(self, ctx, qs):
        require(ctx, "admin")
        cashbox_id = qs.get("cashbox", [None])[0]
        if cashbox_id:
            payload = {
                "format": "kassify-backup",
                "version": 1,
                "exportedAt": db.now(),
                "adminAccess": None,
                "cashboxes": [backup.dump_cashbox(int(cashbox_id))],
                "globalAudit": [],
            }
        else:
            payload = backup.dump_all()
        db.audit(int(cashbox_id) if cashbox_id else None, "backup", "export", "export", "admin", None, backup.summary_from_dump(payload))
        stamp = db.now().replace(":", "-")
        name = f"kassify-{stamp}.json"
        self.send_json(
            200,
            payload,
            {"Content-Disposition": f'attachment; filename="{name}"'},
        )
        return None

    def import_preview(self, ctx):
        require(ctx, "admin")
        body = self.read_json()
        payload = body.get("backup") or body
        if payload.get("format") != "kassify-backup":
            raise HttpError(400, "Datei ist kein Kassify-Export.")
        existing = {b["name"] for b in db.rows("SELECT name FROM cashboxes")}
        names = []
        for box in payload.get("cashboxes") or []:
            names.append(
                {
                    "name": box.get("name"),
                    "exists": box.get("name") in existing,
                    **(backup.summary_from_dump({"cashboxes": [box]})[0]),
                }
            )
        return {"cashboxes": names, "existingCount": len(existing)}

    def import_run(self, ctx):
        require(ctx, "admin")
        body = self.read_json()
        payload = body.get("backup")
        mode = body.get("mode")
        if mode not in ("restore", "merge"):
            raise HttpError(400, "Bitte Wiederherstellen oder Ergänzen ausdrücklich wählen.")
        if payload.get("format") != "kassify-backup":
            raise HttpError(400, "Datei ist kein Kassify-Export.")
        selected = set(body.get("selectedNames") or [b["name"] for b in payload.get("cashboxes") or []])
        if mode == "restore":
            if str(body.get("confirmWord") or "") != "WIEDERHERSTELLEN":
                raise HttpError(400, "Bitte WIEDERHERSTELLEN eintippen.")
            backup.restore_all(payload)
            db.audit(None, "backup", "import", "import", "admin", None, {"mode": "restore"})
            return {"ok": True, "summary": backup.summary_from_dump(payload)}
        created = []
        skipped_passwords = []
        existing_names = {b["name"] for b in db.rows("SELECT name FROM cashboxes")}
        decisions = body.get("nameDecisions") or {}
        for box in payload.get("cashboxes") or []:
            name = box.get("name")
            if name not in selected:
                continue
            if name in existing_names:
                decision = decisions.get(name) or "skip"
                if decision == "skip":
                    continue
                if decision == "rename":
                    name = str((body.get("newNames") or {}).get(box["name"]) or f"{box['name']} (Import)")
                else:
                    raise HttpError(400, f"Kasse „{box['name']}“ existiert schon. Überspringen oder umbenennen.")
            skip_roles = set()
            for access in box.get("accesses") or []:
                raw = access.get("_plain")
                if not raw and access.get("password_hash"):
                    continue
            # Password collision: verify imported hashes cannot be checked without plaintext.
            # Hashes differ per salt; uniqueness is on plaintext. We cannot know collision
            # from hashes alone. Keep imported hashes; if later set conflicts, setter checks.
            new_id = backup.insert_cashbox(box, keep_ids=False, name=name, skip_access_roles=skip_roles)
            created.append(name)
        db.audit(None, "backup", "import", "import", "admin", None, {"mode": "merge", "created": created})
        return {"ok": True, "created": created, "passwordWarnings": skipped_passwords, "summary": backup.summary_from_dump(payload)}

    def csv_export(self, ctx, qs):
        require(ctx, "admin", "editor")
        cashbox_id = int(qs.get("cashbox", [ctx["cashbox_id"] or 0])[0])
        scoped(ctx, cashbox_id)
        start = qs.get("from", [""])[0]
        end = qs.get("to", [""])[0]
        lines = ["Datum;Mitglied;Art;Betrag_EUR;Notiz"]
        query = "SELECT l.*, m.name AS member_name FROM ledger l LEFT JOIN members m ON m.id = l.member_id WHERE l.cashbox_id = ?"
        params = [cashbox_id]
        if start:
            query += " AND l.booked_on >= ?"
            params.append(start)
        if end:
            query += " AND l.booked_on <= ?"
            params.append(end)
        query += " ORDER BY l.booked_on, l.id"
        for entry in db.rows(query, params):
            amount = f"{entry['amount_cents'] / 100:.2f}".replace(".", ",")
            lines.append(
                f"{entry['booked_on']};{entry['member_name'] or ''};{entry['kind']};{amount};{(entry['note'] or '').replace(';', ',')}"
            )
        csv = "\n".join(lines)
        body = csv.encode("utf-8-sig")
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="kassify-auswertung.csv"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return None


def main():
    db.connect()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Kassify API on {HOST}:{PORT}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
