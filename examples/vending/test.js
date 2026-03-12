// ============================================================
// test.js — Self-contained test runner
//
// Run with ANY JavaScript runtime:
//   qjs --module src/test.js
//   node src/test.js
//   deno run src/test.js
//
// No node:test.  No npm.  No package.json.  No dependencies.
// ============================================================

// ── print() polyfill ────────────────────────────────────────
var _print = (typeof print !== "undefined") ? print : console.log.bind(console);

// ── Minimal test harness ────────────────────────────────────
var _suites = [];
var _current = null;

function describe(name, fn) {
  var s = { name: name, tests: [], pass: 0, fail: 0 };
  _suites.push(s);
  _current = s;
  fn();
  _current = null;
}

function it(name, fn) {
  _current.tests.push({ name: name, fn: fn });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
assert.equal    = function(a, b) { if (a !== b) throw new Error("got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); };
assert.notEqual = function(a, b) { if (a === b) throw new Error("got equal: " + JSON.stringify(a)); };
assert.ok       = function(v, m) { if (!v) throw new Error(m || "not truthy: " + JSON.stringify(v)); };
assert.deepEqual = function(a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); };

function runTests() {
  var totalPass = 0, totalFail = 0;
  for (var si = 0; si < _suites.length; si++) {
    var suite = _suites[si];
    _print("  " + suite.name);
    for (var ti = 0; ti < suite.tests.length; ti++) {
      var test = suite.tests[ti];
      try {
        test.fn();
        suite.pass++; totalPass++;
        _print("    \u2713 " + test.name);
      } catch (e) {
        suite.fail++; totalFail++;
        _print("    \u2717 " + test.name);
        _print("      " + (e.message || e));
      }
    }
  }
  _print("\n  " + totalPass + " passing, " + totalFail + " failing\n");
  if (totalFail > 0 && typeof process !== "undefined" && process.exit) process.exit(1);
  return totalFail;
}

// ── Imports ─────────────────────────────────────────────────

import { PrologEngine, termToString, listToArray } from "../../src/prolog-engine.js";
import { createSignal, createMemo, createEffect } from "../../src/reactive.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { buildVendingKB, updateSensor } from "./vending-kb.js";

var at = PrologEngine.atom, v = PrologEngine.variable;
var c = PrologEngine.compound, n = PrologEngine.num;

// ── Query helpers ───────────────────────────────────────────

function getCredit(e)  { var r = e.queryFirst(c("credit",[v("C")])); return r ? r.args[0].value : 0; }
function getState(e)   { var r = e.queryFirst(c("machine_state",[v("S")])); return r ? r.args[0].name : "?"; }
function getDisplay(e) { var r = e.queryFirst(c("display_message",[v("M")])); return r ? r.args[0].name : "?"; }
function getFaults(e)  { var r = e.queryFirst(c("all_faults",[v("F")])); return r ? listToArray(r.args[0]).map(function(t){return t.name;}) : []; }
function getAvailable(e) { var r = e.queryFirst(c("available_slots",[v("S")])); return r ? listToArray(r.args[0]).map(function(t){return t.name;}) : []; }

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe("Happy path", function() {
  it("starts idle, zero credit, INSERT COINS", function() {
    var e = buildVendingKB();
    assert.equal(getState(e), "idle");
    assert.equal(getCredit(e), 0);
    assert.equal(getDisplay(e), "INSERT COINS");
  });
  it("accepts coins", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(25)]));
    assert.equal(getCredit(e), 25);
    e.queryFirst(c("do_insert_coin",[n(100)]));
    assert.equal(getCredit(e), 125);
  });
  it("vends and gives change", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(100)]));
    e.queryFirst(c("do_insert_coin",[n(100)]));
    e.queryFirst(c("do_select",[at("a1")])); // cola 125¢
    assert.equal(getCredit(e), 75); // 200-125
    assert.equal(getState(e), "vending");
  });
  it("decrements inventory", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(125)]));
    e.queryFirst(c("do_select",[at("a1")]));
    assert.equal(e.queryFirst(c("inventory",[at("a1"),v("C")])).args[1].value, 7);
  });
  it("returns to idle", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(125)]));
    e.queryFirst(c("do_select",[at("a1")]));
    e.queryFirst(c("do_vend_complete",[]));
    assert.equal(getState(e), "idle");
  });
  it("returns credit", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(100)]));
    e.queryFirst(c("do_return_credit",[]));
    assert.equal(getCredit(e), 0);
  });
});

describe("Fault detection", function() {
  it("tilt sensor → tilt fault → display", function() {
    var e = buildVendingKB();
    assert.deepEqual(getFaults(e), []);
    updateSensor(e, "tilt", "tilted");
    assert.deepEqual(getFaults(e), ["tilt_detected"]);
    assert.equal(getDisplay(e), "OUT OF ORDER — TILT DETECTED");
  });
  it("multiple simultaneous faults", function() {
    var e = buildVendingKB();
    updateSensor(e, "tilt", "tilted");
    updateSensor(e, "door", "open");
    var f = getFaults(e);
    assert.ok(f.indexOf("tilt_detected") >= 0);
    assert.ok(f.indexOf("door_open") >= 0);
  });
  it("fault clears when sensor recovers", function() {
    var e = buildVendingKB();
    updateSensor(e, "tilt", "tilted");
    updateSensor(e, "tilt", "ok");
    assert.deepEqual(getFaults(e), []);
    assert.equal(getDisplay(e), "INSERT COINS");
  });
});

describe("Faults block vending", function() {
  it("tilt blocks coin insert", function() {
    var e = buildVendingKB();
    updateSensor(e, "tilt", "tilted");
    assert.equal(e.queryFirst(c("do_insert_coin",[n(25)])), null);
  });
  it("tilt blocks vend even with credit", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(125)]));
    updateSensor(e, "tilt", "tilted");
    assert.equal(e.queryFirst(c("do_select",[at("a1")])), null);
    assert.equal(getState(e), "idle");
  });
  it("motor_a1 stuck blocks a1, not a2", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(200)]));
    updateSensor(e, "motor_a1", "stuck");
    assert.equal(e.queryFirst(c("can_vend",[at("a1")])), null);
    assert.notEqual(e.queryFirst(c("can_vend",[at("a2")])), null);
  });
  it("delivery blocked stops all vending", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(200)]));
    updateSensor(e, "delivery", "blocked");
    assert.deepEqual(getAvailable(e), []);
  });
  it("out of stock one slot, others fine", function() {
    var e = buildVendingKB();
    for (var i = 0; i < 8; i++) {
      e.queryFirst(c("do_insert_coin",[n(125)]));
      e.queryFirst(c("do_select",[at("a1")]));
      e.queryFirst(c("do_vend_complete",[]));
    }
    e.queryFirst(c("do_insert_coin",[n(125)]));
    assert.equal(e.queryFirst(c("can_vend",[at("a1")])), null);
    assert.notEqual(e.queryFirst(c("can_vend",[at("a2")])), null);
  });
});

describe("Fault response policy", function() {
  it("tilt → lock_and_alarm", function() {
    var e = buildVendingKB();
    updateSensor(e, "tilt", "tilted");
    assert.equal(e.queryFirst(c("fault_response",[at("tilt_detected"),v("A")])).args[1].name, "lock_and_alarm");
  });
  it("overtemp → compressor_boost", function() {
    var e = buildVendingKB();
    updateSensor(e, "temp", "hot");
    assert.equal(e.queryFirst(c("fault_response",[at("overtemp"),v("A")])).args[1].name, "compressor_boost");
  });
  it("power fault with credit → emergency return", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(100)]));
    updateSensor(e, "power", "low");
    assert.notEqual(e.queryFirst(c("should_return_credit_on_fault",[])), null);
  });
});

describe("Diagnostics", function() {
  it("reports insufficient credit", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(50)]));
    assert.equal(e.queryFirst(c("vend_blocked_reason",[at("a1"),v("R")])).args[1].name, "insufficient_credit");
  });
  it("reports fault as reason", function() {
    var e = buildVendingKB();
    e.queryFirst(c("do_insert_coin",[n(200)]));
    updateSensor(e, "door", "open");
    assert.equal(e.queryFirst(c("vend_blocked_reason",[at("a1"),v("R")])).args[1].name, "has_fault");
  });
});

describe("Reactive layer", function() {
  it("display recomputes on sensor change", function() {
    var e = buildVendingKB();
    var rp = createReactiveEngine(e);
    var display = rp.createQueryFirst(function(){return c("display_message",[v("M")]);});
    assert.equal(display().args[0].name, "INSERT COINS");
    updateSensor(e, "tilt", "tilted"); rp.bump();
    assert.equal(display().args[0].name, "OUT OF ORDER — TILT DETECTED");
    updateSensor(e, "tilt", "ok"); rp.bump();
    assert.equal(display().args[0].name, "INSERT COINS");
  });
  it("available slots update when motor fails", function() {
    var e = buildVendingKB();
    var rp = createReactiveEngine(e);
    rp.act(c("do_insert_coin",[n(200)]));
    var avail = rp.createQueryFirst(function(){return c("available_slots",[v("S")]);});
    var slots = function(){return listToArray(avail().args[0]).map(function(t){return t.name;});};
    assert.ok(slots().indexOf("a1") >= 0);
    updateSensor(e, "motor_a1", "stuck"); rp.bump();
    assert.ok(slots().indexOf("a1") < 0);
    updateSensor(e, "motor_a1", "ready"); rp.bump();
    assert.ok(slots().indexOf("a1") >= 0);
  });
  it("full: insert → tilt → recover → vend", function() {
    var e = buildVendingKB();
    var rp = createReactiveEngine(e);
    var display = rp.createQueryFirst(function(){return c("display_message",[v("M")]);});
    var credit = rp.createQueryFirst(function(){return c("credit",[v("C")]);});
    rp.act(c("do_insert_coin",[n(125)]));
    assert.equal(credit().args[0].value, 125);
    updateSensor(e, "tilt", "tilted"); rp.bump();
    assert.equal(display().args[0].name, "OUT OF ORDER — TILT DETECTED");
    assert.equal(rp.act(c("do_select",[at("a1")])), null);
    updateSensor(e, "tilt", "ok"); rp.bump();
    rp.act(c("do_select",[at("a1")]));
    assert.equal(credit().args[0].value, 0);
  });
});

// ── Run ─────────────────────────────────────────────────────

var failures = runTests();
