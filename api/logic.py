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


def expected_balance(cashbox):
    flows = one(
        "SELECT COALESCE(SUM(money_cents), 0) AS n FROM ledger WHERE cashbox_id = ?",
        (cashbox["id"],),
    )
    return cashbox["opening_balance_cents"] + int(flows["n"] if flows else 0)


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
    erwartet = expected_balance(cashbox)
    deviation = erwartet - ist
    members = one("SELECT COUNT(*) AS n FROM members WHERE cashbox_id = ?", (cashbox_id,))
    return {
        "memberCount": int(members["n"] if members else 0),
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
        "deviationCents": deviation,
        "writeoffCents": writeoff_total(cashbox_id),
    }


def surplus_history(cashbox):
    balances = list(cashbox_balances(cashbox["id"]).values())
    soll = sum(balances)
    snaps = rows(
        """
        SELECT booked_on, amount_cents FROM account_snapshots
        WHERE cashbox_id = ?
        ORDER BY booked_on, id
        """,
        (cashbox["id"],),
    )
    history = [
        {
            "date": cashbox["opening_date"],
            "istCents": cashbox["opening_balance_cents"],
            "surplusCents": cashbox["opening_balance_cents"] - soll,
        }
    ]
    for snap in snaps:
        history.append(
            {
                "date": snap["booked_on"],
                "istCents": snap["amount_cents"],
                "surplusCents": snap["amount_cents"] - soll,
            }
        )
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
