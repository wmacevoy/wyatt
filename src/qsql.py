# ============================================================
# qsql.py — QSQL: Per-predicate typed SQLite adapter for persist
#
# Zero-impedance bridge: Prolog terms → per-predicate SQLite
# tables with typed argument columns and interval arithmetic
# for exact BigNum comparisons.
#
#   price(btc, 67432.50M)  →  table "q$price$2"
#     arg0 = 'btc', arg1 = 67432.5,
#     arg1_lo = nextDown(67432.5), arg1_hi = nextUp(67432.5),
#     arg1_x = '67432.50'
#
# Plain numbers: lo == hi, x is NULL. Zero overhead.
# BigNums: 2-ULP interval brackets the exact value.
# ============================================================

import json
import re
import struct
import math


def _safe_name(name):
    return re.sub(r'[^a-zA-Z0-9_]', '_', name)


def _table_name(functor, arity):
    return "q$%s$%d" % (_safe_name(functor), arity)


# ── IEEE 754 nextUp / nextDown ───────────────────────────────

def _next_up(x):
    if hasattr(math, 'nextafter'):
        return math.nextafter(x, float('inf'))
    if x != x or x == float('inf'):
        return x
    if x == 0.0:
        return 5e-324
    if x == float('-inf'):
        return -1.7976931348623157e+308
    buf = struct.pack('<d', x)
    bits = struct.unpack('<Q', buf)[0]
    if x > 0:
        bits += 1
    else:
        bits -= 1
    return struct.unpack('<d', struct.pack('<Q', bits))[0]


def _next_down(x):
    if hasattr(math, 'nextafter'):
        return math.nextafter(x, float('-inf'))
    return -_next_up(-x)


# ── Value conversion ─────────────────────────────────────────

def _arg_val(arg):
    """Primary value for the arg column."""
    if arg is None:
        return None
    t = arg.get("t")
    if t == "a":
        return arg["n"]
    if t == "n":
        v = arg["v"]
        if isinstance(v, (int, float)):
            return v
        return str(v)
    return json.dumps(arg, separators=(',', ':'))


def _arg_interval(arg):
    """Full interval [val, lo, hi, x] for a serialized arg.

    atom:      (name, None, None, None)
    plain num: (v,    v,    v,    None)
    BigNum:    (v,    nextDown(v), nextUp(v), rawDigits)
    """
    if arg is None:
        return (None, None, None, None)
    t = arg.get("t")
    if t == "a":
        return (arg["n"], None, None, None)
    if t == "n":
        v = arg["v"]
        if not isinstance(v, (int, float)):
            raw_s = str(v)
            for suffix in "NMLnml":
                raw_s = raw_s.rstrip(suffix)
            v = float(raw_s)
        r = arg.get("r")
        if not r:
            # Plain number — exact
            fv = float(v) if isinstance(v, int) else v
            return (v, fv, fv, None)
        # BigNum with repr — compute interval
        raw = re.sub(r'[NMLnml]$', '', r)
        fv = float(v) if isinstance(v, int) else v
        return (v, _next_down(fv), _next_up(fv), raw)
    # compound/other
    return (json.dumps(arg, separators=(',', ':')), None, None, None)


# ── Adapter Factory ──────────────────────────────────────────

def qsql_adapter(path, parse_fn=None):
    """Create a QSQL adapter with interval arithmetic.

    path      — file path or ":memory:"
    parse_fn  — optional QJSON parse function (default: json.loads)
    """
    import sqlite3
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")

    _parse = parse_fn or json.loads
    _known = {}

    def _ensure_table(functor, arity):
        fa = "%s/%d" % (functor, arity)
        if fa in _known:
            return
        tbl = _table_name(functor, arity)
        cols = []
        for i in range(arity):
            cols.append("arg%d" % i)
            cols.append("arg%d_lo REAL" % i)
            cols.append("arg%d_hi REAL" % i)
            cols.append("arg%d_x TEXT" % i)
        col_str = ", ".join(cols)
        ddl = 'CREATE TABLE IF NOT EXISTS "%s" (_key TEXT PRIMARY KEY%s)' % (
            tbl, (", " + col_str) if col_str else "")
        conn.execute(ddl)
        for i in range(arity):
            conn.execute(
                'CREATE INDEX IF NOT EXISTS "ix$%s$%d" ON "%s"(arg%d)' %
                (tbl, i, tbl, i))
            conn.execute(
                'CREATE INDEX IF NOT EXISTS "ix$%s$%dlo" ON "%s"(arg%d_lo)' %
                (tbl, i, tbl, i))
        conn.execute(
            "INSERT OR IGNORE INTO qsql_meta VALUES (?, ?)",
            (functor, arity))
        conn.commit()
        _known[fa] = True

    def _setup():
        conn.execute(
            "CREATE TABLE IF NOT EXISTS qsql_meta "
            "(functor TEXT, arity INTEGER, PRIMARY KEY(functor, arity))")
        conn.commit()
        for row in conn.execute("SELECT functor, arity FROM qsql_meta"):
            _known["%s/%d" % (row[0], row[1])] = True

    def _insert(key, functor=None, arity=None):
        if functor is None:
            return
        _ensure_table(functor, arity)
        obj = _parse(key)
        values = [key]
        if obj.get("t") == "c" and "a" in obj:
            for i in range(arity):
                if i < len(obj["a"]):
                    iv = _arg_interval(obj["a"][i])
                else:
                    iv = (None, None, None, None)
                values.extend(iv)
        tbl = _table_name(functor, arity)
        ph = ", ".join("?" for _ in values)
        conn.execute(
            'INSERT OR IGNORE INTO "%s" VALUES (%s)' % (tbl, ph),
            tuple(values))

    def _remove(key):
        try:
            obj = _parse(key)
        except (ValueError, TypeError):
            return
        if obj.get("t") == "c":
            functor = obj["f"]
            arity = len(obj.get("a", []))
        elif obj.get("t") == "a":
            functor = obj["n"]
            arity = 0
        else:
            return
        fa = "%s/%d" % (functor, arity)
        if fa not in _known:
            return
        tbl = _table_name(functor, arity)
        conn.execute('DELETE FROM "%s" WHERE _key = ?' % tbl, (key,))

    def _all(predicates=None):
        results = []
        if predicates:
            metas = []
            for pred in predicates:
                parts = pred.split("/")
                metas.append((parts[0], int(parts[1])))
        else:
            metas = conn.execute(
                "SELECT functor, arity FROM qsql_meta").fetchall()
        for functor, arity in metas:
            fa = "%s/%d" % (functor, arity)
            if fa not in _known:
                continue
            tbl = _table_name(functor, arity)
            try:
                rows = conn.execute(
                    'SELECT _key FROM "%s"' % tbl).fetchall()
                for row in rows:
                    results.append(row[0])
            except Exception:
                pass
        return results

    return {
        "setup": _setup,
        "insert": _insert,
        "remove": _remove,
        "all": _all,
        "commit": lambda: conn.commit(),
        "close": lambda: conn.close(),
    }
