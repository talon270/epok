#!/usr/bin/env python3
"""A stand-in for the Hrana-over-HTTP pipeline endpoint, backed by in-memory SQLite.

This is NOT Turso and proves nothing about Turso. It exists so tools/verify.py can
drive js/sync.js end to end — set up, join from a second device, conflict, offline,
delete — against a server that speaks the documented request and response shape.
What it cannot tell you: whether a browser may call a real Turso endpoint directly
(CORS), or whether the real service accepts exactly this request. That is C0 in
PLAN-features-sync.md and needs a real database and token.

    python3 tools/mock_turso.py --port 8765 --token secret

Test-only extras: GET /__dump returns every stored row, so a test can assert the
database holds no plaintext. It needs the same bearer token.
"""
from __future__ import annotations

import argparse
import base64
import json
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

DB = sqlite3.connect(":memory:", check_same_thread=False)
LOCK = threading.Lock()
TOKEN = ""


def to_value(v: Any) -> dict:
    if v is None:
        return {"type": "null"}
    if isinstance(v, int):
        return {"type": "integer", "value": str(v)}
    if isinstance(v, float):
        return {"type": "float", "value": v}
    if isinstance(v, bytes):
        return {"type": "blob", "base64": base64.b64encode(v).decode()}
    return {"type": "text", "value": str(v)}


def from_arg(a: dict) -> Any:
    t = a.get("type")
    if t == "null":
        return None
    if t == "integer":
        return int(a["value"])
    if t == "float":
        return float(a["value"])
    if t == "blob":
        return base64.b64decode(a["base64"])
    return a["value"]


def execute(stmt: dict) -> dict:
    cur = DB.execute(stmt["sql"], [from_arg(a) for a in stmt.get("args", [])])
    cols = [{"name": d[0]} for d in (cur.description or [])]
    rows = [[to_value(x) for x in r] for r in cur.fetchall()]
    DB.commit()
    return {"cols": cols, "rows": rows, "affected_row_count": max(cur.rowcount, 0), "last_insert_rowid": None}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_: Any) -> None:  # keep test output quiet
        pass

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _send(self, code: int, body: dict | None = None) -> None:
        raw = json.dumps(body).encode() if body is not None else b""
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authed(self) -> bool:
        return self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def do_OPTIONS(self) -> None:
        self._send(204)

    def do_GET(self) -> None:
        if not self._authed():
            return self._send(401, {"error": "bad token"})
        if self.path == "/__dump":
            with LOCK:
                recs = [dict(zip(("id", "kind", "hash", "payload", "updated_at", "deleted"), r))
                        for r in DB.execute("SELECT id, kind, hash, payload, updated_at, deleted FROM epok_records")] \
                    if DB.execute("SELECT name FROM sqlite_master WHERE name='epok_records'").fetchone() else []
                meta = [dict(zip(("k", "v"), r)) for r in DB.execute("SELECT k, v FROM epok_meta")] \
                    if DB.execute("SELECT name FROM sqlite_master WHERE name='epok_meta'").fetchone() else []
            return self._send(200, {"records": recs, "meta": meta})
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._authed():
            return self._send(401, {"error": "bad token"})
        if self.path != "/v2/pipeline":
            return self._send(404, {"error": "not found"})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        results = []
        with LOCK:
            for req in body.get("requests", []):
                if req.get("type") == "execute":
                    try:
                        results.append({"type": "ok", "response": {"type": "execute", "result": execute(req["stmt"])}})
                    except Exception as e:  # a statement error is a result, not an HTTP failure
                        results.append({"type": "error", "error": {"message": str(e)}})
                elif req.get("type") == "close":
                    results.append({"type": "ok", "response": {"type": "close"}})
        self._send(200, {"baton": None, "base_url": None, "results": results})


def main() -> None:
    global TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--token", required=True)
    args = ap.parse_args()
    TOKEN = args.token
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("READY", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
