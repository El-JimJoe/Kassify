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

/* Protokolleinträge tragen einen Zeitstempel in UTC. Für die Anzeige zählt die
   Ortszeit samt Uhrzeit, sonst sind mehrere Änderungen am selben Tag nicht
   auseinanderzuhalten. */
function isoToDETime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return isoToDE(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* Nur echte Web-Adressen werden verlinkt. Ein als Kontolink gespeichertes
   "javascript:..." waere sonst mit einem Klick ausfuehrbar. */
function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
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
      // Auch die Rolle vergessen, sonst bleibt die Navigationsleiste der Kasse
      // über der Anmeldemaske stehen.
      state.token = "";
      state.me = null;
      state.boxId = null;
      localStorage.removeItem(TOKEN_KEY);
      go("login");
    }
    throw new Error(payload.error || "Bitte anmelden.");
  }
  if (!res.ok) throw new Error(payload.error || "Fehler");
  return payload;
}

let paintSeq = 0;

function go(name, params = {}) {
  state.view = name;
  state.params = params;
  if (params.boxId) state.boxId = params.boxId;
  render(++paintSeq);
}

function showIf(name, html) {
  if (state.view !== name) return false;
  view().innerHTML = html;
  return true;
}

function field(label, name, value, extra = "") {
  return `<label class="field">${label}<input name="${name}" value="${esc(value || "")}" ${extra} /></label>`;
}

/* Kontrollkästchen tragen bewusst nicht die Feldklasse: die zieht jede Eingabe
   auf volle Breite und schöbe den Text unter das Kästchen. */
function checkField(label, name, checked = false) {
  return `<label class="check"><input type="checkbox" name="${name}" ${
    checked ? "checked" : ""
  } /><span>${label}</span></label>`;
}

function pageHead(title, extra = "") {
  return `<div class="page-head"><h2>${title}</h2>${extra}</div>`;
}

/* Untertabs sehen überall gleich aus. `items` ist eine Liste aus Schlüssel und
   Beschriftung; leere Einträge lassen sich je nach Rolle weglassen. */
function tabBar(items, current) {
  return `<div class="tabs">${items
    .filter(Boolean)
    .map(
      ([key, label]) =>
        `<button class="ghost ${key === current ? "active" : ""}" data-tab="${key}">${label}</button>`
    )
    .join("")}</div>`;
}

/* Guthaben grün, Schulden rot samt Warnzeichen. */
function balanceSpan(cents, extra = "") {
  const cls = cents < 0 ? "minus" : cents > 0 ? "plus" : "";
  return `<span class="${[extra, cls].filter(Boolean).join(" ")}">${cents < 0 ? "⚠ " : ""}${euro(cents)}</span>`;
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

const PURCHASE_STATUS = { open: "offen", partial: "teilweise", settled: "erstattet" };

function renderNav() {
  const nav = document.getElementById("nav");
  const actions = document.getElementById("top-actions");
  const subtitle = document.getElementById("subtitle");
  if (!state.me) {
    nav.hidden = true;
    actions.replaceChildren();
    subtitle.textContent = state.view === "setup" ? "Ersteinrichtung" : "Anmeldung";
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
    ["drinks", "Erfassen"],
    ["pay", "Einzahlung", canWrite()],
    ["account", "Konto"],
    ["purchases", "Einkäufe"],
    ["reminders", "Mahnliste", canWrite()],
    ["backup", "Sicherung", isAdmin()],
    ["csv", "Auswertung", canWrite()],
    ["manage", "Kassenverwaltung", isAdmin()],
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
  try {
    let health;
    let lastError;
    for (let i = 0; i < 10; i++) {
      try {
        health = await api("/health");
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (!health) throw lastError || new Error("Server nicht erreichbar.");
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
  } catch (error) {
    setBanner(error.message || "Server nicht erreichbar.");
    go("login");
  }
}

function gate(title, inner) {
  return `<section class="gate"><h2>${title}</h2>${inner}</section>`;
}

async function submitPassword(password) {
  const health = await api("/health");
  const path = health.setupRequired ? "/setup" : "/login";
  return api(path, { method: "POST", body: JSON.stringify({ password }) });
}

function renderLogin() {
  showIf(
    "login",
    gate(
      "Kassify",
      `<form id="login-form" class="stack">
      <label class="field">Passwort<input name="password" type="password" autocomplete="current-password" /></label>
      <p class="error" id="form-error" hidden></p>
      <button class="pay" type="submit">Anmelden</button>
    </form>`
    )
  );
  bindForm("login-form", async (data) => {
    const res = await submitPassword(data.password);
    await afterAuth(res);
  });
}

function renderSetup() {
  showIf(
    "setup",
    gate(
      "Admin-Passwort setzen",
      `<p class="hint">Noch keine Kasse. Dieses Passwort merken, mindestens 8 Zeichen.</p>
    <form id="setup-form" class="stack">
      <label class="field">Neues Passwort<input name="password" type="password" minlength="8" autocomplete="new-password" /></label>
      <p class="error" id="form-error" hidden></p>
      <button class="pay" type="submit">Einrichten</button>
    </form>`
    )
  );
  bindForm("setup-form", async (data) => {
    const res = await submitPassword(data.password);
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
    // Enthält das Formular selbst keine Fehlerzeile, die der Seite verwenden.
    // Auf der Mitgliederseite liegt sie außerhalb der einzelnen Formulare.
    const err = form.querySelector("#form-error, .error") || view().querySelector("#form-error");
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
  if (state.view !== "boxes") return;
  const cards = data.cashboxes
    .map(
      (box) => `<li><button class="row-btn" data-id="${box.id}">
        <div class="row-split"><strong>${esc(box.name)}</strong><span>${box.memberCount} Mitglieder</span></div>
        <div class="row-split muted"><span>Kassen-Soll ${euro(box.sollCents)}</span><span>Konto ${euro(
        box.accountNowCents
      )}</span></div>
        <div class="row-split"><span>Überschuss</span><strong>${euro(box.surplusCents)}</strong></div>
      </button></li>`
    )
    .join("");
  if (
    !showIf(
      "boxes",
      `<section class="page">
    ${pageHead("Kassen", isAdmin() ? `<button class="ghost" id="new-box">Neue Kasse</button>` : "")}
    <ul class="list">${cards || `<li class="empty">Noch keine Kasse.</li>`}</ul>
  </section>`
    )
  )
    return;
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
  showIf(
    "box-new",
    `<section class="page">
    ${pageHead("Neue Kasse")}
    <form id="box-form" class="stack">
      ${field("Bezeichnung", "name")}
      ${moneyField("Getränkepreis", "drinkPrice", 100)}
      ${field("Kontobezeichnung", "accountName")}
      ${field("Link zum Konto", "accountUrl")}
      ${moneyField("Anfangsbestand", "opening")}
      ${dateField("Datum Anfangsbestand", "openingDate")}
      ${field("Herkunft", "openingSource", "", `placeholder="z. B. PayPal-Stand"`)}
      ${checkField("Zahlungen kommen gebührenfrei an", "feeFree", true)}
      <p class="hint">Nur eintragen, was wirklich auf dem Konto lag.</p>
      <p class="error" id="form-error" hidden></p>
      <button class="pay" type="submit">Anlegen</button>
    </form>
  </section>`
  );
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

/* Wie viele Minusstände die Übersicht auflistet. Der Rest steht unter
   „Mitglieder“, sonst schiebt eine lange Liste alle Kennzahlen aus dem Bild. */
const HOME_MINUS_SHOWN = 8;

async function renderHome() {
  const [box, memberData] = await Promise.all([
    api(`/cashboxes/${state.boxId}`),
    api(`/cashboxes/${state.boxId}/members`),
  ]);
  if (state.view !== "home") return;
  state.me.cashboxName = box.name;
  const debtors = memberData.members
    .filter((m) => m.balanceCents < 0)
    .sort((a, b) => a.balanceCents - b.balanceCents);
  const debt = debtors.reduce((s, m) => s + m.balanceCents, 0);
  const stale = daysAgo(box.istDate) > 28;
  const backupStale = state.me.lastBackupAt && daysAgo(state.me.lastBackupAt.slice(0, 10)) > 28;
  if (stale)
    setBanner(
      box.hasSnapshot
        ? `Kontostand zuletzt am ${isoToDE(box.istDate)} geprüft — älter als vier Wochen.`
        : "Es ist noch kein echter Kontostand erfasst."
    );
  else if (isAdmin() && backupStale) setBanner("Letzter Export ist länger her. Sicherung anfertigen.");
  const deviation = box.deviationCents !== 0;
  if (
    !showIf(
      "home",
      `<section class="page">
    ${pageHead(esc(box.name), `<p>${box.memberCount} Mitglieder · ${box.minusCount} im Minus</p>`)}
    <div class="metrics">
      ${metricCard("Kontostand jetzt", box.accountNowCents)}
      ${metricCard("Kassen-Soll", box.sollCents)}
      ${metricCard("Überschuss", box.surplusCents)}
      ${metricCard("Verfügbar", box.availableCents)}
      ${metricCard("Verbindlichkeit", box.liabilityCents)}
      ${metricCard("Forderung", box.receivableCents)}
      ${metricCard("Offene Auslagen", box.openExpenseCents)}
      ${metricCard("Verfügbar nach Auslagen", box.availableAfterExpensesCents)}
      ${metricCard("Ausfälle", box.writeoffCents)}
      ${
        box.hasSnapshot
          ? `${metricCard(`Zuletzt erfasst am ${isoToDE(box.istDate)}`, box.istCents)}
             ${metricCard("Abweichung", box.deviationCents, deviation)}`
          : ""
      }
    </div>
    <div class="stack">
      <p class="hint">„Kontostand jetzt“ ist der Anfangsbestand plus alle erfassten Geldbewegungen — so viel muss in diesem Moment auf dem Konto liegen. Weicht das echte Konto davon ab, fehlt Geld oder eine Buchung.</p>
      ${
        box.hasSnapshot
          ? box.flowsSinceIstCents
            ? `<p class="hint">Seit dem erfassten Stand vom ${isoToDE(box.istDate)} sind ${euro(
                box.flowsSinceIstCents
              )} bewegt worden.</p>`
            : ""
          : `<p class="hint">Es ist noch kein Kontostand erfasst. Trage unter „Konto“ ein, was wirklich auf dem Konto liegt, dann prüft die App die Abweichung.</p>`
      }
    </div>
    ${pageHead("Mitglieder im Minus", `<p>${euro(debt)} offen</p>`)}
    <ul class="list">${
      debtors
        .slice(0, HOME_MINUS_SHOWN)
        .map(
          (m) => `<li><button class="row-btn" data-member="${m.id}">
            <div class="row-split"><strong>${esc(m.name)}${
            m.active ? "" : " · inaktiv"
          }</strong>${balanceSpan(m.balanceCents)}</div>
          </button></li>`
        )
        .join("") || `<li class="empty">Niemand steht im Minus.</li>`
    }</ul>
    ${
      debtors.length > HOME_MINUS_SHOWN
        ? `<button class="ghost" type="button" id="all-minus">Alle ${debtors.length} Minusstände zeigen</button>`
        : ""
    }
    <button class="ghost" type="button" id="kick-sessions">Andere Geräte abmelden</button>
  </section>`
    )
  )
    return;
  view()
    .querySelectorAll("[data-member]")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        go("member", { boxId: state.boxId, memberId: Number(btn.dataset.member) })
      )
    );
  document
    .getElementById("all-minus")
    ?.addEventListener("click", () => go("members", { boxId: state.boxId, sort: "balanceAsc" }));
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

/* Reihenfolgen der Mitgliederliste. Bei Gleichstand im Guthaben entscheidet der
   Name, damit die Liste zwischen zwei Aufrufen nicht springt. */
const MEMBER_SORTS = {
  name: ["Name (A–Z)", (a, b) => a.name.localeCompare(b.name, "de")],
  nameDesc: ["Name (Z–A)", (a, b) => b.name.localeCompare(a.name, "de")],
  balanceAsc: ["Guthaben (niedrigstes zuerst)", (a, b) => a.balanceCents - b.balanceCents],
  balanceDesc: ["Guthaben (höchstes zuerst)", (a, b) => b.balanceCents - a.balanceCents],
};

async function renderMembers() {
  const data = await api(`/cashboxes/${state.boxId}/members`);
  if (state.view !== "members") return;
  const sort = MEMBER_SORTS[state.params.sort] ? state.params.sort : "name";
  const byName = MEMBER_SORTS.name[1];
  const items = data.members;
  items.sort((a, b) => MEMBER_SORTS[sort][1](a, b) || byName(a, b));
  const soll = items.reduce((s, m) => s + m.balanceCents, 0);
  const pos = items.reduce((s, m) => s + Math.max(m.balanceCents, 0), 0);
  const neg = items.reduce((s, m) => s + Math.min(m.balanceCents, 0), 0);
  if (
    !showIf(
      "members",
      `<section class="page">
    ${pageHead(
      "Mitglieder",
      `<div class="head-actions">
        <label class="inline-field">Sortierung
          <select id="member-sort">${Object.entries(MEMBER_SORTS)
            .map(
              ([key, [label]]) =>
                `<option value="${key}" ${key === sort ? "selected" : ""}>${label}</option>`
            )
            .join("")}</select>
        </label>
        ${canWrite() ? `<button class="ghost" id="add-member">Mitglied hinzufügen</button>` : ""}
      </div>`
    )}
    <ul class="list" id="member-list">
      ${
        items
          .map(
            (m) => `<li><button class="row-btn" data-id="${m.id}">
            <div class="row-split">
              <strong>${esc(m.name)}${m.active ? "" : " · inaktiv"}</strong>
              ${balanceSpan(m.balanceCents)}
            </div>
          </button></li>`
          )
          .join("") || `<li class="empty">Kein Mitglied gefunden.</li>`
      }
    </ul>
    <div class="row grand"><span>Kassen-Soll / Verbindlichkeit / Forderung</span><strong>${euro(soll)} · ${euro(
        pos
      )} · ${euro(neg)}</strong></div>
  </section>`
    )
  )
    return;
  document.getElementById("add-member")?.addEventListener("click", () => go("member-new", { boxId: state.boxId }));
  document
    .getElementById("member-sort")
    .addEventListener("change", (event) => go("members", { boxId: state.boxId, sort: event.target.value }));
  view().querySelectorAll("[data-id]").forEach((btn) =>
    btn.addEventListener("click", () => go("member", { boxId: state.boxId, memberId: Number(btn.dataset.id) }))
  );
}

function renderMemberNew() {
  showIf(
    "member-new",
    `<section class="page">
    ${pageHead("Mitglied hinzufügen")}
    <form id="member-form" class="stack">
      ${field("Anzeigename", "name")}
      ${moneyField("Startguthaben (optional)", "start")}
      <label class="field">Woher kommt das Startguthaben?
        <select name="startKind">
          <option value="opening">Liegt schon im Anfangsbestand der Kasse</option>
          <option value="deposit">Ist gerade neu auf dem Konto eingegangen</option>
        </select>
      </label>
      <p class="hint">Startguthaben nur eintragen, wenn das Geld wirklich schon auf dem Konto liegt.</p>
      ${dateField("Datum", "date")}
      <p class="error" id="form-error" hidden></p>
      <button class="pay" type="submit">Speichern</button>
    </form>
  </section>`
  );
  bindForm("member-form", async (data) => {
    await api(`/cashboxes/${state.boxId}/members`, {
      method: "POST",
      body: JSON.stringify({
        name: data.name,
        startBalanceCents: parseEuro(data.start),
        startKind: data.startKind,
        date: requireDate(data.date),
      }),
    });
    go("members", { boxId: state.boxId });
  });
}

const MEMBER_EVENTS_PER_PAGE = 10;

/* Eine Seite aus der Ereignisliste eines Mitglieds samt Blaetterleiste. Die
   Buchungen kommen vom Server neueste zuerst, Seite 1 zeigt also das Aktuelle. */
function memberEvents(entries, page) {
  const pages = Math.max(1, Math.ceil(entries.length / MEMBER_EVENTS_PER_PAGE));
  const current = Math.min(page, pages);
  const start = (current - 1) * MEMBER_EVENTS_PER_PAGE;
  const rows = entries.slice(start, start + MEMBER_EVENTS_PER_PAGE);
  const list = `<ul class="list">${
    rows
      .map((e) => {
        const tag = e.kind.includes("correction") || e.kind.includes("void") ? " · Korrektur/Storno" : "";
        return `<li>
          <div class="row-split"><strong>${isoToDE(e.booked_on)} · ${
          KIND[e.kind] || esc(e.kind)
        }${tag}</strong><span>${euro(e.amount_cents)}</span></div>
          <div class="muted">${[esc(e.note || ""), `Saldo ${euro(e.runningCents)}`]
            .filter(Boolean)
            .join(" · ")}</div>
        </li>`;
      })
      .join("") || `<li class="empty">Noch keine Ereignisse.</li>`
  }</ul>`;
  if (pages < 2) return list;
  return `${list}
    <div class="pager">
      <button class="ghost" type="button" data-page="${current - 1}" ${current === 1 ? "disabled" : ""}>Zurück</button>
      <span class="muted">Seite ${current} von ${pages}</span>
      <button class="ghost" type="button" data-page="${current + 1}" ${
    current === pages ? "disabled" : ""
  }>Weiter</button>
    </div>`;
}

async function renderMember() {
  const member = await api(`/cashboxes/${state.boxId}/members/${state.params.memberId}`);
  if (state.view !== "member") return;
  const tab = state.params.tab || "overview";
  const page = Math.max(1, Number(state.params.page) || 1);
  let body = "";
  if (tab === "audit") {
    body = auditList(member.audit);
  } else if (tab === "deposit") {
    body = `<form id="deposit-form" class="stack">
      ${moneyField("Einzahlung", "amount")}
      ${dateField("Datum", "date")}
      ${field("Referenz", "note")}
      <button class="pay" type="submit">Einzahlung speichern</button>
    </form>`;
  } else if (tab === "correction") {
    body = `<form id="corr-form" class="stack">
      ${moneyField("Korrektur (+/−)", "amount")}
      ${dateField("Datum", "date")}
      ${field("Begründung", "note")}
      <p class="hint">Eine Korrektur ändert nur das Guthaben, sie bewegt kein Geld.</p>
      <button class="pay" type="submit">Korrektur buchen</button>
    </form>`;
  } else if (tab === "settle") {
    body = `<form id="settle-form" class="stack">
      <div class="row grand"><span>Guthaben</span>${balanceSpan(member.balanceCents)}</div>
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
      <button class="pay" type="submit">Auf 0,00 € setzen</button>
    </form>`;
  } else {
    body = `<div class="stack">
      ${
        canWrite()
          ? `<form id="edit-form" class="stack">
              ${field("Name", "name", member.name)}
              <button class="ghost" type="submit">Namen speichern</button>
            </form>`
          : ""
      }
      <div class="row grand"><span>Guthaben</span>${balanceSpan(member.balanceCents)}</div>
      ${
        canWrite()
          ? `<div class="row-actions">
              <button class="ghost" id="toggle-active">${member.active ? "Deaktivieren" : "Reaktivieren"}</button>
              <button class="ghost danger" id="delete-member">Entfernen</button>
            </div>
            <p class="hint">Deaktivieren behält alle Buchungen und nimmt das Mitglied nur aus den Listen. Entfernen geht nur, solange keine Striche und kein Geld erfasst sind.</p>`
          : ""
      }
      <h3>Ereignisse</h3>
      ${memberEvents(member.ledger, page)}
    </div>`;
  }
  if (
    !showIf(
      "member",
      `<section class="page">
    ${pageHead(esc(member.name) + (member.active ? "" : " · inaktiv"))}
    ${tabBar(
      [
        ["overview", "Übersicht"],
        canWrite() && ["deposit", "Einzahlung"],
        canWrite() && ["correction", "Korrektur"],
        canWrite() && ["settle", "Auf 0 setzen"],
        ["audit", "Protokoll"],
      ],
      tab
    )}
    ${body}
    <p class="error" id="form-error" hidden></p>
  </section>`
    )
  )
    return;
  view().querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => go("member", { boxId: state.boxId, memberId: member.id, tab: btn.dataset.tab }))
  );
  view().querySelectorAll("[data-page]").forEach((btn) =>
    btn.addEventListener("click", () =>
      go("member", { boxId: state.boxId, memberId: member.id, tab, page: Number(btn.dataset.page) })
    )
  );
  const done = () => go("member", { boxId: state.boxId, memberId: member.id });
  if (tab === "deposit" && canWrite()) {
    bindForm("deposit-form", async (data) => {
      await api(`/cashboxes/${state.boxId}/members/${member.id}/deposit`, {
        method: "POST",
        body: JSON.stringify({ amountCents: parseEuro(data.amount), date: requireDate(data.date), note: data.note }),
      });
      done();
    });
  }
  if (tab === "correction" && canWrite()) {
    bindForm("corr-form", async (data) => {
      await api(`/cashboxes/${state.boxId}/members/${member.id}/correction`, {
        method: "POST",
        body: JSON.stringify({ amountCents: parseEuro(data.amount), date: requireDate(data.date), note: data.note }),
      });
      done();
    });
  }
  if (tab === "settle" && canWrite()) {
    bindForm("settle-form", async (data) => {
      await api(`/cashboxes/${state.boxId}/members/${member.id}/settle`, {
        method: "POST",
        body: JSON.stringify({ reason: data.reason, date: requireDate(data.date), note: data.note }),
      });
      done();
    });
  }
  if (tab === "overview" && canWrite()) {
    bindForm("edit-form", async (data) => {
      await api(`/cashboxes/${state.boxId}/members/${member.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: data.name }),
      });
      done();
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
    document.getElementById("delete-member").addEventListener("click", async () => {
      if (!confirm(`${member.name} endgültig entfernen? Das lässt sich nicht zurücknehmen.`)) return;
      try {
        await api(`/cashboxes/${state.boxId}/members/${member.id}`, { method: "DELETE" });
        go("members", { boxId: state.boxId });
      } catch (error) {
        setBanner(error.message);
      }
    });
  }
}

/* Das Protokoll wird als Satz gelesen, nicht als Datensatz. Deshalb werden
   Aktion, Rolle und Feldnamen uebersetzt und nur die Werte gezeigt, die sich
   tatsaechlich geaendert haben. */
const AUDIT_ACTIONS = {
  create: "Angelegt",
  update: "Geändert",
  delete: "Entfernt",
  deposit: "Einzahlung",
  payout: "Auszahlung",
  correction: "Korrektur",
  settle: "Saldo ausgeglichen",
  deactivate: "Stillgelegt",
  reactivate: "Wieder aktiv",
  void: "Storniert",
  reimburse: "Erstattung",
  snapshot: "Kontostand erfasst",
  export: "Sicherung erstellt",
  export_csv: "Auswertung exportiert",
  import: "Daten eingelesen",
  login: "Angemeldet",
  login_failed: "Anmeldung fehlgeschlagen",
  logout: "Abgemeldet",
  revoke: "Sitzung beendet",
  password_set: "Passwort gesetzt",
  access_update: "Zugang geändert",
};

const AUDIT_ROLES = { admin: "Admin", editor: "Bearbeiter", reader: "Leser" };

const AUDIT_FIELDS = {
  name: "Name",
  shortName: "Kürzel",
  short_name: "Kürzel",
  note: "Notiz",
  date: "Datum",
  label: "Bezeichnung",
  active: "Aktiv",
  amountCents: "Betrag",
  balanceCents: "Guthaben",
  startBalanceCents: "Startguthaben",
  startKind: "Startguthaben",
  drinkPriceCents: "Preis je Strich",
  openingBalanceCents: "Anfangsbestand",
  openingDate: "Datum Anfangsbestand",
  openingSource: "Herkunft Anfangsbestand",
  accountName: "Konto",
  accountUrl: "Link zum Konto",
  feeFree: "Gebührenfrei",
  vendor: "Händler",
  description: "Beschreibung",
  receiptCents: "Bonbetrag",
  pfandCents: "Pfand",
  pfandGiven: "Pfand abgegeben",
  advancedBy: "Vorgestreckt von",
  reimburseNow: "Sofort erstattet",
  reimburseCents: "Erstattungsbetrag",
  reimburseDate: "Erstattungsdatum",
  reimburseRef: "Referenz der Erstattung",
  reason: "Grund",
  lines: "Striche",
  mode: "Art",
  created: "Angelegte Kassen",
  rows: "Zeilen",
  from: "Von",
  to: "Bis",
  cashboxes: "Kassen",
  members: "Mitglieder",
  role: "Rolle",
  enabled: "Freigeschaltet",
  sessionId: "Sitzung",
};

const AUDIT_DATE_FIELDS = ["date", "booked_on", "openingDate", "reimburseDate"];

/* Technische Schluessel und Passwoerter gehoeren nicht in die Anzeige. */
const AUDIT_SKIP_FIELDS = ["id", "cashboxId", "memberId", "confirmWord", "confirmName", "password"];

function strokeText(n) {
  return n === 1 ? "1 Strich" : `${n} Striche`;
}

function peopleText(n) {
  return n === 1 ? "1 Person" : `${n} Personen`;
}

function memberLabel(id, names) {
  return names[id] || names[Number(id)] || `Mitglied ${id}`;
}

/* Bei Getraenkevorgaengen stehen die Mengen als {Mitglieds-Id: Striche}. */
function isQtyMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => /^\d+$/.test(k) && typeof value[k] === "number");
}

function auditValue(key, value, names) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "ja" : "nein";
  if (key === "startKind") return value === "deposit" ? "gerade eingegangen" : "im Anfangsbestand";
  if (/Cents$/.test(key)) return euro(Number(value));
  if (AUDIT_DATE_FIELDS.includes(key)) return isoToDE(String(value));
  if (Array.isArray(value)) {
    if (!value.length) return "—";
    if (value.every((v) => v && typeof v === "object" && "memberId" in v))
      return value.map((v) => `${memberLabel(v.memberId, names)} ${v.qty}`).join(", ");
    return value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ");
  }
  if (isQtyMap(value)) {
    const parts = Object.entries(value)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => `${memberLabel(id, names)} ${qty}`);
    return parts.length ? parts.join(", ") : "keine";
  }
  if (typeof value === "object") {
    const parts = Object.entries(value).map(([k, v]) => `${AUDIT_FIELDS[k] || k}: ${auditValue(k, v, names)}`);
    return parts.length ? parts.join(", ") : "—";
  }
  return String(value);
}

function auditDetails(entry, names) {
  let before = null;
  let after = null;
  try {
    before = entry.before_json ? JSON.parse(entry.before_json) : null;
    after = entry.after_json ? JSON.parse(entry.after_json) : null;
  } catch {
    return [];
  }
  // Striche werden je Mitglied verglichen, sonst liest man zwei Zahlenlisten.
  if (isQtyMap(before) || isQtyMap(after)) {
    const ids = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    const out = [];
    ids.forEach((id) => {
      const from = Number((before || {})[id] || 0);
      const to = Number((after || {})[id] || 0);
      if (from !== to) out.push(`${memberLabel(id, names)}: ${from} → ${strokeText(to)}`);
    });
    return out.length ? out : ["Keine Änderung an den Strichen."];
  }
  const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
  const label = (key) => AUDIT_FIELDS[key] || key;
  if (plain(before) && plain(after)) {
    const out = [];
    Object.keys(after).forEach((key) => {
      if (AUDIT_SKIP_FIELDS.includes(key)) return;
      const to = auditValue(key, after[key], names);
      // Ein Pfeil nur, wenn es vorher wirklich einen anderen Wert gab. Sonst
      // stand da "Betrag: — → 3,00 €", was niemand liest.
      if (!(key in before)) return out.push(`${label(key)}: ${to}`);
      const from = auditValue(key, before[key], names);
      if (from !== to) out.push(`${label(key)}: ${from} → ${to}`);
    });
    Object.keys(before).forEach((key) => {
      if (AUDIT_SKIP_FIELDS.includes(key) || key in after) return;
      out.push(`${label(key)} vorher: ${auditValue(key, before[key], names)}`);
    });
    if (out.length) return out;
  }
  const source = plain(after) ? after : plain(before) ? before : null;
  if (!source) return [];
  const prefix = plain(after) ? "" : " vorher";
  return Object.entries(source)
    .filter(([key]) => !AUDIT_SKIP_FIELDS.includes(key))
    .map(([key, value]) => `${label(key)}${prefix}: ${auditValue(key, value, names)}`);
}

function auditList(items, names = {}) {
  if (!items?.length) return `<ul class="list"><li class="empty">Keine Einträge.</li></ul>`;
  return `<ul class="list">${items
    .map((e) => {
      const what = AUDIT_ACTIONS[e.action] || e.action;
      const who = AUDIT_ROLES[e.role] || e.role;
      const details = auditDetails(e, names);
      return `<li>
      <div class="row-split"><strong>${esc(what)}</strong><span class="muted">${isoToDETime(e.created_at)}</span></div>
      <div class="muted">von ${esc(who)}${e.note ? ` · ${esc(e.note)}` : ""}</div>
      ${details.length ? `<ul class="plain">${details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
    </li>`;
    })
    .join("")}</ul>`;
}

function payTabs(active) {
  return tabBar(
    [
      ["deposit", "Einzahlung"],
      ["log", "Protokoll"],
    ],
    active
  );
}

function bindPayTabs() {
  view()
    .querySelectorAll("[data-tab]")
    .forEach((btn) => btn.addEventListener("click", () => go("pay", { boxId: state.boxId, tab: btn.dataset.tab })));
}

async function renderPay() {
  if (state.params.tab === "log") return renderPayLog();
  const members = (await api(`/cashboxes/${state.boxId}/members`)).members.filter((m) => m.active);
  if (
    !showIf(
      "pay",
      `<section class="page">
    ${pageHead("Einzahlung")}
    ${payTabs("deposit")}
    <form id="pay-form" class="stack">
      <label class="field">Mitglied
        <input name="member" id="pay-member" list="pay-members" autocomplete="off"
          placeholder="Name eintippen oder aus der Liste wählen" />
      </label>
      <datalist id="pay-members">${members
        .map((m) => `<option value="${esc(m.name)}" label="${euro(m.balanceCents)}"></option>`)
        .join("")}</datalist>
      <p class="muted" id="pay-who">Noch kein Mitglied gewählt.</p>
      ${moneyField("Betrag", "amount")}
      ${dateField("Datum", "date")}
      ${field("Referenz", "note")}
      <button class="pay" type="submit">Speichern</button>
      <p class="error" id="form-error" hidden></p>
    </form>
  </section>`
    )
  )
    return;
  /* Das Auswahlfeld ist ein Textfeld mit Vorschlagsliste: der Browser filtert
     die Namen beim Tippen selbst. Uebrig bleibt der Abgleich des Eingetippten
     mit der Mitgliederliste. */
  const match = (text) => {
    const q = String(text || "").trim().toLowerCase();
    return q ? members.find((m) => m.name.toLowerCase() === q) || null : null;
  };
  const who = document.getElementById("pay-who");
  const input = document.getElementById("pay-member");
  const error = document.querySelector("#pay-form .error");
  input.addEventListener("input", () => {
    error.hidden = true;
    const found = match(input.value);
    if (found) {
      who.className = "";
      who.innerHTML = `<span class="row-split"><strong>${esc(found.name)}</strong>${balanceSpan(
        found.balanceCents
      )}</span>`;
      return;
    }
    who.className = "muted";
    who.textContent = input.value.trim()
      ? "Noch kein Treffer – Namen aus der Liste wählen."
      : "Noch kein Mitglied gewählt.";
  });
  bindForm("pay-form", async (data) => {
    const chosen = match(data.member);
    if (!chosen) throw new Error("Bitte ein Mitglied aus der Liste wählen.");
    await api(`/cashboxes/${state.boxId}/members/${chosen.id}/deposit`, {
      method: "POST",
      body: JSON.stringify({ amountCents: parseEuro(data.amount), date: requireDate(data.date), note: data.note }),
    });
    go("pay", { boxId: state.boxId, tab: "log" });
  });
  bindPayTabs();
}

async function renderPayLog() {
  const data = await api(`/cashboxes/${state.boxId}/deposits`);
  if (state.view !== "pay") return;
  const total = data.deposits.reduce((s, d) => s + d.amount_cents, 0);
  if (
    !showIf(
      "pay",
      `<section class="page">
    ${pageHead("Einzahlung")}
    ${payTabs("log")}
    ${
      data.deposits.length
        ? `<div class="row grand"><span>${
            data.deposits.length === 1 ? "1 Einzahlung" : `${data.deposits.length} Einzahlungen`
          }</span><strong>${euro(total)}</strong></div>`
        : ""
    }
    <ul class="list">${
      data.deposits
        .map((d) => {
          const parts = [isoToDE(d.booked_on)];
          if (d.kind === "start") parts.push("Startguthaben");
          if (d.note) parts.push(esc(d.note));
          return `<li>
            <button class="row-btn" data-member="${d.member_id}">
              <div class="row-split"><strong>${esc(d.member_name || "Entferntes Mitglied")}</strong><span>${euro(
            d.amount_cents
          )}</span></div>
              <div class="muted">${parts.join(" · ")}</div>
            </button>
          </li>`;
        })
        .join("") || `<li class="empty">Noch keine Einzahlungen.</li>`
    }</ul>
  </section>`
    )
  )
    return;
  bindPayTabs();
  view()
    .querySelectorAll("[data-member]")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        go("member", { boxId: state.boxId, memberId: Number(btn.dataset.member) })
      )
    );
}

async function renderDrinks() {
  const eventId = state.params.eventId;
  if (eventId) return renderDrinkEvent(eventId);
  // Wer nicht schreiben darf, hat vom Erfassungsbogen nichts und landet im Protokoll.
  const tab = state.params.tab || (canWrite() ? "capture" : "log");
  if (tab === "log" || !canWrite()) return renderDrinkLog();
  const members = (await api(`/cashboxes/${state.boxId}/members`)).members.filter((m) => m.active);
  const box = await api(`/cashboxes/${state.boxId}`);
  if (state.view !== "drinks") return;
  const price = box.drink_price_cents;
  if (
    !showIf(
      "drinks",
      `<section class="page">
    ${pageHead("Erfassen", `<p>${euro(price)} / Strich</p>`)}
    ${drinkTabs("capture")}
    <form id="drink-form" class="stack">
      ${dateField("Datum", "date")}
      ${field("Bezeichnung", "label", "", `placeholder="z. B. Treffen"`)}
      <div id="drink-list"></div>
      <div class="sticky-sum stack">
        <div class="row grand"><span id="drink-sum">0 Striche = 0,00 €</span></div>
        ${canWrite() ? `<button class="pay" type="submit">Speichern</button>` : ""}
        <p class="error" id="form-error" hidden></p>
      </div>
    </form>
  </section>`
    )
  )
    return;
  bindDrinkTabs();
  bindDrinkForm(members, {}, price, null);
}

function drinkTabs(active) {
  return tabBar([canWrite() && ["capture", "Erfassen"], ["log", "Protokoll"]], active);
}

function bindDrinkTabs() {
  view()
    .querySelectorAll("[data-tab]")
    .forEach((btn) => btn.addEventListener("click", () => go("drinks", { boxId: state.boxId, tab: btn.dataset.tab })));
}

async function renderDrinkLog() {
  const data = await api(`/cashboxes/${state.boxId}/drinks`);
  if (state.view !== "drinks") return;
  if (
    !showIf(
      "drinks",
      `<section class="page">
    ${pageHead("Erfassen")}
    ${drinkTabs("log")}
    <ul class="list">${
      data.events
        .map((e) => {
          const strokes = strokeText(e.qty);
          const heads = peopleText(e.people);
          return `<li>
            <button class="row-btn ${e.status === "voided" ? "voided" : ""}" data-id="${e.id}">
              <div class="row-split"><strong>${isoToDE(e.booked_on)}${e.label ? ` · ${esc(e.label)}` : ""}</strong><span>${
            e.status === "voided" ? "storniert" : euro(e.totalCents)
          }</span></div>
              <div class="muted">${strokes} · ${heads}</div>
            </button>
          </li>`;
        })
        .join("") || `<li class="empty">Noch nichts erfasst.</li>`
    }</ul>
  </section>`
    )
  )
    return;
  bindDrinkTabs();
  view()
    .querySelectorAll("[data-id]")
    .forEach((btn) =>
      btn.addEventListener("click", () => go("drinks", { boxId: state.boxId, eventId: Number(btn.dataset.id) }))
    );
}

async function renderDrinkEvent(eventId) {
  const event = await api(`/cashboxes/${state.boxId}/drinks/${eventId}`);
  const members = (await api(`/cashboxes/${state.boxId}/members`)).members.filter((m) => m.active);
  if (state.view !== "drinks") return;
  const qtys = {};
  event.lines.forEach((l) => (qtys[l.memberId] = l.qty));
  const names = {};
  event.lines.forEach((l) => (names[l.memberId] = l.name));
  members.forEach((m) => (names[m.id] = m.name));
  const price = event.priceCents;
  const voided = event.status === "voided";
  const tab = state.params.tab || "lines";
  const marked = event.lines.filter((l) => l.qty > 0);
  const qty = marked.reduce((s, l) => s + l.qty, 0);
  const strokes = strokeText(qty);
  const heads = peopleText(marked.length);
  let body = "";
  if (tab === "audit") {
    body = auditList(event.audit, names);
  } else if (tab === "edit") {
    body = `<form id="drink-form" class="stack">
      ${dateField("Datum", "date", event.booked_on)}
      ${field("Bezeichnung", "label", event.label || "", `placeholder="z. B. Treffen"`)}
      <div id="drink-list"></div>
      <div class="sticky-sum stack">
        <div class="row grand"><span id="drink-sum">0 Striche = 0,00 €</span></div>
        <button class="pay" type="submit">Speichern</button>
        <button class="ghost" type="button" id="void-event">Vorgang stornieren</button>
        <p class="error" id="form-error" hidden></p>
      </div>
    </form>`;
  } else {
    // Nur die Mitglieder, die auch Striche bekommen haben.
    body = `<div class="stack">
      <div class="row grand"><span>${strokes} = ${euro(qty * price)}</span><span>${heads}</span></div>
      <ul class="list">${
        marked
          .map(
            (l) => `<li>
              <div class="row-split"><strong>${esc(l.name)}</strong><span>${
              strokeText(l.qty)
            } · ${euro(l.cents)}</span></div>
            </li>`
          )
          .join("") || `<li class="empty">In diesem Vorgang wurden keine Striche erfasst.</li>`
      }</ul>
      <p class="muted">${euro(price)} je Strich${voided ? " · Dieser Vorgang ist storniert." : ""}</p>
    </div>`;
  }
  if (
    !showIf(
      "drinks",
      `<section class="page">
    ${pageHead(
      `${isoToDE(event.booked_on)}${event.label ? ` · ${esc(event.label)}` : ""}`,
      `<button class="ghost" id="back-to-log" type="button">Zurück</button>`
    )}
    ${tabBar(
      [["lines", "Striche"], canWrite() && !voided && ["edit", "Ändern"], ["audit", "Protokoll"]],
      tab
    )}
    ${body}
  </section>`
    )
  )
    return;
  document
    .getElementById("back-to-log")
    .addEventListener("click", () => go("drinks", { boxId: state.boxId, tab: "log" }));
  view()
    .querySelectorAll("[data-tab]")
    .forEach((btn) =>
      btn.addEventListener("click", () => go("drinks", { boxId: state.boxId, eventId, tab: btn.dataset.tab }))
    );
  if (tab !== "edit") return;
  bindDrinkForm(members, qtys, price, eventId);
}

function bindDrinkForm(members, qtys, price, eventId) {
  const list = document.getElementById("drink-list");
  const counts = {};
  members.forEach((m) => (counts[m.id] = qtys[m.id] || 0));
  function draw() {
    list.replaceChildren();
    members.forEach((m) => {
      const row = el(`<div class="drink-row">
        <div class="who"><strong>${esc(m.name)}</strong>${balanceSpan(m.balanceCents, "bal")}</div>
        <div class="qty">
          <button type="button" data-act="dec">−</button>
          <input class="qty-input" inputmode="numeric" value="${counts[m.id]}" />
          <button type="button" data-act="inc">+</button>
        </div>
        <strong>${euro(counts[m.id] * price)}</strong>
      </div>`);
      const input = row.querySelector("input");
      const sync = () => {
        counts[m.id] = Math.max(0, Number(input.value || 0));
        input.value = String(counts[m.id]);
        sum();
        row.querySelector("strong:last-child").textContent = euro(counts[m.id] * price);
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
    document.getElementById("drink-sum").textContent = `${strokeText(qty)} = ${euro(qty * price)}, ${peopleText(
      people
    )}`;
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
    go("drinks", { boxId: state.boxId, tab: "log" });
  });
  document.getElementById("void-event")?.addEventListener("click", async () => {
    if (!confirm("Diesen Vorgang stornieren? Die Striche werden zurückgebucht.")) return;
    try {
      await api(`/cashboxes/${state.boxId}/drinks/${eventId}/void`, { method: "POST", body: "{}" });
      go("drinks", { boxId: state.boxId, tab: "log" });
    } catch (error) {
      setBanner(error.message);
    }
  });
}

async function renderAccount() {
  const data = await api(`/cashboxes/${state.boxId}/snapshots`);
  if (state.view !== "account") return;
  const tab = state.params.tab || "overview";
  const href = safeUrl(data.account.url);
  const link = href
    ? `<p><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(data.account.name || href)}</a></p>`
    : `<p class="muted">${esc(data.account.name || "Kein Konto-Link")}${
        data.account.url ? " · Der gespeicherte Link ist keine Web-Adresse." : ""
      }</p>`;
  let body = "";
  if (tab === "audit") body = auditList(data.audit);
  else {
    const m = data.metrics;
    body = `<div class="page">
      ${link}
      <div class="metrics">
        ${metricCard("Kontostand jetzt", m.accountNowCents)}
        ${metricCard("Überschuss", m.surplusCents)}
        ${
          m.hasSnapshot
            ? `${metricCard(`Zuletzt erfasst am ${isoToDE(m.istDate)}`, m.istCents)}
               ${metricCard(`Erwartet zu diesem Tag`, m.expectedCents)}
               ${metricCard("Abweichung", m.deviationCents, m.deviationCents !== 0)}`
            : ""
        }
      </div>
      <p class="hint">„Kontostand jetzt“ ist der Anfangsbestand von ${euro(
        data.account.openingBalanceCents
      )} plus alle erfassten Geldbewegungen. Erfasse unten, was wirklich auf dem Konto liegt — stimmen die beiden Zahlen nicht überein, zeigt die Abweichung die Lücke.</p>
      <h3>Überschuss-Verlauf</h3>
      <ul class="list">${
        data.surplusHistory
          .map(
            (h) => `<li>
            <div class="row-split"><span>${isoToDE(h.date)}</span><strong>Überschuss ${euro(
              h.surplusCents
            )}</strong></div>
            <div class="muted">Konto ${euro(h.expectedCents)} − Kassen-Soll ${euro(h.sollCents)}</div>
            <div class="${h.deviationCents ? "minus" : "muted"}">Erfasst ${euro(h.istCents)}${
              h.deviationCents ? ` · Abweichung ${euro(h.deviationCents)}` : " · ohne Abweichung"
            }</div>
          </li>`
          )
          .join("") || `<li class="empty">Noch kein Kontostand erfasst.</li>`
      }</ul>
      ${
        canWrite()
          ? `<form id="snap-form" class="stack">
              <h3>Kontostand erfassen</h3>
              ${moneyField("Betrag", "amount")}
              ${dateField("Datum", "date")}
              ${field("Quelle", "source", "", `placeholder="PayPal-Screenshot"`)}
              ${field("Notiz", "note")}
              <button class="pay" type="submit">Stand speichern</button>
            </form>`
          : ""
      }
      <h3>Erfasste Stände</h3>
      <ul class="list">${
        data.snapshots
          .map(
            (s) =>
              `<li class="row-split"><span>${isoToDE(s.booked_on)}${
                s.source ? ` · ${esc(s.source)}` : ""
              }</span><strong>${euro(s.amount_cents)}</strong></li>`
          )
          .join("") || `<li class="empty">Noch nichts erfasst.</li>`
      }</ul>
    </div>`;
  }
  view().innerHTML = `<section class="page">
    ${pageHead("Konto")}
    ${tabBar(
      [
        ["overview", "Übersicht"],
        ["audit", "Protokoll"],
      ],
      tab
    )}
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
  if (state.view !== "purchases") return;
  view().innerHTML = `<section class="page">
    ${pageHead("Einkäufe", canWrite() ? `<button class="ghost" id="new-buy">Erfassen</button>` : "")}
    <ul class="list">${
      data.purchases
        .map(
          (p) => `<li><button class="row-btn" data-id="${p.id}">
            <div class="row-split"><strong>${isoToDE(p.booked_on)} · ${esc(p.vendor)}</strong><span class="badge">${PURCHASE_STATUS[p.status] || p.status}</span></div>
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
  view().innerHTML = `<section class="page">
    ${pageHead("Einkauf erfassen")}
    <form id="buy-form" class="stack">
      ${dateField("Datum", "date")}
      ${field("Händler", "vendor")}
      ${field("Was", "description")}
      ${moneyField("Bon-Endbetrag", "receipt")}
      ${checkField("Pfand abgegeben", "pfandGiven")}
      ${moneyField("Pfandbetrag", "pfand")}
      ${field("Vorgestreckt von", "advancedBy")}
      ${field("Notiz", "note")}
      ${checkField("Sofort in gleicher Höhe erstatten", "reimburseNow", true)}
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
  if (state.view !== "purchases") return;
  const tab = state.params.tab || "overview";
  const eq = p.pfand_given
    ? `<p>Einkaufswert ${euro(p.goodsCents)} − Pfand ${euro(p.pfand_cents)} = Bon-Endbetrag ${euro(p.receipt_cents)}</p>`
    : `<p>Bon-Endbetrag ${euro(p.receipt_cents)}</p>`;
  const editBody = `<form id="buy-edit-form" class="stack">
      ${dateField("Datum", "date", p.booked_on)}
      ${field("Händler", "vendor", p.vendor)}
      ${field("Was", "description", p.description)}
      ${moneyField("Bon-Endbetrag", "receipt", p.receipt_cents)}
      ${checkField("Pfand abgegeben", "pfandGiven", p.pfand_given)}
      ${moneyField("Pfandbetrag", "pfand", p.pfand_cents)}
      ${field("Vorgestreckt von", "advancedBy", p.advanced_by)}
      ${field("Notiz", "note", p.note)}
      <p class="hint">Bereits gebuchte Erstattungen bleiben unverändert. Der Rest wird neu berechnet.</p>
      <button class="pay" type="submit">Änderung speichern</button>
    </form>`;
  let body =
    tab === "audit"
      ? auditList(p.audit)
      : tab === "edit"
      ? editBody
      : `<div class="page">
        <div class="stack">
          ${eq}
          <p class="muted">${[esc(p.vendor), esc(p.description), esc(p.advanced_by)]
            .filter(Boolean)
            .join(" · ")}</p>
          <div class="row grand"><span>${PURCHASE_STATUS[p.status] || esc(p.status)}</span><strong>Rest ${euro(
          p.restCents
        )}</strong></div>
        </div>
        ${
          canWrite() && p.restCents > 0
            ? `<form id="payback-form" class="stack">
                <h3>Erstattung buchen</h3>
                ${moneyField("Erstattung", "amount", p.restCents)}
                ${dateField("Datum", "date")}
                ${field("Referenz", "reference")}
                <button class="pay" type="submit">Erstattung buchen</button>
              </form>`
            : ""
        }
        <h3>Erstattungen</h3>
        <ul class="list">${
          p.reimbursements
            .map(
              (r) => `<li class="row-split"><span>${isoToDE(r.booked_on)}${
                r.reference ? ` · ${esc(r.reference)}` : ""
              }</span><strong>${euro(r.amount_cents)}</strong></li>`
            )
            .join("") || `<li class="empty">Noch nichts erstattet.</li>`
        }</ul>
      </div>`;
  if (
    !showIf(
      "purchases",
      `<section class="page">
    ${pageHead(`Einkauf ${isoToDE(p.booked_on)}`)}
    ${tabBar(
      [["overview", "Übersicht"], canWrite() && ["edit", "Bearbeiten"], ["audit", "Protokoll"]],
      tab
    )}
    ${body}
    <p class="error" id="form-error" hidden></p>
  </section>`
    )
  )
    return;
  view().querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => go("purchases", { boxId: state.boxId, purchaseId: p.id, tab: btn.dataset.tab }))
  );
  if (tab === "overview" && document.getElementById("payback-form")) {
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
  if (tab === "edit") {
    bindForm("buy-edit-form", async (data, form) => {
      await api(`/cashboxes/${state.boxId}/purchases/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({
          date: requireDate(data.date),
          vendor: data.vendor,
          description: data.description,
          receiptCents: parseEuro(data.receipt),
          pfandGiven: form.pfandGiven.checked,
          pfandCents: parseEuro(data.pfand),
          advancedBy: data.advancedBy,
          note: data.note,
        }),
      });
      go("purchases", { boxId: state.boxId, purchaseId: p.id });
    });
  }
}

async function renderReminders() {
  const data = await api(`/cashboxes/${state.boxId}/reminders`);
  if (state.view !== "reminders") return;
  const text = data.members.map((m) => `${m.name}: ${euro(m.balanceCents)}`).join("\n") || "Keine Minusstände.";
  view().innerHTML = `<section class="page">
    ${pageHead("Mahnliste", `<p>${data.members.length} im Minus</p>`)}
    <div class="stack">
      <textarea class="copy-box" id="copy-text" readonly>${esc(text)}</textarea>
      <button class="pay" id="copy-btn" type="button">Liste kopieren</button>
    </div>
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
  view().innerHTML = `<section class="page">
    ${pageHead("Sicherung")}
    <div class="stack">
      <h3>Export</h3>
      <p class="hint">Die Datei enthält Klarnamen, Salden und Zugänge. Nicht in Cloud, Chat oder Git legen. Passwörter stehen nicht im Klartext, ein Import in eine andere Instanz gibt aber vollen Zugriff.</p>
      <button class="pay" id="export-all" type="button">Gesamtexport</button>
      ${state.boxId ? `<button class="ghost" id="export-one" type="button">Diese Kasse exportieren</button>` : ""}
    </div>
    <div id="export-summary"></div>
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
  const runExport = async (query, label) => {
    try {
      const payload = await downloadExport(query);
      await showExportSummary(payload, label);
    } catch (error) {
      setBanner(error.message);
    }
  };
  document.getElementById("export-all").addEventListener("click", () => runExport("", "Gesamtexport"));
  document
    .getElementById("export-one")
    ?.addEventListener("click", () => runExport(`?cashbox=${state.boxId}`, "Export dieser Kasse"));
  document.getElementById("import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = event.target.file.files[0];
    const mode = event.target.mode.value;
    if (!file || !mode) {
      setBanner("Datei und Betriebsart wählen.");
      return;
    }
    let backup;
    let preview;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      document.getElementById("preview").innerHTML = "";
      setBanner("Die Datei ist beschädigt und lässt sich nicht lesen. Bitte die unveränderte Sicherungsdatei wählen.");
      return;
    }
    try {
      preview = await api("/backup/preview", { method: "POST", body: JSON.stringify({ backup }) });
    } catch (error) {
      document.getElementById("preview").innerHTML = "";
      setBanner(error.message);
      return;
    }
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
  const text = await res.text();
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `kassify-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return JSON.parse(text);
}

/* Nachweis, dass die Datei vollständig ist: was steckt wirklich drin? */
async function showExportSummary(payload, fileName) {
  const target = document.getElementById("export-summary");
  if (!target) return;
  target.innerHTML = `<p class="muted">Zusammenfassung wird erstellt …</p>`;
  try {
    const data = await api("/backup/preview", { method: "POST", body: JSON.stringify({ backup: payload }) });
    const boxes = data.cashboxes || [];
    const total = (key) => boxes.reduce((sum, c) => sum + (c[key] || 0), 0);
    if (!document.getElementById("export-summary")) return;
    target.innerHTML = `<div class="card stack">
      <strong>Gesichert: ${fileName}</strong>
      <p class="muted">${boxes.length} ${boxes.length === 1 ? "Kasse" : "Kassen"} · ${total("memberCount")} Mitglieder · ${total("bookingCount")} Buchungen</p>
      <ul class="list">
        ${boxes
          .map(
            (c) => `<li>
              <div class="row-split"><strong>${esc(c.name)}</strong><span>${c.memberCount} Mitglieder</span></div>
              <div class="row-split muted"><span>${c.bookingCount} Buchungen</span><span>Kassen-Soll ${euro(
              c.sollCents
            )} · Konto ${euro(c.accountNowCents)}</span></div>
            </li>`
          )
          .join("")}
      </ul>
      <p class="hint">Diese Zahlen mit der Kassenübersicht vergleichen. Weichen sie ab, ist die Datei unvollständig.</p>
    </div>`;
  } catch (error) {
    target.innerHTML = `<p class="error">Die Datei wurde heruntergeladen, die Zusammenfassung ließ sich aber nicht erstellen: ${esc(error.message)}</p>`;
  }
}

async function renderCsv() {
  view().innerHTML = `<section class="page">
    ${pageHead("Auswertung")}
    <form id="csv-form" class="stack">
      <p class="hint">Alle Buchungen des gewählten Zeitraums als CSV-Datei, etwa für die Jahresabrechnung.</p>
      ${dateField("Von", "from")}
      ${dateField("Bis", "to")}
      <p class="error" id="form-error" hidden></p>
      <button class="pay" type="submit">CSV laden</button>
    </form>
  </section>`;
  bindForm("csv-form", async (data) => {
    const from = requireDate(data.from);
    const to = requireDate(data.to);
    const res = await fetch(`${API}/backup/csv?cashbox=${state.boxId}&from=${from}&to=${to}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error("CSV-Export fehlgeschlagen.");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kassify-auswertung.csv";
    a.click();
  });
}

async function renderManage() {
  const tab = state.params.tab || "settings";
  const [box, access, audit] = await Promise.all([
    api(`/cashboxes/${state.boxId}`),
    api(`/cashboxes/${state.boxId}/access`),
    api(`/cashboxes/${state.boxId}/audit`),
  ]);
  if (state.view !== "manage") return;
  const editor = access.accesses.find((a) => a.role === "editor");
  const reader = access.accesses.find((a) => a.role === "reader");
  const settings = `<div class="page">
    <form id="box-edit" class="stack">
      <h3>Stammdaten</h3>
      ${field("Bezeichnung", "name", box.name)}
      ${moneyField("Getränkepreis", "drinkPrice", box.drink_price_cents)}
      ${field("Kontobezeichnung", "accountName", box.account_name)}
      ${field("Link zum Konto", "accountUrl", box.account_url)}
      ${moneyField("Anfangsbestand", "opening", box.opening_balance_cents)}
      ${dateField("Datum Anfangsbestand", "openingDate", box.opening_date)}
      ${field("Herkunft", "openingSource", box.opening_source)}
      ${checkField("Zahlungen gebührenfrei", "feeFree", true)}
      <button class="pay" type="submit">Speichern</button>
    </form>
    <form id="role-form" class="stack">
      <h3>Zugänge</h3>
      ${field("Editor-Passwort", "editorPassword", "", `type="password"`)}
      ${checkField("Editor aktiv", "editorOn", editor?.enabled)}
      ${field("Reader-Passwort", "readerPassword", "", `type="password"`)}
      ${checkField("Reader aktiv", "readerOn", reader?.enabled)}
      <button class="ghost" type="submit">Zugänge speichern</button>
    </form>
    <form id="del-form" class="stack">
      <h3>Kasse löschen</h3>
      <p class="hint">Endgültig. ${box.totalMemberCount} Mitglieder, Kassen-Soll ${euro(
    box.sollCents
  )}, Konto ${euro(box.accountNowCents)}. Zuerst Export.</p>
      <button class="ghost" type="button" id="export-before">Export dieser Kasse</button>
      ${field("Vollständigen Kassennamen eintippen", "confirmName")}
      <button class="pay danger" type="submit">Unwiderruflich löschen</button>
    </form>
  </div>`;
  view().innerHTML = `<section class="page">
    ${pageHead("Kassenverwaltung")}
    ${tabBar(
      [
        ["settings", "Einstellungen"],
        ["audit", "Protokoll"],
      ],
      tab
    )}
    ${tab === "audit" ? auditList(audit.audit) : settings}
    <p class="error" id="form-error" hidden></p>
  </section>`;
  view()
    .querySelectorAll("[data-tab]")
    .forEach((btn) =>
      btn.addEventListener("click", () => go("manage", { boxId: state.boxId, tab: btn.dataset.tab }))
    );
  if (tab === "audit") return;
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

async function render(seq) {
  const target = state.view;
  if (seq !== paintSeq) return;
  setBanner("");
  renderNav();
  const map = {
      login: renderLogin,
      setup: renderSetup,
      boxes: renderBoxes,
      "box-new": renderBoxNew,
      home: renderHome,
      members: renderMembers,
      "member-new": renderMemberNew,
      member: renderMember,
      drinks: renderDrinks,
      pay: renderPay,
      account: renderAccount,
      purchases: renderPurchases,
      "purchase-new": renderPurchaseNew,
      reminders: renderReminders,
      backup: renderBackup,
      csv: renderCsv,
      manage: renderManage,
  };
  const fn = map[target];
  if (!fn) {
    if (state.view === target) view().innerHTML = `<p class="error">Seite „${esc(target)}“ wurde nicht gefunden.</p>`;
    return;
  }
  if (target !== "login" && target !== "setup") {
    if (seq !== paintSeq) return;
    view().innerHTML = `<p class="muted">Laden …</p>`;
  }
  try {
    await fn();
  } catch (error) {
    if (seq === paintSeq && state.view === target) {
      view().innerHTML = `<p class="error">${esc(error.message)}</p>`;
    }
  }
}

boot();
document.getElementById("login-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const err = form.querySelector("#form-error");
  const password = new FormData(form).get("password");
  try {
    const res = await submitPassword(password);
    await afterAuth(res);
  } catch (error) {
    if (err) {
      err.hidden = false;
      err.textContent = error.message;
    } else setBanner(error.message);
  }
});
