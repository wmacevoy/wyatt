#!/usr/bin/env python3
"""Greenhouse gateway — UDP sensors in, HTTP API out.

Receives sensor readings via UDP, processes through react rules,
serves status via HTTP. Uses y8 Python engine with ephemeral/react.
"""

import json
import os
import socket
import threading
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

# ── Import y8 engine ──────────────────────────────────────
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
for _p in [os.path.join(_SCRIPT_DIR, "src"),
           os.path.join(_SCRIPT_DIR, "..", "..", "..", "src")]:
    _p = os.path.abspath(_p)
    if os.path.isdir(_p):
        sys.path.insert(0, _p)
        break

from prolog import Engine, atom, var, compound, num, obj, term_to_str

# ── Config ────────────────────────────────────────────────
UDP_PORT = int(os.environ.get("LISTEN_PORT", "9500"))
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))

# ── Compact serialization ─────────────────────────────────

def deserialize(o):
    if not o: return None
    t = o.get("t")
    if t == "a": return atom(o["n"])
    if t == "n": return num(o["v"])
    if t == "c": return compound(o["f"], [deserialize(a) for a in o["a"]])
    return None

# ── Engine setup ──────────────────────────────────────────

def create_engine():
    e = Engine()
    e.add_clause(compound("node_id", [atom("gateway")]))

    # Gateway accepts estimates from coordinator
    e.add_clause(
        compound("react", [obj([
            ("type", atom("signal")),
            ("from", atom("coordinator")),
            ("fact", compound("estimate", [var("T"), var("N"), var("V"), var("C"), var("Ts")]))
        ])]),
        [
            compound("retractall", [compound("estimate", [var("T"), var("N"), var("_A"), var("_B"), var("_C")])]),
            compound("assert", [compound("estimate", [var("T"), var("N"), var("V"), var("C"), var("Ts")])])
        ]
    )

    # Gateway accepts alert_notice from coordinator
    e.add_clause(
        compound("react", [obj([
            ("type", atom("signal")),
            ("from", atom("coordinator")),
            ("fact", compound("alert_notice", [var("Node"), var("Type"), var("Level")]))
        ])]),
        [
            compound("retractall", [compound("alert_notice", [var("Node"), var("Type"), var("_L")])]),
            compound("assert", [compound("alert_notice", [var("Node"), var("Type"), var("Level")])])
        ]
    )

    return e

# ── UDP listener ──────────────────────────────────────────

def udp_listener(engine, lock):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", UDP_PORT))
    print(f"[gateway] UDP :{UDP_PORT}")

    while True:
        try:
            data, addr = sock.recvfrom(4096)
            msg = json.loads(data)
            if msg.get("kind") != "signal":
                continue

            fact = deserialize(msg.get("fact"))
            if not fact:
                continue

            with lock:
                engine._sends = []
                engine.query_first(compound("ephemeral", [obj([
                    ("type", atom("signal")),
                    ("from", atom(msg.get("from", ""))),
                    ("fact", fact)
                ])]))

        except Exception as e:
            print(f"[gateway] error: {e}")

# ── HTTP API ──────────────────────────────────────────────

def make_handler(engine, lock):
    class H(BaseHTTPRequestHandler):
        def _json(self, status, body):
            p = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(p)

        def do_GET(self):
            path = self.path.split("?")[0]
            with lock:
                if path == "/api/health":
                    self._json(200, {"ok": True, "node": "gateway"})
                elif path == "/api/alerts":
                    results = engine.query(compound("alert_notice", [var("T"), var("N"), var("L")]))
                    self._json(200, [{"type": r[2][0][1], "node": r[2][1][1], "level": r[2][2][1]} for r in results])
                elif path == "/api/estimates":
                    results = engine.query(compound("estimate", [var("T"), var("N"), var("V"), var("C"), var("Ts")]))
                    self._json(200, [{"type": r[2][0][1], "node": r[2][1][1], "value": r[2][2][1]} for r in results])
                else:
                    self._json(404, {"error": "not found"})

        def log_message(self, *a): pass
    return H

# ── Main ──────────────────────────────────────────────────

def main():
    engine = create_engine()
    lock = threading.Lock()

    threading.Thread(target=udp_listener, args=(engine, lock), daemon=True).start()

    print(f"[gateway] HTTP :{HTTP_PORT}")
    HTTPServer(("0.0.0.0", HTTP_PORT), make_handler(engine, lock)).serve_forever()

if __name__ == "__main__":
    main()
