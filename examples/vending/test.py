# ============================================================
# test.py — Self-contained tests, zero dependencies
#
# Run with:
#   python src/test.py
#   micropython src/test.py
# ============================================================

import sys, os
_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_dir, "..", "..", "src"))
sys.path.insert(0, _dir)

from prolog import Engine, atom, var, compound, num, lst, term_to_str, list_to_py
from reactive import signal, memo, effect
from reactive_prolog import ReactiveEngine
from vending import build_vending_kb, update_sensor

a, v, c, n = atom, var, compound, num

# ── Test harness ─────────────────────────────────────────────

_suites = []
_current = [None]
_pass = [0]
_fail = [0]

def describe(name, fn):
    print("  " + name)
    _current[0] = name
    fn()

def it(name, fn):
    try:
        fn()
        _pass[0] += 1
        print("    \u2713 " + name)
    except Exception as e:
        _fail[0] += 1
        print("    \u2717 " + name)
        print("      " + str(e))

def eq(a, b):
    if a != b:
        raise AssertionError("got %r, want %r" % (a, b))

def neq(a, b):
    if a == b:
        raise AssertionError("got equal: %r" % (a,))

def ok(v, msg=""):
    if not v:
        raise AssertionError(msg or ("not truthy: %r" % (v,)))

# ── Query helpers ────────────────────────────────────────────

def get_credit(e):
    r = e.query_first(c("credit", [v("C")]))
    return r[2][0][1] if r else 0

def get_state(e):
    r = e.query_first(c("machine_state", [v("S")]))
    return r[2][0][1] if r else "?"

def get_display(e):
    r = e.query_first(c("display_message", [v("M")]))
    return r[2][0][1] if r else "?"

def get_faults(e):
    r = e.query_first(c("all_faults", [v("F")]))
    return [t[1] for t in list_to_py(r[2][0])] if r else []

def get_available(e):
    r = e.query_first(c("available_slots", [v("S")]))
    return [t[1] for t in list_to_py(r[2][0])] if r else []

# ════════════════════════════════════════════════════════════
# TESTS
# ════════════════════════════════════════════════════════════

print("\n  Prolog-Embedded — Vending Machine Policy Engine\n")

describe("Happy path", lambda: (
    it("starts idle, zero credit, INSERT COINS", lambda: (
        eq(get_state(build_vending_kb()), "idle"),
        eq(get_credit(build_vending_kb()), 0),
        eq(get_display(build_vending_kb()), "INSERT COINS"),
    )),
    it("accepts coins", lambda: (
        (e := build_vending_kb()),
        e.query_first(c("do_insert_coin", [n(25)])),
        eq(get_credit(e), 25),
        e.query_first(c("do_insert_coin", [n(100)])),
        eq(get_credit(e), 125),
    )),
    it("vends and gives change", lambda: (
        (e := build_vending_kb()),
        e.query_first(c("do_insert_coin", [n(100)])),
        e.query_first(c("do_insert_coin", [n(100)])),
        e.query_first(c("do_select", [a("a1")])),
        eq(get_credit(e), 75),
        eq(get_state(e), "vending"),
    )),
    it("decrements inventory", lambda: (
        (e := build_vending_kb()),
        e.query_first(c("do_insert_coin", [n(125)])),
        e.query_first(c("do_select", [a("a1")])),
        eq(e.query_first(c("inventory", [a("a1"), v("C")]))[2][1][1], 7),
    )),
    it("returns to idle", lambda: (
        (e := build_vending_kb()),
        e.query_first(c("do_insert_coin", [n(125)])),
        e.query_first(c("do_select", [a("a1")])),
        e.query_first(c("do_vend_complete", [])),
        eq(get_state(e), "idle"),
    )),
    it("returns credit", lambda: (
        (e := build_vending_kb()),
        e.query_first(c("do_insert_coin", [n(100)])),
        e.query_first(c("do_return_credit", [])),
        eq(get_credit(e), 0),
    )),
))

describe("Fault detection", lambda: (
    it("tilt sensor -> fault -> display", lambda: (
        (e := build_vending_kb()),
        eq(get_faults(e), []),
        update_sensor(e, "tilt", "tilted"),
        eq(get_faults(e), ["tilt_detected"]),
        eq(get_display(e), "OUT OF ORDER"),
    )),
    it("multiple simultaneous faults", lambda: (
        (e := build_vending_kb()),
        update_sensor(e, "tilt", "tilted"),
        update_sensor(e, "door", "open"),
        ok("tilt_detected" in get_faults(e)),
        ok("door_open" in get_faults(e)),
    )),
    it("fault clears on recovery", lambda: (
        (e := build_vending_kb()),
        update_sensor(e, "tilt", "tilted"),
        update_sensor(e, "tilt", "ok"),
        eq(get_faults(e), []),
    )),
))

describe("Faults block vending", lambda: (
    it("tilt blocks coin insert", lambda: (
        (e := build_vending_kb()),
        update_sensor(e, "tilt", "tilted"),
        eq(e.query_first(c("do_insert_coin", [n(25)])), None),
    )),
    it("tilt blocks vend even with credit", lambda: (
        (e := build_vending_kb()),
        e.query_first(c("do_insert_coin", [n(125)])),
        update_sensor(e, "tilt", "tilted"),
        eq(e.query_first(c("do_select", [a("a1")])), None),
    )),
    it("motor_a1 stuck blocks a1, not a2", lambda: (
        (e := build_vending_kb()),
        e.query_first(c("do_insert_coin", [n(200)])),
        update_sensor(e, "motor_a1", "stuck"),
        eq(e.query_first(c("can_vend", [a("a1")])), None),
        neq(e.query_first(c("can_vend", [a("a2")])), None),
    )),
    it("delivery blocked stops all", lambda: (
        (e := build_vending_kb()),
        e.query_first(c("do_insert_coin", [n(200)])),
        update_sensor(e, "delivery", "blocked"),
        eq(get_available(e), []),
    )),
))

describe("Fault response", lambda: (
    it("tilt -> lock_and_alarm", lambda: (
        (e := build_vending_kb()),
        update_sensor(e, "tilt", "tilted"),
        eq(e.query_first(c("fault_response", [a("tilt_detected"), v("A")]))[2][1][1], "lock_and_alarm"),
    )),
    it("overtemp -> compressor_boost", lambda: (
        (e := build_vending_kb()),
        update_sensor(e, "temp", "hot"),
        eq(e.query_first(c("fault_response", [a("overtemp"), v("A")]))[2][1][1], "compressor_boost"),
    )),
))

describe("Reactive layer", lambda: (
    it("display recomputes on sensor change", lambda: (
        (e := build_vending_kb()),
        (rp := ReactiveEngine(e)),
        (display := rp.query_first(lambda: c("display_message", [v("M")]))),
        eq(display()[2][0][1], "INSERT COINS"),
        update_sensor(e, "tilt", "tilted"),
        rp.bump(),
        eq(display()[2][0][1], "OUT OF ORDER"),
        update_sensor(e, "tilt", "ok"),
        rp.bump(),
        eq(display()[2][0][1], "INSERT COINS"),
    )),
    it("full: insert -> tilt -> recover -> vend", lambda: (
        (e := build_vending_kb()),
        (rp := ReactiveEngine(e)),
        (credit := rp.query_first(lambda: c("credit", [v("C")]))),
        rp.act(c("do_insert_coin", [n(125)])),
        eq(credit()[2][0][1], 125),
        update_sensor(e, "tilt", "tilted"),
        rp.bump(),
        eq(rp.act(c("do_select", [a("a1")])), None),
        update_sensor(e, "tilt", "ok"),
        rp.bump(),
        rp.act(c("do_select", [a("a1")])),
        eq(credit()[2][0][1], 0),
    )),
))

# ── Summary ──────────────────────────────────────────────────

print("\n  %d passing, %d failing\n" % (_pass[0], _fail[0]))
if _fail[0] > 0:
    sys.exit(1)
