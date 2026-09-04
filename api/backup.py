from db import db, now, one, rows


def dump_cashbox(cashbox_id):
    box = one("SELECT * FROM cashboxes WHERE id = ?", (cashbox_id,))
    if not box:
        return None
    members = rows("SELECT * FROM members WHERE cashbox_id = ? ORDER BY id", (cashbox_id,))
    events = rows("SELECT * FROM drink_events WHERE cashbox_id = ? ORDER BY id", (cashbox_id,))
    packed_events = []
    for event in events:
        revisions = rows("SELECT * FROM drink_revisions WHERE event_id = ? ORDER BY id", (event["id"],))
        packed_revs = []
        for rev in revisions:
            packed_revs.append(
                {
                    **rev,
                    "lines": rows("SELECT * FROM drink_lines WHERE revision_id = ? ORDER BY id", (rev["id"],)),
                }
            )
        packed_events.append({**event, "revisions": packed_revs})
    purchases = rows("SELECT * FROM purchases WHERE cashbox_id = ? ORDER BY id", (cashbox_id,))
    packed_purchases = []
    for purchase in purchases:
        packed_purchases.append(
            {
                **purchase,
                "reimbursements": rows(
                    "SELECT * FROM reimbursements WHERE purchase_id = ? ORDER BY id",
                    (purchase["id"],),
                ),
            }
        )
    return {
        **box,
        "accesses": rows(
            "SELECT role, password_hash, password_salt, enabled FROM accesses WHERE cashbox_id = ? ORDER BY role",
            (cashbox_id,),
        ),
        "members": members,
        "ledger": rows("SELECT * FROM ledger WHERE cashbox_id = ? ORDER BY id", (cashbox_id,)),
        "snapshots": rows(
            "SELECT * FROM account_snapshots WHERE cashbox_id = ? ORDER BY id", (cashbox_id,)
        ),
        "drinkEvents": packed_events,
        "purchases": packed_purchases,
        "audit": rows("SELECT * FROM audit WHERE cashbox_id = ? ORDER BY id", (cashbox_id,)),
    }


def dump_all():
    admin = one("SELECT password_hash, password_salt, enabled FROM accesses WHERE role = 'admin'")
    return {
        "format": "kassify-backup",
        "version": 1,
        "exportedAt": now(),
        "adminAccess": admin,
        "cashboxes": [dump_cashbox(box["id"]) for box in rows("SELECT id FROM cashboxes ORDER BY id")],
        "globalAudit": rows("SELECT * FROM audit WHERE cashbox_id IS NULL ORDER BY id"),
    }


def summary_from_dump(payload):
    out = []
    for box in payload.get("cashboxes") or []:
        members = box.get("members") or []
        ledger = box.get("ledger") or []
        balances = {}
        for entry in ledger:
            mid = entry.get("member_id")
            if mid is None:
                continue
            balances[mid] = balances.get(mid, 0) + int(entry.get("amount_cents") or 0)
        soll = sum(balances.values())
        snaps = box.get("snapshots") or []
        ist = snaps[-1]["amount_cents"] if snaps else box.get("opening_balance_cents") or 0
        out.append(
            {
                "name": box.get("name"),
                "memberCount": len(members),
                "bookingCount": len(ledger),
                "sollCents": soll,
                "istCents": ist,
                "surplusCents": ist - soll,
            }
        )
    return out


def wipe_all():
    tables = [
        "drink_lines",
        "drink_revisions",
        "drink_events",
        "reimbursements",
        "purchases",
        "ledger",
        "account_snapshots",
        "members",
        "sessions",
        "accesses",
        "cashboxes",
        "audit",
        "login_attempts",
    ]
    conn = db()
    for table in tables:
        conn.execute(f"DELETE FROM {table}")
    conn.commit()


def _insert(table, data, fields):
    cols = ", ".join(fields)
    marks = ", ".join("?" * len(fields))
    values = [data.get(field) for field in fields]
    cur = db().execute(f"INSERT INTO {table}({cols}) VALUES({marks})", values)
    return cur.lastrowid


def restore_all(payload):
    wipe_all()
    admin = payload.get("adminAccess")
    if admin:
        _insert(
            "accesses",
            {**admin, "cashbox_id": None, "role": "admin", "created_at": now()},
            ["cashbox_id", "role", "password_hash", "password_salt", "enabled", "created_at"],
        )
    for box in payload.get("cashboxes") or []:
        insert_cashbox(box, keep_ids=True)
    for entry in payload.get("globalAudit") or []:
        _insert(
            "audit",
            entry,
            [
                "id",
                "cashbox_id",
                "object_type",
                "object_id",
                "action",
                "role",
                "before_json",
                "after_json",
                "note",
                "created_at",
            ],
        )
    db().commit()


def insert_cashbox(box, keep_ids=False, name=None, skip_access_roles=None):
    skip_access_roles = skip_access_roles or set()
    old_id = box["id"]
    fields = [
        "name",
        "drink_price_cents",
        "account_name",
        "account_url",
        "opening_balance_cents",
        "opening_date",
        "opening_source",
        "fee_free",
        "created_at",
    ]
    data = {**box, "name": name or box["name"]}
    if keep_ids:
        new_id = _insert("cashboxes", {**data, "id": old_id}, ["id"] + fields)
    else:
        new_id = _insert("cashboxes", data, fields)

    member_map = {}
    for member in box.get("members") or []:
        payload = {**member, "cashbox_id": new_id}
        if keep_ids:
            member_map[member["id"]] = _insert(
                "members",
                payload,
                ["id", "cashbox_id", "name", "short_name", "note", "active", "created_at"],
            )
        else:
            member_map[member["id"]] = _insert(
                "members",
                payload,
                ["cashbox_id", "name", "short_name", "note", "active", "created_at"],
            )

    event_map, rev_map, purchase_map = {}, {}, {}
    for event in box.get("drinkEvents") or []:
        ev = {**event, "cashbox_id": new_id}
        cols = ["cashbox_id", "booked_on", "label", "status", "created_at"]
        if keep_ids:
            event_map[event["id"]] = _insert("drink_events", ev, ["id"] + cols)
        else:
            event_map[event["id"]] = _insert("drink_events", ev, cols)
        for rev in event.get("revisions") or []:
            rv = {**rev, "event_id": event_map[event["id"]]}
            rcols = ["event_id", "created_at", "role"]
            if keep_ids:
                rev_map[rev["id"]] = _insert("drink_revisions", rv, ["id"] + rcols)
            else:
                rev_map[rev["id"]] = _insert("drink_revisions", rv, rcols)
            for line in rev.get("lines") or []:
                ln = {
                    **line,
                    "revision_id": rev_map[rev["id"]],
                    "member_id": member_map.get(line["member_id"], line["member_id"]),
                }
                lcols = ["revision_id", "member_id", "qty"]
                if keep_ids:
                    _insert("drink_lines", ln, ["id"] + lcols)
                else:
                    _insert("drink_lines", ln, lcols)

    for snap in box.get("snapshots") or []:
        payload = {**snap, "cashbox_id": new_id}
        cols = ["cashbox_id", "booked_on", "amount_cents", "source", "note", "created_at"]
        _insert("account_snapshots", payload, (["id"] + cols) if keep_ids else cols)

    for purchase in box.get("purchases") or []:
        payload = {**purchase, "cashbox_id": new_id}
        cols = [
            "cashbox_id",
            "booked_on",
            "vendor",
            "description",
            "receipt_cents",
            "pfand_cents",
            "pfand_given",
            "advanced_by",
            "note",
            "created_at",
        ]
        if keep_ids:
            purchase_map[purchase["id"]] = _insert("purchases", payload, ["id"] + cols)
        else:
            purchase_map[purchase["id"]] = _insert("purchases", payload, cols)
        for reimb in purchase.get("reimbursements") or []:
            rp = {**reimb, "purchase_id": purchase_map[purchase["id"]]}
            rcols = ["purchase_id", "booked_on", "amount_cents", "reference", "created_at"]
            _insert("reimbursements", rp, (["id"] + rcols) if keep_ids else rcols)

    for entry in box.get("ledger") or []:
        payload = {
            **entry,
            "cashbox_id": new_id,
            "member_id": member_map.get(entry["member_id"], entry["member_id"])
            if entry.get("member_id")
            else None,
        }
        if entry.get("ref_type") == "drink_event" and entry.get("ref_id") in event_map:
            payload["ref_id"] = event_map[entry["ref_id"]]
        if entry.get("ref_type") == "purchase" and entry.get("ref_id") in purchase_map:
            payload["ref_id"] = purchase_map[entry["ref_id"]]
        if entry.get("ref_type") == "member" and entry.get("ref_id") in member_map:
            payload["ref_id"] = member_map[entry["ref_id"]]
        cols = [
            "cashbox_id",
            "member_id",
            "kind",
            "amount_cents",
            "money_cents",
            "booked_on",
            "ref_type",
            "ref_id",
            "note",
            "created_at",
        ]
        _insert("ledger", payload, (["id"] + cols) if keep_ids else cols)

    for access in box.get("accesses") or []:
        if access.get("role") in skip_access_roles:
            payload = {
                **access,
                "cashbox_id": new_id,
                "password_hash": "",
                "password_salt": "",
                "enabled": 0,
                "created_at": now(),
            }
        else:
            payload = {**access, "cashbox_id": new_id, "created_at": access.get("created_at") or now()}
        _insert(
            "accesses",
            payload,
            ["cashbox_id", "role", "password_hash", "password_salt", "enabled", "created_at"],
        )

    for entry in box.get("audit") or []:
        payload = {**entry, "cashbox_id": new_id}
        cols = [
            "cashbox_id",
            "object_type",
            "object_id",
            "action",
            "role",
            "before_json",
            "after_json",
            "note",
            "created_at",
        ]
        _insert("audit", payload, (["id"] + cols) if keep_ids else cols)

    db().commit()
    return new_id
