from db import one, rows

FOUR_WEEKS_DAYS = 28


def member_balance(member_id):
    row = one(
        "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger WHERE member_id = ?",
        (member_id,),
    )
    return int(row["n"] if row else 0)


def cashbox_balances(cashbox_id):
    items = rows(
        """
        SELECT m.id, COALESCE(SUM(l.amount_cents), 0) AS balance
        FROM members m
        LEFT JOIN ledger l ON l.member_id = m.id
        WHERE m.cashbox_id = ?
        GROUP BY m.id
        """,
        (cashbox_id,),
    )
    return {item["id"]: int(item["balance"]) for item in items}


def last_snapshot(cashbox_id):
    return one(
        """
        SELECT * FROM account_snapshots
        WHERE cashbox_id = ?
        ORDER BY booked_on DESC, id DESC
        """,
        (cashbox_id,),
    )


def open_expenses(cashbox_id):
    purchases = rows("SELECT id, receipt_cents FROM purchases WHERE cashbox_id = ?", (cashbox_id,))
    open_cents = 0
    for purchase in purchases:
        paid = one(
            "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM reimbursements WHERE purchase_id = ?",
            (purchase["id"],),
        )
        rest = purchase["receipt_cents"] - int(paid["n"])
        if rest > 0:
            open_cents += rest
    return open_cents


def writeoff_total(cashbox_id):
    row = one(
        "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger WHERE cashbox_id = ? AND kind = 'writeoff'",
        (cashbox_id,),
    )
    return int(row["n"] if row else 0)


def soll_on(cashbox_id, date):
    row = one(
        "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger WHERE cashbox_id = ? AND booked_on <= ?",
        (cashbox_id, date),
    )
    return int(row["n"] if row else 0)


def expected_balance(cashbox, as_of):
    """Kontostand, der am Stichtag des Ist-Standes auf dem Konto liegen müsste.

    Bewegungen am Tag des Anfangsbestandes stecken bereits in diesem, Bewegungen
    nach dem Stichtag sind im erfassten Ist-Stand noch nicht enthalten.
    """
    flows = one(
        """
        SELECT COALESCE(SUM(money_cents), 0) AS n FROM ledger
        WHERE cashbox_id = ? AND booked_on > ? AND booked_on <= ?
        """,
        (cashbox["id"], cashbox["opening_date"], as_of),
    )
    return cashbox["opening_balance_cents"] + int(flows["n"] if flows else 0)


def flows_after(cashbox_id, date):
    row = one(
        "SELECT COALESCE(SUM(money_cents), 0) AS n FROM ledger WHERE cashbox_id = ? AND booked_on > ?",
        (cashbox_id, date),
    )
    return int(row["n"] if row else 0)


def metrics(cashbox):
    cashbox_id = cashbox["id"]
    balances = list(cashbox_balances(cashbox_id).values())
    soll = sum(balances)
    positive = sum(v for v in balances if v > 0)
    negative = sum(v for v in balances if v < 0)
    minus_count = sum(1 for v in balances if v < 0)
    snap = last_snapshot(cashbox_id)
    ist = snap["amount_cents"] if snap else cashbox["opening_balance_cents"]
    ist_date = snap["booked_on"] if snap else cashbox["opening_date"]
    surplus = ist - soll
    available = ist - positive
    expenses = open_expenses(cashbox_id)
    erwartet = expected_balance(cashbox, ist_date)
    deviation = erwartet - ist
    active = one("SELECT COUNT(*) AS n FROM members WHERE cashbox_id = ? AND active = 1", (cashbox_id,))
    total = one("SELECT COUNT(*) AS n FROM members WHERE cashbox_id = ?", (cashbox_id,))
    return {
        "memberCount": int(active["n"] if active else 0),
        "totalMemberCount": int(total["n"] if total else 0),
        "sollCents": soll,
        "istCents": ist,
        "istDate": ist_date,
        "surplusCents": surplus,
        "availableCents": available,
        "liabilityCents": positive,
        "receivableCents": negative,
        "minusCount": minus_count,
        "openExpenseCents": expenses,
        "availableAfterExpensesCents": available - expenses,
        "expectedCents": erwartet,
        "expectedDate": ist_date,
        "flowsSinceIstCents": flows_after(cashbox_id, ist_date),
        "deviationCents": deviation,
        "writeoffCents": writeoff_total(cashbox_id),
    }


def surplus_history(cashbox):
    """Überschuss je erfasstem Kontostand — jeweils gegen das Soll von diesem Tag."""
    snaps = rows(
        """
        SELECT booked_on, amount_cents FROM account_snapshots
        WHERE cashbox_id = ?
        ORDER BY booked_on, id
        """,
        (cashbox["id"],),
    )
    points = [(cashbox["opening_date"], cashbox["opening_balance_cents"])]
    points += [(snap["booked_on"], snap["amount_cents"]) for snap in snaps]
    history = []
    for date, ist in points:
        soll = soll_on(cashbox["id"], date)
        history.append({"date": date, "istCents": ist, "sollCents": soll, "surplusCents": ist - soll})
    return history


def purchase_status(purchase):
    paid_row = one(
        "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM reimbursements WHERE purchase_id = ?",
        (purchase["id"],),
    )
    paid = int(paid_row["n"])
    rest = purchase["receipt_cents"] - paid
    if paid <= 0:
        status = "open"
    elif rest <= 0:
        status = "settled"
    else:
        status = "partial"
    return {"paidCents": paid, "restCents": max(rest, 0), "status": status}
