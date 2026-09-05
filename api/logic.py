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


def money_total(cashbox_id):
    row = one(
        "SELECT COALESCE(SUM(money_cents), 0) AS n FROM ledger WHERE cashbox_id = ?",
        (cashbox_id,),
    )
    return int(row["n"] if row else 0)


def expected_now(cashbox):
    """Betrag, der in diesem Moment auf dem Konto liegen muss.

    Anfangsbestand plus alles Geld, das seither hereinkam oder herausging. Was
    beim Anlegen schon im Anfangsbestand steckte, ist als nicht geldwirksam
    erfasst und zählt hier deshalb nicht doppelt.

    Das ist der Kontrollwert: stimmt er nicht mit dem echten Konto überein,
    fehlt Geld oder eine Buchung.
    """
    return cashbox["opening_balance_cents"] + money_total(cashbox["id"])


def expected_balance(cashbox, as_of):
    """Kontostand, der am Stichtag auf dem Konto liegen müsste.

    Gerechnet wird wie bei `expected_now`, nur bis zum Stichtag. Auch
    Bewegungen am Tag des Anfangsbestandes zählen mit: was schon im
    Anfangsbestand steckt, ist als nicht geldwirksam erfasst. Bewegungen nach
    dem Stichtag bleiben draußen, sie sind im erfassten Stand noch nicht drin.
    """
    flows = one(
        """
        SELECT COALESCE(SUM(money_cents), 0) AS n FROM ledger
        WHERE cashbox_id = ? AND booked_on <= ?
        """,
        (cashbox["id"], as_of),
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
    # Überschuss und Verfügbarkeit rechnen gegen den errechneten Kontostand,
    # nicht gegen den letzten erfassten. Sonst fällt der Überschuss jedes Mal,
    # wenn jemand seine Schulden zahlt, obwohl das Geld gerade hereinkam.
    kontostand = expected_now(cashbox)
    surplus = kontostand - soll
    available = kontostand - positive
    expenses = open_expenses(cashbox_id)
    erwartet = expected_balance(cashbox, ist_date)
    # Ohne erfassten Kontostand gibt es nichts zu vergleichen.
    deviation = erwartet - ist if snap else 0
    active = one("SELECT COUNT(*) AS n FROM members WHERE cashbox_id = ? AND active = 1", (cashbox_id,))
    total = one("SELECT COUNT(*) AS n FROM members WHERE cashbox_id = ?", (cashbox_id,))
    return {
        "memberCount": int(active["n"] if active else 0),
        "totalMemberCount": int(total["n"] if total else 0),
        "sollCents": soll,
        "accountNowCents": kontostand,
        "hasSnapshot": bool(snap),
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
    """Überschuss zu jedem erfassten Kontostand.

    Gerechnet wird wie in der Übersicht: errechneter Kontostand minus
    Kassen-Soll. Dazu steht, was an dem Tag wirklich auf dem Konto lag und wie
    groß die Lücke war.
    """
    snaps = rows(
        """
        SELECT booked_on, amount_cents FROM account_snapshots
        WHERE cashbox_id = ?
        ORDER BY booked_on, id
        """,
        (cashbox["id"],),
    )
    history = []
    for snap in snaps:
        date = snap["booked_on"]
        soll = soll_on(cashbox["id"], date)
        erwartet = expected_balance(cashbox, date)
        history.append(
            {
                "date": date,
                "istCents": snap["amount_cents"],
                "expectedCents": erwartet,
                "sollCents": soll,
                "surplusCents": erwartet - soll,
                "deviationCents": erwartet - snap["amount_cents"],
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
