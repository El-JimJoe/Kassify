const STORAGE_KEY = "kassify-v1";

const DEFAULTS = {
  shopName: "Kasse",
  taxRate: 19,
  products: [
    { id: "kaffee", name: "Kaffee", price: 2.8, emoji: "☕" },
    { id: "cappuccino", name: "Cappuccino", price: 3.5, emoji: "🧋" },
    { id: "tee", name: "Tee", price: 2.4, emoji: "🍵" },
    { id: "croissant", name: "Croissant", price: 2.2, emoji: "🥐" },
    { id: "broetchen", name: "Brötchen", price: 1.2, emoji: "🥖" },
    { id: "belegt", name: "Belegtes Brötchen", price: 3.9, emoji: "🥪" },
    { id: "wasser", name: "Wasser", price: 1.5, emoji: "💧" },
    { id: "schorle", name: "Apfelschorle", price: 2.5, emoji: "🍏" },
    { id: "kuchen", name: "Kuchen", price: 3.2, emoji: "🍰" },
    { id: "snack", name: "Snack", price: 2.0, emoji: "🥨" },
  ],
  history: [],
};

const euro = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

const state = load();
const cart = new Map();
let productDraft = [];

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
  productEditor: document.getElementById("product-editor"),
  addProduct: document.getElementById("add-product"),
  settingsCancel: document.getElementById("settings-cancel"),
  historyBtn: document.getElementById("history-btn"),
  historyDialog: document.getElementById("history-dialog"),
  historyList: document.getElementById("history-list"),
  historyClose: document.getElementById("history-close"),
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    return { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function save() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      shopName: state.shopName,
      taxRate: state.taxRate,
      products: state.products,
      history: state.history.slice(0, 50),
    })
  );
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
  els.products.innerHTML = "";
  for (const product of state.products) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "product";
    button.innerHTML = `<span class="emoji">${product.emoji || "•"}</span><span>${product.name}</span><span class="price">${euro.format(product.price)}</span>`;
    button.addEventListener("click", () => addToCart(product.id));
    els.products.appendChild(button);
  }
}

function renderCart() {
  const lines = cartLines();
  els.cart.innerHTML = "";
  if (!lines.length) {
    els.cart.innerHTML = `<li class="empty">Noch keine Artikel.</li>`;
  } else {
    for (const line of lines) {
      const item = document.createElement("li");
      item.innerHTML = `
        <div>
          <strong>${line.name}</strong>
          <div class="muted">${euro.format(line.price)} · ${euro.format(line.price * line.qty)}</div>
        </div>
        <div class="qty">
          <button type="button" data-act="dec" aria-label="Weniger">−</button>
          <span>${line.qty}</span>
          <button type="button" data-act="inc" aria-label="Mehr">+</button>
        </div>`;
      item.querySelector('[data-act="dec"]').addEventListener("click", () => changeQty(line.id, -1));
      item.querySelector('[data-act="inc"]').addEventListener("click", () => changeQty(line.id, 1));
      els.cart.appendChild(item);
    }
  }

  const { gross, net, tax } = totals();
  els.net.textContent = euro.format(net);
  els.tax.textContent = euro.format(tax);
  els.taxLabel.textContent = `${state.taxRate} %`;
  els.total.textContent = euro.format(gross);
  els.payBtn.disabled = lines.length === 0;
  els.shopName.textContent = state.shopName || "Kasse";
}

function addToCart(id) {
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
  els.productEditor.innerHTML = "";
  productDraft.forEach((product, index) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    row.innerHTML = `
      <input data-field="emoji" value="${product.emoji || ""}" maxlength="4" aria-label="Symbol" />
      <input data-field="name" value="${product.name}" aria-label="Name" />
      <input data-field="price" type="number" min="0" step="0.01" value="${product.price}" aria-label="Preis" />
      <button type="button" class="ghost" data-del>✕</button>`;
    row.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", () => {
        const field = input.dataset.field;
        productDraft[index][field] = field === "price" ? Number(input.value || 0) : input.value;
      });
    });
    row.querySelector("[data-del]").addEventListener("click", () => {
      productDraft.splice(index, 1);
      renderEditor();
    });
    els.productEditor.appendChild(row);
  });
}

function renderHistory() {
  els.historyList.innerHTML = "";
  if (!state.history.length) {
    els.historyList.innerHTML = `<li class="empty">Noch keine Verkäufe gespeichert.</li>`;
    return;
  }
  for (const sale of state.history) {
    const item = document.createElement("li");
    const names = sale.lines.map((line) => `${line.qty}× ${line.name}`).join(", ");
    item.innerHTML = `<strong>${euro.format(sale.total)}</strong><div class="muted">${new Date(sale.at).toLocaleString("de-DE")} · ${names}</div>`;
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
els.payForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const { gross } = totals();
  state.history.unshift({
    at: new Date().toISOString(),
    total: gross,
    lines: cartLines().map(({ name, qty, price }) => ({ name, qty, price })),
  });
  save();
  clearCart();
  els.payDialog.close();
});

els.settingsBtn.addEventListener("click", () => {
  els.shopInput.value = state.shopName;
  els.taxInput.value = state.taxRate;
  productDraft = structuredClone(state.products);
  renderEditor();
  els.settingsDialog.showModal();
});
els.addProduct.addEventListener("click", () => {
  productDraft.push({ id: uid(), name: "Neu", price: 1, emoji: "⭐" });
  renderEditor();
});
els.settingsCancel.addEventListener("click", () => els.settingsDialog.close());
els.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.shopName = els.shopInput.value.trim() || "Kasse";
  state.taxRate = Number(els.taxInput.value || 0);
  state.products = productDraft
    .map((product) => ({
      ...product,
      name: String(product.name || "").trim() || "Artikel",
      price: Number(product.price || 0),
    }))
    .filter((product) => product.name);
  save();
  renderProducts();
  renderCart();
  els.settingsDialog.close();
});

els.historyBtn.addEventListener("click", () => {
  renderHistory();
  els.historyDialog.showModal();
});
els.historyClose.addEventListener("click", () => els.historyDialog.close());

tick();
setInterval(tick, 1000);
renderProducts();
renderCart();
