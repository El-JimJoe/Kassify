const TOKEN_KEY = "kassify-session";
const API = "/api";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  me: null,
  boxId: null,
  view: "login",
  params: {},
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function todayDE() {
  const d = new Date();
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function isoToDE(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  if (!d) return iso;
  return `${d}.${m}.${y}`;
}

function parseDE(value) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(value).trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function euro(cents) {
  const n = Number(cents || 0);
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")} €`;
}

function parseEuro(value) {
  const raw = String(value || "").trim().replace(/\s/g, "").replace(/€/g, "");
  if (!raw) return 0;
  const neg = raw.startsWith("-") || raw.startsWith("−");
  const clean = raw.replace(/^[-−]/, "").replace(/\./g, "").replace(",", ".");
  const [whole, frac = "0"] = clean.split(".");
  const cents = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
}

function canWrite() {
  return state.me && state.me.role !== "reader";
}

function isAdmin() {
  return state.me && state.me.role === "admin";
}

function el(html) {
  const box = document.createElement("div");
  box.innerHTML = html.trim();
  return box.firstElementChild;
}

function view() {
  return document.getElementById("view");
}

function setBanner(text) {
  const banner = document.getElementById("banner");
  banner.hidden = !text;
  banner.textContent = text || "";
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (res.status === 401) {
    if (state.view !== "login" && state.view !== "setup") {
      state.token = "";
      localStorage.removeItem(TOKEN_KEY);
      go("login");
    }
    throw new Error(payload.error || "Bitte anmelden.");
  }
  if (!res.ok) throw new Error(payload.error || "Fehler");
  return payload;
}

function go(name, params = {}) {
  state.view = name;
  state.params = params;
  if (params.boxId) state.boxId = params.boxId;
  render();
}

function field(label, name, value, extra = "") {
  return `<label class="field">${label}<input name="${name}" value="${esc(value || "")}" ${extra} /></label>`;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function dateField(label, name, iso) {
  return field(label, name, isoToDE(iso) || todayDE(), `inputmode="numeric" placeholder="TT.MM.JJJJ"`);
}

function moneyField(label, name, cents = "", extra = "") {
  const shown = cents === "" || cents == null ? "" : euro(cents).replace(" €", "");
  return `<label class="field">${label}<input name="${name}" value="${esc(shown)}" inputmode="decimal" placeholder="0,00" ${extra} /></label>`;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function requireDate(value) {
  const iso = parseDE(value);
  if (!iso) throw new Error("Datum als TT.MM.JJJJ eintragen.");
  return iso;
}

const KIND = {
  start: "Startguthaben",
  deposit: "Einzahlung",
  payout: "Auszahlung",
  writeoff: "Ausfall",
  correction: "Korrektur",
  drink: "Getränk",
  drink_correction: "Getränk · Korrektur",
  drink_void: "Getränk · Storno",
  reimbursement: "Erstattung",
};

function renderNav() {
  const nav = document.getElementById("nav");
  const actions = document.getElementById("top-actions");
  const subtitle = document.getElementById("subtitle");
  if (!state.me) {
    nav.hidden = true;
    actions.replaceChildren();
    subtitle.textContent = "Gemeinschaftskasse";
    return;
  }
  subtitle.textContent = state.me.cashboxName || (isAdmin() ? "Admin" : "Kasse");
  actions.replaceChildren();
  const out = document.createElement("button");
  out.className = "ghost";
  out.textContent = "Abmelden";
  out.addEventListener("click", async () => {
    try {
      await api("/logout", { method: "POST", body: "{}" });
    } catch {
      /* still leave */
    }
    state.token = "";
    state.me = null;
    localStorage.removeItem(TOKEN_KEY);
    go("login");
  });
  actions.appendChild(out);

  if (!state.boxId && isAdmin()) {
    nav.hidden = true;
    return;
  }
  const items = [
    ["home", "Übersicht"],
    ["members", "Mitglieder"],
    ["drinks", "Erfassen", canWrite()],
    ["pay", "Einzahlung", canWrite()],
    ["events", "Vorgänge"],
    ["account", "Konto"],
    ["purchases", "Einkäufe"],
    ["reminders", "Mahnliste", canWrite()],
    ["backup", "Sicherung", isAdmin()],
    ["csv", "CSV", canWrite()],
    ["manage", "Kasse", isAdmin()],
    ["boxes", "Kassen", isAdmin()],
  ].filter((item) => item[2] !== false);
  nav.hidden = false;
  nav.replaceChildren();
  for (const [id, label] of items) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.className = state.view === id ? "active" : "";
    btn.addEventListener("click", () => go(id, { boxId: state.boxId }));
    nav.appendChild(btn);
  }
}

async function boot() {
  const health = await api("/health");
  if (health.setupRequired) {
    go("setup");
    return;
  }
  if (!state.token) {
    go("login");
    return;
  }
  try {
    state.me = await api("/me");
    if (state.me.role !== "admin") state.boxId = state.me.cashboxId;
    if (state.me.role === "admin" && !state.boxId) go("boxes");
    else go("home", { boxId: state.boxId });
  } catch {
    go("login");
  }
}

function gate(title, inner) {
  return `<section class="gate"><h2>${title}</h2>${inner}</section>`;
}

function renderLogin() {
  view().innerHTML = gate(
    "Kassify",
    `<form id="login-form" class="stack">
      <label class="field">Passwort<input name="password" type="password" autocomplete="current-password" /></label>
      <p class="error" id="form-error" hidden></p>
      <button class="pay" type="submit">Anmelden</button>
    </form>`
  );
  bindForm("login-form", async (data) => {
    const res = await api("/login", { method: "POST", body: JSON.stringify({ password: data.password }) });
    await afterAuth(res);
  });
}

function renderSetup() {
  view().innerHTML = gate(
    "Admin-Passwort setzen",
    `<form id="setup-form" class="stack">
      <label class="field">Neues Passwort<input name="password" type="password" minlength="8" /></label>
      <button class="pay" type="submit">Einrichten</button>
    </form>`
  );
  bindForm("setup-form", async (data) => {
    const res = await api("/setup", { method: "POST", body: JSON.stringify({ password: data.password }) });
    await afterAuth(res);
  });
}

function afterAuth(res) {
  state.token = res.token;
  localStorage.setItem(TOKEN_KEY, res.token);
  return api("/me").then((me) => {
    state.me = me;
    if (me.role === "admin") go("boxes");
    else {
      state.boxId = me.cashboxId;
      go("home", { boxId: me.cashboxId });
    }
  });
}

function bindForm(id, handler) {
  const form = document.getElementById(id);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const err = form.querySelector("#form-error, .error");
    try {
      await handler(formData(form), form);
    } catch (error) {
      if (err) {
        err.hidden = false;
        err.textContent = error.message;
      } else setBanner(error.message);
    }
  });
}

async function renderBoxes() {
  const data = await api("/cashboxes");
  const cards = data.cashboxes
    .map(
      (box) => `<li><button class="row-btn card" data-id="${box.id}">
        <div class="row-split"><strong>${esc(box.name)}</strong><span>${box.memberCount} Mitglieder</span></div>
        <div class="row-split muted"><span>Soll ${euro(box.sollCents)}</span><span>Ist ${euro(box.istCents)}</span></div>
        <div class="row-split"><span>Überschuss</span><strong>${euro(box.surplusCents)}</strong></div>
      </button></li>`
    )
    .join("");
  view().innerHTML = `<section>
    <div class="catalog-head"><h2>Kassen</h2>${isAdmin() ? `<button class="ghost" id="new-box">Neue Kasse</button>` : ""}</div>
    <ul class="list">${cards || `<li class="empty">Noch keine Kasse.</li>`}</ul>
  </section>`;
  view().querySelectorAll("[data-id]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.boxId = Number(btn.dataset.id);
      state.me.cashboxName = data.cashboxes.find((b) => b.id === state.boxId)?.name;
      go("home", { boxId: state.boxId });
    })
  );
  document.getElementById("new-box")?.addEventListener("click", () => go("box-new"));
}

function renderBoxNew() {
  view().innerHTML = `<section class="stack" style="max-width:32rem">
    <h2>Neue Kasse</h2>
    <form id="box-form" class="stack">
      ${field("Bezeichnung", "name")}
      ${moneyField("Getränkepreis", "drinkPrice", 100)}
      ${field("Kontobezeichnung", "accountName")}
      ${field("Link zum Konto", "accountUrl")}
      ${moneyField("Anfangsbestand", "opening")}
      ${dateField("Datum Anfangsbestand", "openingDate")}
      ${field("Herkunft", "openingSource", "", `placeholder="z. B. PayPal-Stand"`)}
      <label class="field"><span><input type="checkbox" name="feeFree" checked /> Zahlungen kommen gebührenfrei an</span></label>
      <p class="hint">Nur eintragen, was wirklich auf dem Konto lag.</p>
      <p class="error" id="form-error" hidden></p>
      <button class="pay" type="submit">Anlegen</button>
    </form>
  </section>`;
  bindForm("box-form", async (data, form) => {
    if (!form.feeFree.checked) throw new Error("Zahlungen mit Gebührenabzug werden in dieser Version nicht unterstützt.");
    const box = await api("/cashboxes", {
      method: "POST",
      body: JSON.stringify({
        name: data.name,
        drinkPriceCents: parseEuro(data.drinkPrice),
        accountName: data.accountName,
        accountUrl: data.accountUrl,
        openingBalanceCents: parseEuro(data.opening),
        openingDate: requireDate(data.openingDate),
        openingSource: data.openingSource,
        feeFree: true,
      }),
    });
    state.boxId = box.id;
    go("home", { boxId: box.id });
  });
}

function metricCard(label, cents, warn = false) {
  return `<div class="metric${warn ? " warn" : ""}"><span>${label}</span><strong>${euro(cents)}</strong></div>`;
}

async function renderHome() {
  const box = await api(`/cashboxes/${state.boxId}`);
  state.me.cashboxName = box.name;
  const stale = daysAgo(box.istDate) > 28;
  const backupStale = state.me.lastBackupAt && daysAgo(state.me.lastBackupAt.slice(0, 10)) > 28;
  if (stale) setBanner(`Ist-Kontostand vom ${isoToDE(box.istDate)} — älter als vier Wochen.`);
  else if (isAdmin() && backupStale) setBanner("Letzter Export ist länger her. Sicherung anfertigen.");
  const deviation = box.deviationCents !== 0;
    view().innerHTML = `<section>
    <div class="catalog-head"><h2>${esc(box.name)}</h2><p>${box.memberCount} Mitglieder · ${box.minusCount} im Minus</p></div>
    <div class="metrics">
      ${metricCard("Kassen-Soll", box.sollCents)}
      ${metricCard("Ist-Kontostand", box.istCents)}
      ${metricCard("Überschuss", box.surplusCents)}
      ${metricCard("Verfügbar", box.availableCents)}
      ${metricCard("Verbindlichkeit", box.liabilityCents)}
      ${metricCard("Forderung", box.receivableCents)}
      ${metricCard("Offene Auslagen", box.openExpenseCents)}
      ${metricCard("Verfügbar nach Auslagen", box.availableAfterExpensesCents)}
      ${metricCard("Erwartet", box.expectedCents)}
      ${metricCard("Abweichung", box.deviationCents, deviation)}
      ${metricCard("Ausfälle", box.writeoffCents)}
    </div>
    <p><button class="ghost" type="button" id="kick-sessions">Andere Geräte abmelden</button></p>
  </section>`;
  document.getElementById("kick-sessions").addEventListener("click", async () => {
    try {
      const data = await api("/sessions");
      for (const session of data.sessions) {
        if (!session.revoked && session.id !== data.currentId) {
          await api("/sessions/revoke", { method: "POST", body: JSON.stringify({ sessionId: session.id }) });
        }
      }
      setBanner("Andere Sitzungen sind beendet.");
    } catch (error) {
      setBanner(error.message);
    }
  });
}

function daysAgo(iso) {
  if (!iso) return 999;
  const then = new Date(iso.slice(0, 10));
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}

async function renderMembers() {
  const data = await api(`/cashboxes/${state.boxId}/members`);
  const minusOnly = state.params.minus;
  let items = data.members;
  if (minusOnly) items = items.filter((m) => m.balanceCents < 0);
  items.sort((a, b) => a.name.localeCompare(b.name, "de"));
  const soll = items.reduce((s, m) => s + m.balanceCents, 0);
  const pos = items.reduce((s, m) => s + Math.max(m.balanceCents, 0), 0);
  const neg = items.reduce((s, m) => s + Math.min(m.balanceCents, 0), 0);
  view().innerHTML = `<section>
    <div class="catalog-head">
      <h2>Mitglieder</h2>
      ${canWrite() ? `<button class="ghost" id="add-member">Mitglied hinzufügen</button>` : ""}
    </div>
    <div class="stack">
      <button class="ghost" id="filter-minus">${minusOnly ? "Alle zeigen" : "Nur Minusstände"}</button>
    </div>
    <ul class="list" id="member-list">
      ${items
        .map((m) => {
          const minus = m.balanceCents < 0;
          return `<li><button class="row-btn" data-id="${m.id}">
            <div class="row-split">
              <strong>${esc(m.name)}${m.active ? "" : " · inaktiv"}</strong>
              <span class="${minus ? "minus" : ""}">${minus ? "⚠ " : ""}${euro(m.balanceCents)}</span>
            </div>
          </button></li>`;
        })
        .join("")}
    </ul>
    <div class="row grand"><span>Soll / Verbindlichkeit / Forderung</span><strong>${euro(soll)} · ${euro(pos)} · ${euro(neg)}</strong></div>
  </section>`;
  document.getElementById("add-member")?.addEventListener("click", () => go("member-new", { boxId: state.boxId }));
  document.getElementById("filter-minus").addEventListener("click", () => go("members", { boxId: state.boxId, minus: !minusOnly }));
  view().querySelectorAll("[data-id]").forEach((btn) =>
    btn.addEventListener("click", () => go("member", { boxId: state.boxId, memberId: Number(btn.dataset.id) }))
  );
}

function renderMemberNew() {
  view().innerHTML = `<section class="stack" style="max-width:32rem">
    <h2>Mitglied hinzufügen</h2>
    <form id="member-form" class="stack">
      ${field("Anzeigename", "name")}
      ${field("Kürzel", "shortName")}
      ${field("Notiz", "note")}
      ${moneyField("Startguthaben (optional)", "start")}
      <p class="hint">Startguthaben nur eintragen, wenn das Geld wirklich schon auf dem Konto liegt.</p>
      ${dateField("Datum", "date")}
      <p class="error" id="form-error" hidden></p>
      <button class="pay" type="submit">Speichern</button>
    </form>
  </section>`;
  bindForm("member-form", async (data) => {
    await api(`/cashboxes/${state.boxId}/members`, {
      method: "POST",
      body: JSON.stringify({
        name: data.name,
        shortName: data.shortName,
        note: data.note,
        startBalanceCents: parseEuro(data.start),
        date: requireDate(data.date),
      }),
    });
    go("members", { boxId: state.boxId });
  });
}

async function renderMember() {
  const member = await api(`/cashboxes/${state.boxId}/members/${state.params.memberId}`);
  const tab = state.params.tab || "overview";
  const minus = member.balanceCents < 0;
  let body = "";
  if (tab === "ledger") {
    body = `<ul class="list">${member.ledger
      .map((e) => {
        const tag = e.kind.includes("correction") || e.kind.includes("void") || e.kind === "correction" ? " · Korrektur/Storno" : "";
        return `<li>
          <div class="row-split"><strong>${isoToDE(e.booked_on)} · ${KIND[e.kind] || e.kind}${tag}</strong><span>${euro(e.amount_cents)}</span></div>
          <div class="muted">${esc(e.note || "")} · Saldo ${euro(e.runningCents)}</div>
        </li>`;
      })
      .join("")}</ul>`;
  } else if (tab === "audit") {
    body = auditList(member.audit);
  } else {
    body = `<div class="stack">
      <p class="${minus ? "minus" : ""}">${minus ? "⚠ " : ""}Guthaben ${euro(member.balanceCents)}</p>
      <p class="muted">${esc(member.short_name || "")} ${esc(member.note || "")}</p>
      ${
        canWrite()
          ? `<form id="deposit-form" class="stack">
              ${moneyField("Einzahlung", "amount")}
              ${dateField("Datum", "date")}
              ${field("Referenz", "note")}
              <button class="pay" type="submit">Einzahlung speichern</button>
            </form>
            <form id="corr-form" class="stack">
              ${moneyField("Korrektur (+/−)", "amount")}
              ${dateField("Datum", "date")}
              ${field("Begründung", "note")}
              <button class="ghost" type="submit">Korrektur buchen</button>
            </form>
            <form id="settle-form" class="stack">
              <label class="field">Saldo ausgleichen
                <select name="reason">
                  <option value="payout">Auszahlung (positiver Saldo)</option>
                  <option value="deposit">Einzahlung (negativer Saldo)</option>
                  <option value="writeoff">Ausfall (kein Geld)</option>
                </select>
              </label>
              <p class="hint">Die App bewegt kein Geld. Zahlung muss real erfolgen. Ausfall mindert den Überschuss und ist keine Geldbewegung.</p>
              ${dateField("Datum", "date")}
              ${field("Begründung bei Ausfall", "note")}
              <button class="ghost" type="submit">Auf 0,00 € setzen</button>
            </form>
            <form id="edit-form" class="stack">
              ${field("Name", "name", member.name)}
              ${field("Kürzel", "shortName", member.short_name)}
              ${field("Notiz", "note", member.note)}
              <button class="ghost" type="submit">Stammdaten speichern</button>
            </form>
            <button class="ghost" id="toggle-active">${member.active ? "Deaktivieren" : "Reaktivieren"}</button>`
          : ""
      }
    </div>`;
  }
  view().innerHTML = `<section>
    <div class="catalog-head"><h2>${esc(member.name)}</h2></div>
    <div class="tabs">
      <button data-tab="overview" class="${tab === "overview" ? "active ghost" : "ghost"}">Übersicht</button>
      <button data-tab="ledger" class="${tab === "ledger" ? "active ghost" : "ghost"}">Buchungen</button>
      <button data-tab="audit" class="${tab === "audit" ? "active ghost" : "ghost"}">Protokoll</button>
    </div>
    ${body}
    <p class="error" id="form-error" hidden></p>
  </section>`;
  view().querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => go("member", { boxId: state.boxId, memberId: member.id, tab: btn.dataset.tab }))
  );
  if (tab === "overview" && canWrite()) {
    bindForm("deposit-form", async (data) => {
      await api(`/cashboxes/${state.boxId}/members/${member.id}/deposit`, {
        method: "POST",
        body: JSON.stringify({ amountCents: parseEuro(data.amount), date: requireDate(data.date), note: data.note }),
      });
      go("member", { boxId: state.boxId, memberId: member.id });
    });
    bindForm("corr-form", async (data) => {
      await api(`/cashboxes/${state.boxId}/members/${member.id}/correction`, {
        method: "POST",
        body: JSON.stringify({ amountCents: parseEuro(data.amount), date: requireDate(data.date), note: data.note }),
      });
      go("member", { boxId: state.boxId, memberId: member.id });
    });
    bindForm("settle-form", async (data) => {
      await api(`/cashboxes/${state.boxId}/members/${member.id}/settle`, {
        method: "POST",
        body: JSON.stringify({ reason: data.reason, date: requireDate(data.date), note: data.note }),
      });
      go("member", { boxId: state.boxId, memberId: member.id });
    });
    bindForm("edit-form", async (data) => {
      await api(`/cashboxes/${state.boxId}/members/${member.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: data.name, shortName: data.shortName, note: data.note }),
      });
      go("member", { boxId: state.boxId, memberId: member.id });
    });
    document.getElementById("toggle-active").addEventListener("click", async () => {
      const path = member.active ? "deactivate" : "reactivate";
      try {
        await api(`/cashboxes/${state.boxId}/members/${member.id}/${path}`, { method: "POST", body: "{}" });
        go("member", { boxId: state.boxId, memberId: member.id });
      } catch (error) {
        setBanner(error.message);
      }
    });
  }
}

function auditList(items) {
  if (!items?.length) return `<p class="empty">Keine Einträge.</p>`;
  return `<ul class="list">${items
    .map((e) => `<li>
      <div class="row-split"><strong>${isoToDE(e.created_at)} · ${esc(e.role)} · ${esc(e.action)}</strong></div>
      <div class="muted">vorher: ${esc(e.before_json || "—")}</div>
      <div class="muted">nachher: ${esc(e.after_json || "—")}</div>
    </li>`)
    .join("")}</ul>`;
}

async function renderPay() {
  const members = (await api(`/cashboxes/${state.boxId}/members`)).members.filter((m) => m.active);
  view().innerHTML = `<section class="stack" style="max-width:32rem">
    <h2>Einzahlung</h2>
    <input class="field search" id="pay-search" placeholder="Mitglied suchen" />
    <div id="pay-hits" class="list"></div>
    <form id="pay-form" class="stack" hidden>
      <p id="pay-who"></p>
      ${moneyField("Betrag", "amount")}
      ${dateField("Datum", "date")}
      ${field("Referenz", "note")}
      <button class="pay" type="submit">Speichern</button>
    </form>
    <p class="error" id="form-error" hidden></p>
  </section>`;
  let chosen = null;
  const hits = document.getElementById("pay-hits");
  const form = document.getElementById("pay-form");
  function show(filter) {
    const q = filter.trim().toLowerCase();
    hits.replaceChildren();
    members
      .filter((m) => !q || m.name.toLowerCase().includes(q) || (m.short_name || "").toLowerCase().includes(q))
      .forEach((m) => {
        const btn = el(`<button class="row-btn card" type="button"><div class="row-split"><strong>${esc(m.name)}</strong><span>${euro(m.balanceCents)}</span></div></button>`);
        btn.addEventListener("click", () => {
          chosen = m;
          document.getElementById("pay-who").textContent = m.name;
          form.hidden = false;
        });
        hits.appendChild(btn);
      });
  }
  document.getElementById("pay-search").addEventListener("input", (e) => show(e.target.value));
  show("");
  bindForm("pay-form", async (data) => {
    if (!chosen) throw new Error("Mitglied wählen.");
    await api(`/cashboxes/${state.boxId}/members/${chosen.id}/deposit`, {
      method: "POST",
      body: JSON.stringify({ amountCents: parseEuro(data.amount), date: requireDate(data.date), note: data.note }),
    });
    go("member", { boxId: state.boxId, memberId: chosen.id });
  });
}

async function renderDrinks() {
  const members = (await api(`/cashboxes/${state.boxId}/members`)).members.filter((m) => m.active);
  const box = await api(`/cashboxes/${state.boxId}`);
  const eventId = state.params.eventId;
  let existing = null;
  if (eventId) existing = await api(`/cashboxes/${state.boxId}/drinks/${eventId}`);
  const qtys = {};
  if (existing) existing.lines.forEach((l) => (qtys[l.memberId] = l.qty));
  view().innerHTML = `<section>
    <div class="catalog-head"><h2>${existing ? "Vorgang ändern" : "Getränke"}</h2><p>${euro(box.drink_price_cents)} / Strich</p></div>
    <form id="drink-form">
      ${dateField("Datum", "date", existing?.booked_on)}
      ${field("Bezeichnung", "label", existing?.label || "", `placeholder="z. B. Treffen"`)}
      <div id="drink-list"></div>
      <div class="sticky-sum">
        <div class="row grand"><span id="drink-sum">0 Striche = 0,00 €</span></div>
        ${canWrite() ? `<button class="pay" type="submit">Speichern</button>` : ""}
        ${existing && canWrite() ? `<button class="ghost" type="button" id="void-event">Stornieren</button>` : ""}
        <p class="error" id="form-error" hidden></p>
      </div>
    </form>
  </section>`;
  const list = document.getElementById("drink-list");
  const counts = {};
  members.forEach((m) => (counts[m.id] = qtys[m.id] || 0));
  function draw() {
    list.replaceChildren();
    members.forEach((m) => {
      const row = el(`<div class="drink-row">
        <div class="who"><strong>${esc(m.name)}</strong><span class="bal ${m.balanceCents < 0 ? "minus" : ""}">${m.balanceCents < 0 ? "⚠ " : ""}${euro(m.balanceCents)}</span></div>
        <div class="qty">
          <button type="button" data-act="dec">−</button>
          <input class="qty-input" inputmode="numeric" value="${counts[m.id]}" />
          <button type="button" data-act="inc">+</button>
        </div>
        <strong>${euro(counts[m.id] * box.drink_price_cents)}</strong>
      </div>`);
      const input = row.querySelector("input");
      const sync = () => {
        counts[m.id] = Math.max(0, Number(input.value || 0));
        input.value = String(counts[m.id]);
        sum();
        row.querySelector("strong:last-child").textContent = euro(counts[m.id] * box.drink_price_cents);
      };
      row.querySelector('[data-act="dec"]').addEventListener("click", () => {
        counts[m.id] = Math.max(0, counts[m.id] - 1);
        input.value = String(counts[m.id]);
        sync();
      });
      row.querySelector('[data-act="inc"]').addEventListener("click", () => {
        counts[m.id] += 1;
        input.value = String(counts[m.id]);
        sync();
      });
      input.addEventListener("input", sync);
      list.appendChild(row);
    });
    sum();
  }
  function sum() {
    const qty = Object.values(counts).reduce((s, n) => s + n, 0);
    const people = Object.values(counts).filter((n) => n > 0).length;
    document.getElementById("drink-sum").textContent = `${qty} Striche = ${euro(qty * box.drink_price_cents)}, ${people} Personen`;
  }
  draw();
  bindForm("drink-form", async (data) => {
    const lines = Object.entries(counts)
      .filter(([, qty]) => qty > 0)
      .map(([memberId, qty]) => ({ memberId: Number(memberId), qty }));
    if (!lines.length) throw new Error("Keine Striche erfasst.");
    const payload = { date: requireDate(data.date), label: data.label, lines };
    if (eventId) await api(`/cashboxes/${state.boxId}/drinks/${eventId}`, { method: "PUT", body: JSON.stringify(payload) });
    else await api(`/cashboxes/${state.boxId}/drinks`, { method: "POST", body: JSON.stringify(payload) });
    go("events", { boxId: state.boxId });
  });
  document.getElementById("void-event")?.addEventListener("click", async () => {
    try {
      await api(`/cashboxes/${state.boxId}/drinks/${eventId}/void`, { method: "POST", body: "{}" });
      go("events", { boxId: state.boxId });
    } catch (error) {
      setBanner(error.message);
    }
  });
}

async function renderEvents() {
  const data = await api(`/cashboxes/${state.boxId}/drinks`);
  view().innerHTML = `<section>
    <div class="catalog-head"><h2>Vorgänge</h2></div>
    <ul class="list">${
      data.events
        .map(
          (e) => `<li>
            <button class="row-btn ${e.status === "voided" ? "voided" : ""}" data-id="${e.id}">
              <div class="row-split"><strong>${isoToDE(e.booked_on)} ${esc(e.label || "")}</strong><span>${e.status === "voided" ? "STORNIERT" : euro(e.totalCents)}</span></div>
              <div class="muted">${e.qty} Striche · ${e.people} Personen</div>
            </button>
          </li>`
        )
        .join("") || `<li class="empty">Noch keine Vorgänge.</li>`
    }</ul>
  </section>`;
  view().querySelectorAll("[data-id]").forEach((btn) =>
    btn.addEventListener("click", () => go("drinks", { boxId: state.boxId, eventId: Number(btn.dataset.id) }))
  );
}

async function renderAccount() {
  const data = await api(`/cashboxes/${state.boxId}/snapshots`);
  const tab = state.params.tab || "overview";
  const link = data.account.url
    ? `<p><a href="${esc(data.account.url)}" target="_blank" rel="noopener">${esc(data.account.name || data.account.url)}</a></p>`
    : `<p class="muted">${esc(data.account.name || "Kein Konto-Link")}</p>`;
  let body = "";
  if (tab === "audit") body = auditList(data.audit);
  else {
    body = `${link}
      <div class="metrics">
        ${metricCard("Ist", data.metrics.istCents)}
        ${metricCard("Erwartet", data.metrics.expectedCents)}
        ${metricCard("Abweichung", data.metrics.deviationCents, data.metrics.deviationCents !== 0)}
        ${metricCard("Überschuss", data.metrics.surplusCents)}
      </div>
      <h3>Überschuss-Verlauf</h3>
      <ul class="list">${data.surplusHistory.map((h) => `<li class="row-split"><span>${isoToDE(h.date)}</span><strong>${euro(h.surplusCents)}</strong></li>`).join("")}</ul>
      ${
        canWrite()
          ? `<form id="snap-form" class="stack">
              <h3>Ist-Stand erfassen</h3>
              ${moneyField("Betrag", "amount")}
              ${dateField("Datum", "date")}
              ${field("Quelle", "source", "", `placeholder="PayPal-Screenshot"`)}
              ${field("Notiz", "note")}
              <button class="pay" type="submit">Stand speichern</button>
            </form>`
          : ""
      }
      <h3>Verlauf</h3>
      <ul class="list">${data.snapshots.map((s) => `<li class="row-split"><span>${isoToDE(s.booked_on)} · ${esc(s.source)}</span><strong>${euro(s.amount_cents)}</strong></li>`).join("")}</ul>`;
  }
  view().innerHTML = `<section>
    <div class="catalog-head"><h2>Konto</h2></div>
    <div class="tabs">
      <button class="ghost ${tab === "overview" ? "active" : ""}" data-tab="overview">Übersicht</button>
      <button class="ghost ${tab === "audit" ? "active" : ""}" data-tab="audit">Protokoll</button>
    </div>
    ${body}
    <p class="error" id="form-error" hidden></p>
  </section>`;
  view().querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => go("account", { boxId: state.boxId, tab: btn.dataset.tab }))
  );
  if (tab === "overview" && canWrite()) {
    bindForm("snap-form", async (data) => {
      await api(`/cashboxes/${state.boxId}/snapshots`, {
        method: "POST",
        body: JSON.stringify({
          amountCents: parseEuro(data.amount),
          date: requireDate(data.date),
          source: data.source,
          note: data.note,
        }),
      });
      go("account", { boxId: state.boxId });
    });
  }
}

async function renderPurchases() {
  if (state.params.purchaseId) return renderPurchaseDetail();
  const data = await api(`/cashboxes/${state.boxId}/purchases`);
  const status = { open: "offen", partial: "teilweise", settled: "erstattet" };
  view().innerHTML = `<section>
    <div class="catalog-head"><h2>Einkäufe</h2>${canWrite() ? `<button class="ghost" id="new-buy">Erfassen</button>` : ""}</div>
    <ul class="list">${
      data.purchases
        .map(
          (p) => `<li><button class="row-btn" data-id="${p.id}">
            <div class="row-split"><strong>${isoToDE(p.booked_on)} · ${esc(p.vendor)}</strong><span class="badge">${status[p.status]}</span></div>
            <div class="row-split muted"><span>${esc(p.description)}</span><span>${euro(p.receipt_cents)} · Rest ${euro(p.restCents)}</span></div>
          </button></li>`
        )
        .join("") || `<li class="empty">Keine Einkäufe.</li>`
    }</ul>
  </section>`;
  document.getElementById("new-buy")?.addEventListener("click", () => go("purchase-new", { boxId: state.boxId }));
  view().querySelectorAll("[data-id]").forEach((btn) =>
    btn.addEventListener("click", () => go("purchases", { boxId: state.boxId, purchaseId: Number(btn.dataset.id) }))
  );
}

function renderPurchaseNew() {
  view().innerHTML = `<section class="stack" style="max-width:32rem">
    <h2>Einkauf</h2>
    <form id="buy-form" class="stack">
      ${dateField("Datum", "date")}
      ${field("Händler", "vendor")}
      ${field("Was", "description")}
      ${moneyField("Bon-Endbetrag", "receipt")}
      <label class="field"><span><input type="checkbox" name="pfandGiven" /> Pfand abgegeben</span></label>
      ${moneyField("Pfandbetrag", "pfand")}
      ${field("Vorgestreckt von", "advancedBy", "MasterSven")}
      ${field("Notiz", "note")}
      <label class="field"><span><input type="checkbox" name="reimburseNow" checked /> Sofort in gleicher Höhe erstatten</span></label>
      ${dateField("Erstattungsdatum", "reimburseDate")}
      ${moneyField("Erstattungsbetrag (leer = Bon)", "reimburse")}
      ${field("Erstattungsreferenz", "reimburseRef")}
      <p class="error" id="form-error" hidden></p>
      <button class="pay" type="submit">Speichern</button>
    </form>
  </section>`;
  bindForm("buy-form", async (data, form) => {
    await api(`/cashboxes/${state.boxId}/purchases`, {
      method: "POST",
      body: JSON.stringify({
        date: requireDate(data.date),
        vendor: data.vendor,
        description: data.description,
        receiptCents: parseEuro(data.receipt),
        pfandGiven: form.pfandGiven.checked,
        pfandCents: parseEuro(data.pfand),
        advancedBy: data.advancedBy,
        note: data.note,
        reimburseNow: form.reimburseNow.checked,
        reimburseDate: data.reimburseDate ? requireDate(data.reimburseDate) : requireDate(data.date),
        reimburseCents: data.reimburse ? parseEuro(data.reimburse) : parseEuro(data.receipt),
        reimburseRef: data.reimburseRef,
      }),
    });
    go("purchases", { boxId: state.boxId });
  });
}

async function renderPurchaseDetail() {
  const p = await api(`/cashboxes/${state.boxId}/purchases/${state.params.purchaseId}`);
  const tab = state.params.tab || "overview";
  const eq = p.pfand_given
    ? `<p>Einkaufswert ${euro(p.goodsCents)} − Pfand ${euro(p.pfand_cents)} = Bon-Endbetrag ${euro(p.receipt_cents)}</p>`
    : `<p>Bon-Endbetrag ${euro(p.receipt_cents)}</p>`;
  let body =
    tab === "audit"
      ? auditList(p.audit)
      : `${eq}
        <p class="muted">${esc(p.vendor)} · ${esc(p.description)} · ${esc(p.advanced_by)}</p>
        <p>Status: ${p.status} · Rest ${euro(p.restCents)}</p>
        ${
          canWrite() && p.restCents > 0
            ? `<form id="payback-form" class="stack">
                ${moneyField("Erstattung", "amount", p.restCents)}
                ${dateField("Datum", "date")}
                ${field("Referenz", "reference")}
                <button class="pay" type="submit">Erstattung buchen</button>
              </form>`
            : ""
        }
        <ul class="list">${p.reimbursements.map((r) => `<li class="row-split"><span>${isoToDE(r.booked_on)} ${esc(r.reference)}</span><strong>${euro(r.amount_cents)}</strong></li>`).join("")}</ul>`;
  view().innerHTML = `<section>
    <div class="catalog-head"><h2>Einkauf ${isoToDE(p.booked_on)}</h2></div>
    <div class="tabs">
      <button class="ghost ${tab === "overview" ? "active" : ""}" data-tab="overview">Übersicht</button>
      <button class="ghost ${tab === "audit" ? "active" : ""}" data-tab="audit">Protokoll</button>
    </div>
    ${body}
    <p class="error" id="form-error" hidden></p>
  </section>`;
  view().querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => go("purchases", { boxId: state.boxId, purchaseId: p.id, tab: btn.dataset.tab }))
  );
  if (tab === "overview") {
    const form = document.getElementById("payback-form");
    if (form) {
      bindForm("payback-form", async (data) => {
        await api(`/cashboxes/${state.boxId}/purchases/${p.id}/reimburse`, {
          method: "POST",
          body: JSON.stringify({
            amountCents: parseEuro(data.amount),
            date: requireDate(data.date),
            reference: data.reference,
          }),
        });
        go("purchases", { boxId: state.boxId, purchaseId: p.id });
      });
    }
  }
}

async function renderReminders() {
  const data = await api(`/cashboxes/${state.boxId}/reminders`);
  const text = data.members.map((m) => `${m.name}: ${euro(m.balanceCents)}`).join("\n") || "Keine Minusstände.";
  view().innerHTML = `<section class="stack">
    <div class="catalog-head"><h2>Mahnliste</h2></div>
    <textarea class="copy-box" id="copy-text" readonly>${esc(text)}</textarea>
    <button class="pay" id="copy-btn" type="button">Liste kopieren</button>
  </section>`;
  document.getElementById("copy-btn").addEventListener("click", async () => {
    const value = document.getElementById("copy-text").value;
    try {
      await navigator.clipboard.writeText(value);
      setBanner("Liste kopiert.");
    } catch {
      document.getElementById("copy-text").select();
    }
  });
}

async function renderBackup() {
  view().innerHTML = `<section class="stack" style="max-width:36rem">
    <h2>Sicherung</h2>
    <p class="hint">Die Datei enthält Klarnamen, Salden und Zugänge. Nicht in Cloud, Chat oder Git legen. Passwörter stehen nicht im Klartext, ein Import in eine andere Instanz gibt aber vollen Zugriff.</p>
    <button class="pay" id="export-all" type="button">Gesamtexport</button>
    <button class="ghost" id="export-one" type="button">Diese Kasse exportieren</button>
    <form id="import-form" class="stack">
      <h3>Import</h3>
      <label class="field">Datei<input type="file" name="file" accept="application/json" /></label>
      <label class="field">Betriebsart
        <select name="mode">
          <option value="">Bitte wählen</option>
          <option value="restore">Wiederherstellen (ersetzt alles)</option>
          <option value="merge">Ergänzen (legt Kassen zusätzlich an)</option>
        </select>
      </label>
      <button class="ghost" type="submit">Vorschau</button>
    </form>
    <div id="preview"></div>
  </section>`;
  document.getElementById("export-all").addEventListener("click", () => downloadExport(""));
  document.getElementById("export-one").addEventListener("click", () => downloadExport(`?cashbox=${state.boxId}`));
  document.getElementById("import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = event.target.file.files[0];
    const mode = event.target.mode.value;
    if (!file || !mode) {
      setBanner("Datei und Betriebsart wählen.");
      return;
    }
    const backup = JSON.parse(await file.text());
    const preview = await api("/backup/preview", { method: "POST", body: JSON.stringify({ backup }) });
    const box = document.getElementById("preview");
    box.innerHTML = `<div class="card stack">
      ${preview.cashboxes.map((c) => `<p>${esc(c.name)} · ${c.memberCount} Mitglieder · Soll ${euro(c.sollCents)} ${c.exists ? "· Name existiert schon" : ""}</p>`).join("")}
      ${mode === "restore" ? `<p class="hint">Alles in der App wird ersetzt. Zuerst wird der aktuelle Bestand heruntergeladen.</p>
        <label class="field">Zur Bestätigung WIEDERHERSTELLEN eintippen<input name="confirm" id="confirm-word" /></label>` : `<p class="hint">Vorhandene Kassen bleiben. Namenskonflikte überspringen.</p>`}
      <button class="pay" type="button" id="run-import">Import ausführen</button>
    </div>`;
    document.getElementById("run-import").addEventListener("click", async () => {
      try {
        if (mode === "restore") {
          await downloadExport("");
          const payload = await api("/backup/import", {
            method: "POST",
            body: JSON.stringify({ backup, mode, confirmWord: document.getElementById("confirm-word").value }),
          });
          setBanner(`Import fertig. ${payload.summary.map((s) => s.name).join(", ")}`);
        } else {
          const payload = await api("/backup/import", {
            method: "POST",
            body: JSON.stringify({
              backup,
              mode: "merge",
              nameDecisions: Object.fromEntries(preview.cashboxes.filter((c) => c.exists).map((c) => [c.name, "skip"])),
            }),
          });
          setBanner(`Ergänzt: ${(payload.created || []).join(", ") || "nichts"}`);
        }
        go("boxes");
      } catch (error) {
        setBanner(error.message);
      }
    });
  });
}

async function downloadExport(query) {
  const res = await fetch(`${API}/backup/export${query}`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) throw new Error("Export fehlgeschlagen.");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `kassify-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function renderCsv() {
  view().innerHTML = `<section class="stack" style="max-width:32rem">
    <h2>Auswertungsexport</h2>
    <form id="csv-form" class="stack">
      ${dateField("Von", "from")}
      ${dateField("Bis", "to")}
      <button class="pay" type="submit">CSV laden</button>
    </form>
  </section>`;
  bindForm("csv-form", async (data) => {
    const from = requireDate(data.from);
    const to = requireDate(data.to);
    const res = await fetch(`${API}/backup/csv?cashbox=${state.boxId}&from=${from}&to=${to}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kassify-auswertung.csv";
    a.click();
  });
}

async function renderManage() {
  const box = await api(`/cashboxes/${state.boxId}`);
  const access = await api(`/cashboxes/${state.boxId}/access`);
  const audit = await api(`/cashboxes/${state.boxId}/audit`);
  const editor = access.accesses.find((a) => a.role === "editor");
  const reader = access.accesses.find((a) => a.role === "reader");
  view().innerHTML = `<section class="stack" style="max-width:36rem">
    <h2>Kassenverwaltung</h2>
    <form id="box-edit" class="stack">
      ${field("Bezeichnung", "name", box.name)}
      ${moneyField("Getränkepreis", "drinkPrice", box.drink_price_cents)}
      ${field("Kontobezeichnung", "accountName", box.account_name)}
      ${field("Link zum Konto", "accountUrl", box.account_url)}
      ${moneyField("Anfangsbestand", "opening", box.opening_balance_cents)}
      ${dateField("Datum Anfangsbestand", "openingDate", box.opening_date)}
      ${field("Herkunft", "openingSource", box.opening_source)}
      <label class="field"><span><input type="checkbox" name="feeFree" checked /> Zahlungen gebührenfrei</span></label>
      <button class="pay" type="submit">Speichern</button>
    </form>
    <form id="role-form" class="stack">
      <h3>Zugänge</h3>
      ${field("Editor-Passwort", "editorPassword", "", `type="password"`)}
      <label class="field"><span><input type="checkbox" name="editorOn" ${editor?.enabled ? "checked" : ""} /> Editor aktiv</span></label>
      ${field("Reader-Passwort", "readerPassword", "", `type="password"`)}
      <label class="field"><span><input type="checkbox" name="readerOn" ${reader?.enabled ? "checked" : ""} /> Reader aktiv</span></label>
      <button class="ghost" type="submit">Zugänge speichern</button>
    </form>
    <form id="del-form" class="stack">
      <h3>Kasse löschen</h3>
      <p class="hint">Endgültig. ${box.memberCount} Mitglieder, Soll ${euro(box.sollCents)}, Ist ${euro(box.istCents)}. Zuerst Export.</p>
      <button class="ghost" type="button" id="export-before">Export dieser Kasse</button>
      ${field("Vollständigen Kassennamen eintippen", "confirmName")}
      <button class="pay" type="submit">Unwiderruflich löschen</button>
    </form>
    <h3>Protokoll</h3>
    ${auditList(audit.audit)}
    <p class="error" id="form-error" hidden></p>
  </section>`;
  bindForm("box-edit", async (data, form) => {
    if (!form.feeFree.checked) throw new Error("Zahlungen mit Gebührenabzug werden in dieser Version nicht unterstützt.");
    await api(`/cashboxes/${state.boxId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: data.name,
        drinkPriceCents: parseEuro(data.drinkPrice),
        accountName: data.accountName,
        accountUrl: data.accountUrl,
        openingBalanceCents: parseEuro(data.opening),
        openingDate: requireDate(data.openingDate),
        openingSource: data.openingSource,
        feeFree: true,
      }),
    });
    go("manage", { boxId: state.boxId });
  });
  bindForm("role-form", async (data, form) => {
    if (data.editorPassword) {
      await api(`/cashboxes/${state.boxId}/access`, {
        method: "PUT",
        body: JSON.stringify({ role: "editor", password: data.editorPassword, enabled: form.editorOn.checked }),
      });
    } else {
      await api(`/cashboxes/${state.boxId}/access`, {
        method: "PUT",
        body: JSON.stringify({ role: "editor", enabled: form.editorOn.checked }),
      });
    }
    if (data.readerPassword) {
      await api(`/cashboxes/${state.boxId}/access`, {
        method: "PUT",
        body: JSON.stringify({ role: "reader", password: data.readerPassword, enabled: form.readerOn.checked }),
      });
    } else {
      await api(`/cashboxes/${state.boxId}/access`, {
        method: "PUT",
        body: JSON.stringify({ role: "reader", enabled: form.readerOn.checked }),
      });
    }
    go("manage", { boxId: state.boxId });
  });
  document.getElementById("export-before").addEventListener("click", () => downloadExport(`?cashbox=${state.boxId}`));
  bindForm("del-form", async (data) => {
    await downloadExport(`?cashbox=${state.boxId}`);
    await api(`/cashboxes/${state.boxId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmName: data.confirmName }),
    });
    state.boxId = null;
    go("boxes");
  });
}

async function render() {
  setBanner("");
  renderNav();
  try {
    const map = {
      login: renderLogin,
      setup: renderSetup,
      boxes: renderBoxes,
      "box-new": renderBoxNew,
      home: renderHome,
      members: renderMembers,
      "member-new": renderMemberNew,
      member: renderMember,
      pay: renderPay,
      events: renderEvents,
      account: renderAccount,
      purchases: renderPurchases,
      "purchase-new": renderPurchaseNew,
      reminders: renderReminders,
      backup: renderBackup,
      csv: renderCsv,
      manage: renderManage,
    };
    await (map[state.view] || renderHome)();
  } catch (error) {
    view().innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

boot();
