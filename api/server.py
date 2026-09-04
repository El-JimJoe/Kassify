#!/usr/bin/env python3
import hmac
import json
import os
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DATA_DIR = os.environ.get("KASSIFY_DATA", "/data")
DB_PATH = os.path.join(DATA_DIR, "kassify.db")
PASSWORD = os.environ.get("KASSIFY_PASSWORD", "")
CORS = os.environ.get("KASSIFY_CORS", "*")
HOST = os.environ.get("KASSIFY_HOST", "127.0.0.1")
PORT = int(os.environ.get("KASSIFY_PORT", "3000"))

DEFAULT_PRODUCTS = [
    {"id": "kaffee", "name": "Kaffee", "price": 2.8, "emoji": "☕"},
    {"id": "cappuccino", "name": "Cappuccino", "price": 3.5, "emoji": "🧋"},
    {"id": "tee", "name": "Tee", "price": 2.4, "emoji": "🍵"},
    {"id": "croissant", "name": "Croissant", "price": 2.2, "emoji": "🥐"},
    {"id": "broetchen", "name": "Brötchen", "price": 1.2, "emoji": "🥖"},
    {"id": "belegt", "name": "Belegtes Brötchen", "price": 3.9, "emoji": "🥪"},
    {"id": "wasser", "name": "Wasser", "price": 1.5, "emoji": "💧"},
    {"id": "schorle", "name": "Apfelschorle", "price": 2.5, "emoji": "🍏"},
    {"id": "kuchen", "name": "Kuchen", "price": 3.2, "emoji": "🍰"},
    {"id": "snack", "name": "Snack", "price": 2.0, "emoji": "🥨"},
]

lock = threading.Lock()


def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            emoji TEXT,
            sort INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            total REAL NOT NULL,
            lines TEXT NOT NULL
        )
        """
    )
    conn.commit()
    seed(conn)
    return conn


def setting(conn, key, default):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if not row:
        return default
    return json.loads(row["value"])


def put_setting(conn, key, value):
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )


def seed(conn):
    count = conn.execute("SELECT COUNT(*) AS n FROM products").fetchone()["n"]
    if count:
        return
    put_setting(conn, "shopName", "Kasse")
    put_setting(conn, "taxRate", 19)
    for index, product in enumerate(DEFAULT_PRODUCTS):
        conn.execute(
            "INSERT INTO products(id, name, price, emoji, sort) VALUES(?, ?, ?, ?, ?)",
            (product["id"], product["name"], product["price"], product["emoji"], index),
        )
    conn.commit()


def read_state(conn):
    products = [
        {
            "id": row["id"],
            "name": row["name"],
            "price": row["price"],
            "emoji": row["emoji"] or "",
        }
        for row in conn.execute("SELECT id, name, price, emoji FROM products ORDER BY sort, name")
    ]
    sales = []
    for row in conn.execute(
        "SELECT at, total, lines FROM sales ORDER BY id DESC LIMIT 200"
    ):
        sales.append(
            {
                "at": row["at"],
                "total": row["total"],
                "lines": json.loads(row["lines"]),
            }
        )
    return {
        "shopName": setting(conn, "shopName", "Kasse"),
        "taxRate": setting(conn, "taxRate", 19),
        "products": products,
        "history": sales,
        "authRequired": bool(PASSWORD),
    }


def replace_products(conn, products):
    conn.execute("DELETE FROM products")
    for index, product in enumerate(products):
        name = str(product.get("name") or "").strip() or "Artikel"
        product_id = str(product.get("id") or f"p-{index}")
        price = float(product.get("price") or 0)
        emoji = str(product.get("emoji") or "")[:8]
        conn.execute(
            "INSERT INTO products(id, name, price, emoji, sort) VALUES(?, ?, ?, ?, ?)",
            (product_id, name, price, emoji, index),
        )


CONN = connect()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"api: {self.address_string()} {format % args}")

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", CORS)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")

    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def authorized(self):
        if not PASSWORD:
            return True
        header = self.headers.get("Authorization") or ""
        expected = f"Bearer {PASSWORD}"
        return hmac.compare_digest(header.encode("utf-8"), expected.encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/api/health":
            self.send_json(200, {"ok": True, "authRequired": bool(PASSWORD)})
            return
        if not self.authorized():
            self.send_json(401, {"error": "password_required"})
            return
        if path == "/api/data":
            with lock:
                self.send_json(200, read_state(CONN))
            return
        self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/api/login":
            payload = self.read_json()
            password = str(payload.get("password") or "")
            if not PASSWORD or hmac.compare_digest(password, PASSWORD):
                self.send_json(200, {"ok": True})
            else:
                self.send_json(401, {"error": "invalid_password"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "password_required"})
            return
        if path == "/api/sales":
            payload = self.read_json()
            lines = payload.get("lines") or []
            if not isinstance(lines, list) or not lines:
                self.send_json(400, {"error": "empty_sale"})
                return
            total = float(payload.get("total") or 0)
            at = str(payload.get("at") or "")
            with lock:
                CONN.execute(
                    "INSERT INTO sales(at, total, lines) VALUES(?, ?, ?)",
                    (at, total, json.dumps(lines, ensure_ascii=False)),
                )
                CONN.commit()
                self.send_json(201, read_state(CONN))
            return
        self.send_json(404, {"error": "not_found"})

    def do_PUT(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if not self.authorized():
            self.send_json(401, {"error": "password_required"})
            return
        if path != "/api/data":
            self.send_json(404, {"error": "not_found"})
            return
        payload = self.read_json()
        products = payload.get("products")
        if not isinstance(products, list):
            self.send_json(400, {"error": "products_required"})
            return
        shop_name = str(payload.get("shopName") or "").strip() or "Kasse"
        tax_rate = float(payload.get("taxRate") or 0)
        with lock:
            put_setting(CONN, "shopName", shop_name)
            put_setting(CONN, "taxRate", tax_rate)
            replace_products(CONN, products)
            CONN.commit()
            self.send_json(200, read_state(CONN))


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Kassify API on {HOST}:{PORT} db={DB_PATH} auth={bool(PASSWORD)}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
