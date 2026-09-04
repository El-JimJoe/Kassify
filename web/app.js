const API_KEY = "kassify-api-base";
const TOKEN_KEY = "kassify-token";

const DEFAULTS = {
  shopName: "Kasse",
  taxRate: 19,
  products: [],
  history: [],
};

const euro = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

const state = structuredClone(DEFAULTS);
const cart = new Map();
let productDraft = [];
let connected = false;
let settingsOpen = false;

const els = {
  shopName: document.getElementById("shop-name"),
  clock: document.getElementById("clock"),
  products: document.getElementById("products"),
  cart: document.getElementById("cart"),
  net: document.getElementById("net"),
  tax: document.getElementById("tax"),
  taxLabel: document.getElementById("tax-label"),
  total: document.getElementById("total"),
  payBtn: document.getElementById("pay-btn"),
  clearBtn: document.getElementById("clear-btn"),
  payDialog: document.getElementById("pay-dialog"),
  due: document.getElementById("due"),
  given: document.getElementById("given"),
  change: document.getElementById("change"),
  payForm: document.getElementById("pay-form"),
  payCancel: document.getElementById("pay-cancel"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsDialog: document.getElementById("settings-dialog"),
  settingsForm: document.getElementById("settings-form"),
  shopInput: document.getElementById("shop-input"),
  taxInput: document.getElementById("tax-input"),
  apiInput: document.getElementById("api-input"),
  productEditor: document.getElementById("product-editor"),
  addProduct: document.getElementById("add-product"),
  settingsCancel: document.getElementById("settings-cancel"),
  historyBtn: document.getElementById("history-btn"),
  historyDialog: document.getElementById("history-dialog"),
  historyList: document.getElementById("history-list"),
  historyClose: document.getElementById("history-close"),
  syncStatus: document.getElementById("sync-status"),
  banner: document.getElementById("banner"),
  loginDialog: document.getElementById("login-dialog"),
  loginForm: document.getElementById("login-form"),
  passwordInput: document.getElementById("password-input"),
  loginError: document.getElementById("login-error"),
};

function apiBase() {
  return (localStorage.getItem(API_KEY) || window.KASSIFY_CONFIG?.apiBase || "/api").replace(/\/$/, "");
}

function setStatus(text, kind) {
  els.syncStatus.textContent = text;
  els.syncStatus.className = `status ${kind || ""}`.trim();
}

function setBanner(text) {
  els.banner.hidden = !text;
  els.banner.textContent = text || "";
}

function applyServerState(payload) {
  state.shopName = payload.shopName || "Kasse";
  state.taxRate = Number(payload.taxRate || 0);
  state.products = payload.products || [];
  state.history = payload.history || [];
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase()}${path}`, { ...options, headers });
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }
  if (res.status === 401) {
    const error = new Error("auth");
    error.code = 401;
    throw error;
  }
  if (!res.ok) {
    throw new Error(payload.error || "api");
  }
  return payload;
}

async function connect() {
  try {
    const health = await api("/health");
    if (health.authRequired && !localStorage.getItem(TOKEN_KEY)) {
      setStatus("Passwort", "bad");
      setBanner("Der Server verlangt ein Passwort.");
      if (!els.loginDialog.open) els.loginDialog.showModal();
      connected = false;
      renderCart();
      return;
    }
    const data = await api("/data");
    applyServerState(data);
    connected = true;
    setStatus("Server verbunden", "ok");
    setBanner("");
    if (els.loginDialog.open) els.loginDialog.close();
    renderProducts();
    renderCart();
  } catch (error) {
    connected = false;
    if (error.code === 401) {
      localStorage.removeItem(TOKEN_KEY);
      setStatus("Passwort", "bad");
      setBanner("Bitte anmelden, um den gemeinsamen Datenbestand zu nutzen.");
      if (!els.loginDialog.open) els.loginDialog.showModal();
    } else {
      setStatus("Kein Server", "bad");
      setBanner(
        "Kein gemeinsamer Speicher. Docker auf Unraid starten und unter Einstellungen die Server-URL setzen (z. B. http://UNRAID-IP:8080/api)."
      );
    }
    renderProducts();
    renderCart();
  }
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}`;
}

function cartLines() {
  return [...cart.entries()]
    .map(([id, qty]) => {
      const product = state.products.find((item) => item.id === id);
      return product ? { ...product, qty } : null;
    })
    .filter(Boolean);
}

function totals() {
  const gross = cartLines().reduce((sum, line) => sum + line.price * line.qty, 0);
  const net = gross / (1 + state.taxRate / 100);
  return { gross, net, tax: gross - net };
}

function tick() {
  els.clock.textContent = new Date().toLocaleString("de-DE", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderProducts() {
  els.products.replaceChildren();
  for (const product of state.products) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "product";
    const emoji = document.createElement("span");
    emoji.className = "emoji";
    emoji.textContent = product.emoji || "•";
    const name = document.createElement("span");
    name.textContent = product.name;
    const price = document.createElement("span");
    price.className = "price";
    price.textContent = euro.format(product.price);
    button.append(emoji, name, price);
    button.addEventListener("click", () => addToCart(product.id));
    els.products.appendChild(button);
  }
}

function renderCart() {
  const lines = cartLines();
  els.cart.replaceChildren();
  if (!lines.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = connected ? "Noch keine Artikel." : "Warte auf Serververbindung.";
    els.cart.appendChild(empty);
  } else {
    for (const line of lines) {
      const item = document.createElement("li");
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = line.name;
      const meta = document.createElement("div");
      meta.className = "muted";
      meta.textContent = `${euro.format(line.price)} · ${euro.format(line.price * line.qty)}`;
      info.append(title, meta);
      const qty = document.createElement("div");
      qty.className = "qty";
      const dec = document.createElement("button");
      dec.type = "button";
      dec.setAttribute("aria-label", "Weniger");
      dec.textContent = "−";
      const count = document.createElement("span");
      count.textContent = String(line.qty);
      const inc = document.createElement("button");
      inc.type = "button";
      inc.setAttribute("aria-label", "Mehr");
      inc.textContent = "+";
      dec.addEventListener("click", () => changeQty(line.id, -1));
      inc.addEventListener("click", () => changeQty(line.id, 1));
      qty.append(dec, count, inc);
      item.append(info, qty);
      els.cart.appendChild(item);
    }
  }

  const { gross, net, tax } = totals();
  els.net.textContent = euro.format(net);
  els.tax.textContent = euro.format(tax);
  els.taxLabel.textContent = `${state.taxRate} %`;
  els.total.textContent = euro.format(gross);
  els.payBtn.disabled = !connected || lines.length === 0;
  els.shopName.textContent = state.shopName || "Kasse";
}

function addToCart(id) {
  if (!connected) return;
  cart.set(id, (cart.get(id) || 0) + 1);
  renderCart();
}

function changeQty(id, delta) {
  const next = (cart.get(id) || 0) + delta;
  if (next <= 0) cart.delete(id);
  else cart.set(id, next);
  renderCart();
}

function clearCart() {
  cart.clear();
  renderCart();
}

function updateChange() {
  const { gross } = totals();
  const given = Number(els.given.value || 0);
  els.due.textContent = euro.format(gross);
  els.change.textContent = euro.format(Math.max(0, given - gross));
}

function renderEditor() {
  els.productEditor.replaceChildren();
  productDraft.forEach((product, index) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    const emoji = document.createElement("input");
    emoji.dataset.field = "emoji";
    emoji.value = product.emoji || "";
    emoji.maxLength = 4;
    emoji.setAttribute("aria-label", "Symbol");
    const name = document.createElement("input");
    name.dataset.field = "name";
    name.value = product.name;
    name.setAttribute("aria-label", "Name");
    const price = document.createElement("input");
    price.dataset.field = "price";
    price.type = "number";
    price.min = "0";
    price.step = "0.01";
    price.value = String(product.price);
    price.setAttribute("aria-label", "Preis");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "✕";
    [emoji, name, price].forEach((input) => {
      input.addEventListener("input", () => {
        const field = input.dataset.field;
        productDraft[index][field] = field === "price" ? Number(input.value || 0) : input.value;
      });
    });
    del.addEventListener("click", () => {
      productDraft.splice(index, 1);
      renderEditor();
    });
    row.append(emoji, name, price, del);
    els.productEditor.appendChild(row);
  });
}

function renderHistory() {
  els.historyList.replaceChildren();
  if (!state.history.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Noch keine Verkäufe gespeichert.";
    els.historyList.appendChild(empty);
    return;
  }
  for (const sale of state.history) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = euro.format(sale.total);
    const meta = document.createElement("div");
    meta.className = "muted";
    const names = (sale.lines || []).map((line) => `${line.qty}× ${line.name}`).join(", ");
    meta.textContent = `${new Date(sale.at).toLocaleString("de-DE")} · ${names}`;
    item.append(title, meta);
    els.historyList.appendChild(item);
  }
}

els.clearBtn.addEventListener("click", clearCart);
els.payBtn.addEventListener("click", () => {
  const { gross } = totals();
  els.given.value = gross.toFixed(2);
  updateChange();
  els.payDialog.showModal();
});
els.given.addEventListener("input", updateChange);
els.payCancel.addEventListener("click", () => els.payDialog.close());
els.payForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!connected) return;
  const { gross } = totals();
  try {
    const data = await api("/sales", {
      method: "POST",
      body: JSON.stringify({
        at: new Date().toISOString(),
        total: gross,
        lines: cartLines().map(({ name, qty, price }) => ({ name, qty, price })),
      }),
    });
    applyServerState(data);
    clearCart();
    els.payDialog.close();
    renderProducts();
  } catch (error) {
    if (error.code === 401) connect();
    else setBanner("Verkauf konnte nicht gespeichert werden. Server prüfen.");
  }
});

els.settingsBtn.addEventListener("click", () => {
  settingsOpen = true;
  els.shopInput.value = state.shopName;
  els.taxInput.value = state.taxRate;
  els.apiInput.value = apiBase();
  productDraft = structuredClone(state.products);
  renderEditor();
  els.settingsDialog.showModal();
});
els.addProduct.addEventListener("click", () => {
  productDraft.push({ id: uid(), name: "Neu", price: 1, emoji: "⭐" });
  renderEditor();
});
els.settingsCancel.addEventListener("click", () => {
  settingsOpen = false;
  els.settingsDialog.close();
});
els.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const nextBase = els.apiInput.value.trim().replace(/\/$/, "") || "/api";
  localStorage.setItem(API_KEY, nextBase);
  if (!connected) {
    settingsOpen = false;
    els.settingsDialog.close();
    await connect();
    return;
  }
  state.shopName = els.shopInput.value.trim() || "Kasse";
  state.taxRate = Number(els.taxInput.value || 0);
  state.products = productDraft
    .map((product) => ({
      ...product,
      name: String(product.name || "").trim() || "Artikel",
      price: Number(product.price || 0),
    }))
    .filter((product) => product.name);
  try {
    const data = await api("/data", {
      method: "PUT",
      body: JSON.stringify({
        shopName: state.shopName,
        taxRate: state.taxRate,
        products: state.products,
      }),
    });
    applyServerState(data);
    connected = true;
    setStatus("Server verbunden", "ok");
    setBanner("");
    settingsOpen = false;
    els.settingsDialog.close();
    renderProducts();
    renderCart();
  } catch (error) {
    settingsOpen = false;
    els.settingsDialog.close();
    if (error.code === 401) connect();
    else connect();
  }
});

els.historyBtn.addEventListener("click", async () => {
  if (connected) {
    try {
      applyServerState(await api("/data"));
    } catch (error) {
      if (error.code === 401) connect();
    }
  }
  renderHistory();
  els.historyDialog.showModal();
});
els.historyClose.addEventListener("click", () => els.historyDialog.close());

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = els.passwordInput.value;
  try {
    await api("/login", { method: "POST", body: JSON.stringify({ password }) });
    localStorage.setItem(TOKEN_KEY, password);
    els.loginError.hidden = true;
    els.passwordInput.value = "";
    await connect();
  } catch {
    els.loginError.hidden = false;
  }
});

tick();
setInterval(tick, 1000);
setInterval(() => {
  if (connected && !settingsOpen && !els.loginDialog.open) connect();
}, 15000);
renderCart();
connect();
