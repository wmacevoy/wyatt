// ============================================================
// test.js — Tutorial test suite
//
// Run with ANY JavaScript runtime:
//   node examples/tutorial/test.js
//   bun run examples/tutorial/test.js
//   qjs --module examples/tutorial/test.js
//   deno run examples/tutorial/test.js
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

import { PrologEngine, listToArray } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { createEffect } from "../../src/reactive.js";

var atom     = PrologEngine.atom;
var compound = PrologEngine.compound;
var num      = PrologEngine.num;
var variable = PrologEngine.variable;
var list     = PrologEngine.list;

// ── Step 1: Facts and queries ───────────────────────────────

describe("01 — Facts and queries", function() {
  var e = new PrologEngine();
  e.addClause(compound("room", [atom("kitchen")]));
  e.addClause(compound("room", [atom("bedroom")]));
  e.addClause(compound("room", [atom("garage")]));
  e.addClause(compound("temperature", [atom("kitchen"), num(72)]));
  e.addClause(compound("temperature", [atom("bedroom"), num(68)]));
  e.addClause(compound("temperature", [atom("garage"), num(55)]));

  it("query returns all matching facts", function() {
    var rooms = e.query(compound("room", [variable("R")]));
    assert.equal(rooms.length, 3);
  });

  it("queryFirst returns the first match", function() {
    var r = e.queryFirst(compound("temperature", [atom("kitchen"), variable("T")]));
    assert.ok(r);
    assert.equal(r.args[1].value, 72);
  });

  it("queryFirst returns null for no match", function() {
    var r = e.queryFirst(compound("temperature", [atom("attic"), variable("T")]));
    assert.equal(r, null);
  });
});

// ── Step 2: Rules ───────────────────────────────────────────

describe("02 — Rules", function() {
  var e = new PrologEngine();
  e.addClause(compound("temperature", [atom("kitchen"), num(72)]));
  e.addClause(compound("temperature", [atom("bedroom"), num(68)]));
  e.addClause(compound("temperature", [atom("garage"), num(55)]));
  e.addClause(compound("target_temp", [atom("kitchen"), num(70)]));
  e.addClause(compound("target_temp", [atom("bedroom"), num(72)]));
  e.addClause(compound("target_temp", [atom("garage"), num(50)]));

  // cold(Room) :- temperature(Room, T), T < 65.
  e.addClause(compound("cold", [variable("Room")]), [
    compound("temperature", [variable("Room"), variable("T")]),
    compound("<", [variable("T"), num(65)])
  ]);

  // needs_heating(Room) :- temperature(Room, T), target_temp(Room, Target), T < Target.
  e.addClause(compound("needs_heating", [variable("Room")]), [
    compound("temperature", [variable("Room"), variable("T")]),
    compound("target_temp", [variable("Room"), variable("Target")]),
    compound("<", [variable("T"), variable("Target")])
  ]);

  it("cold rule matches rooms below 65", function() {
    var cold = e.query(compound("cold", [variable("R")]));
    assert.equal(cold.length, 1);
    assert.equal(cold[0].args[0].name, "garage");
  });

  it("needs_heating uses target comparison", function() {
    var heating = e.query(compound("needs_heating", [variable("R")]));
    assert.equal(heating.length, 1);
    assert.equal(heating[0].args[0].name, "bedroom");
  });
});

// ── Step 3: Arithmetic ─────────────────────────────────────

describe("03 — Arithmetic", function() {
  var e = new PrologEngine();
  e.addClause(compound("temperature", [atom("kitchen"), num(72)]));
  e.addClause(compound("target_temp", [atom("kitchen"), num(70)]));

  // temp_diff(Room, Diff) :- temperature(Room, T), target_temp(Room, Target),
  //                          Diff is Target - T.
  e.addClause(compound("temp_diff", [variable("Room"), variable("Diff")]), [
    compound("temperature", [variable("Room"), variable("T")]),
    compound("target_temp", [variable("Room"), variable("Target")]),
    compound("is", [variable("Diff"), compound("-", [variable("Target"), variable("T")])])
  ]);

  // comfortable(Room) :- temperature(Room, T), target_temp(Room, Target),
  //                      T >= Target, T =< Target + 5.
  e.addClause(compound("comfortable", [variable("Room")]), [
    compound("temperature", [variable("Room"), variable("T")]),
    compound("target_temp", [variable("Room"), variable("Target")]),
    compound(">=", [variable("T"), variable("Target")]),
    compound("=<", [variable("T"), compound("+", [variable("Target"), num(5)])])
  ]);

  it("is/2 evaluates arithmetic", function() {
    var r = e.queryFirst(compound("temp_diff", [atom("kitchen"), variable("D")]));
    assert.ok(r);
    assert.equal(r.args[1].value, -2);
  });

  it("comfortable uses range comparison", function() {
    var r = e.queryFirst(compound("comfortable", [atom("kitchen")]));
    assert.ok(r);
  });
});

// ── Step 4: Lists ───────────────────────────────────────────

describe("04 — Lists and member", function() {
  var e = new PrologEngine();
  e.addClause(compound("room", [atom("kitchen")]));
  e.addClause(compound("room", [atom("bedroom")]));
  e.addClause(compound("room", [atom("garage")]));
  e.addClause(compound("heating_schedule", [
    list([atom("kitchen"), atom("bedroom")])
  ]));

  // scheduled(Room) :- heating_schedule(Rooms), member(Room, Rooms).
  e.addClause(compound("scheduled", [variable("Room")]), [
    compound("heating_schedule", [variable("Rooms")]),
    compound("member", [variable("Room"), variable("Rooms")])
  ]);

  // unscheduled(Room) :- room(Room), not(scheduled(Room)).
  e.addClause(compound("unscheduled", [variable("Room")]), [
    compound("room", [variable("Room")]),
    compound("not", [compound("scheduled", [variable("Room")])])
  ]);

  it("member/2 finds list elements", function() {
    var s = e.query(compound("scheduled", [variable("R")]));
    assert.equal(s.length, 2);
  });

  it("negation + member finds unscheduled rooms", function() {
    var u = e.query(compound("unscheduled", [variable("R")]));
    assert.equal(u.length, 1);
    assert.equal(u[0].args[0].name, "garage");
  });

  it("listToArray converts Prolog list", function() {
    var r = e.queryFirst(compound("heating_schedule", [variable("S")]));
    var arr = listToArray(r.args[0]);
    assert.equal(arr.length, 2);
    assert.equal(arr[0].name, "kitchen");
  });
});

// ── Step 5: Dynamic state ───────────────────────────────────

describe("05 — Dynamic state", function() {
  it("retract + assert updates facts", function() {
    var e = new PrologEngine();
    e.addClause(compound("temperature", [atom("bedroom"), num(68)]));
    e.addClause(compound("cold", [variable("R")]), [
      compound("temperature", [variable("R"), variable("T")]),
      compound("<", [variable("T"), num(65)])
    ]);

    assert.equal(e.query(compound("cold", [variable("R")])).length, 0);

    e.retractFirst(compound("temperature", [atom("bedroom"), variable("_")]));
    e.addClause(compound("temperature", [atom("bedroom"), num(58)]));

    assert.equal(e.query(compound("cold", [variable("R")])).length, 1);
  });

  it("retractall removes all matching clauses", function() {
    var e = new PrologEngine();
    e.addClause(compound("temperature", [atom("kitchen"), num(72)]));
    e.addClause(compound("temperature", [atom("kitchen"), num(70)]));

    // do_update(Room, Val) :- retractall(temperature(Room, _)), assert(temperature(Room, Val)).
    e.addClause(compound("do_update", [variable("R"), variable("V")]), [
      compound("retractall", [compound("temperature", [variable("R"), variable("_")])]),
      compound("assert", [compound("temperature", [variable("R"), variable("V")])])
    ]);

    e.queryFirst(compound("do_update", [atom("kitchen"), num(60)]));
    var results = e.query(compound("temperature", [atom("kitchen"), variable("T")]));
    assert.equal(results.length, 1);
    assert.equal(results[0].args[1].value, 60);
  });
});

// ── Step 6: Negation and findall ────────────────────────────

describe("06 — Negation and findall", function() {
  var e = new PrologEngine();
  e.addClause(compound("room", [atom("kitchen")]));
  e.addClause(compound("room", [atom("bedroom")]));
  e.addClause(compound("room", [atom("garage")]));
  e.addClause(compound("temperature", [atom("kitchen"), num(72)]));
  e.addClause(compound("temperature", [atom("bedroom"), num(58)]));
  e.addClause(compound("temperature", [atom("garage"), num(55)]));

  e.addClause(compound("cold", [variable("R")]), [
    compound("temperature", [variable("R"), variable("T")]),
    compound("<", [variable("T"), num(65)])
  ]);

  // all_cold(Rooms) :- findall(R, cold(R), Rooms).
  e.addClause(compound("all_cold", [variable("Rooms")]), [
    compound("findall", [variable("R"), compound("cold", [variable("R")]), variable("Rooms")])
  ]);

  it("findall collects all solutions", function() {
    var r = e.queryFirst(compound("all_cold", [variable("L")]));
    assert.ok(r);
    var rooms = listToArray(r.args[0]);
    assert.equal(rooms.length, 2);
  });

  it("not/1 succeeds when goal fails", function() {
    var r = e.queryFirst(compound("not", [compound("cold", [atom("kitchen")])]));
    assert.ok(r);
  });

  it("not/1 fails when goal succeeds", function() {
    var r = e.queryFirst(compound("not", [compound("cold", [atom("bedroom")])]));
    assert.equal(r, null);
  });
});

// ── Step 7: Text parser ─────────────────────────────────────

describe("07 — Text parser (loadString)", function() {
  var e = new PrologEngine();
  loadString(e, [
    "room(kitchen). room(bedroom). room(garage).",
    "temperature(kitchen, 72).",
    "temperature(bedroom, 58).",
    "temperature(garage, 55).",
    "target_temp(kitchen, 70). target_temp(bedroom, 72). target_temp(garage, 50).",
    "cold(Room) :- temperature(Room, T), T < 65.",
    "comfortable(Room) :- temperature(Room, T), target_temp(Room, Target), T >= Target.",
    "needs_heating(Room) :- temperature(Room, T), target_temp(Room, Target), T < Target.",
    "all_cold(Rooms) :- findall(R, cold(R), Rooms).",
    "do_update(Room, Val) :- retractall(temperature(Room, _)), assert(temperature(Room, Val))."
  ].join("\n"));

  it("loadString loads facts and rules", function() {
    var rooms = e.query(compound("room", [variable("R")]));
    assert.equal(rooms.length, 3);
  });

  it("rules from text work the same as programmatic", function() {
    var cold = e.query(compound("cold", [variable("R")]));
    assert.equal(cold.length, 2);
  });

  it("findall works from parsed rules", function() {
    var r = e.queryFirst(compound("all_cold", [variable("L")]));
    var rooms = listToArray(r.args[0]);
    assert.equal(rooms.length, 2);
  });

  it("dynamic updates from parsed rules", function() {
    e.queryFirst(compound("do_update", [atom("bedroom"), num(75)]));
    var cold = e.query(compound("cold", [variable("R")]));
    assert.equal(cold.length, 1);
    assert.equal(cold[0].args[0].name, "garage");
  });
});

// ── Step 8: Reactive queries ────────────────────────────────

describe("08 — Reactive queries", function() {
  it("createQuery recomputes on bump", function() {
    var e = new PrologEngine();
    loadString(e, [
      "temperature(kitchen, 72).",
      "temperature(bedroom, 68).",
      "cold(Room) :- temperature(Room, T), T < 65."
    ].join("\n"));

    var rp = createReactiveEngine(e);
    var coldRooms = rp.createQuery(function() {
      return compound("cold", [variable("R")]);
    });

    assert.equal(coldRooms().length, 0);

    e.retractFirst(compound("temperature", [atom("bedroom"), variable("_")]));
    e.addClause(compound("temperature", [atom("bedroom"), num(55)]));
    rp.bump();

    assert.equal(coldRooms().length, 1);
  });

  it("createQueryFirst tracks single result", function() {
    var e = new PrologEngine();
    loadString(e, [
      "status(normal) :- not(alert(_)).",
      "status(alert) :- alert(_)."
    ].join("\n"));

    var rp = createReactiveEngine(e);
    var status = rp.createQueryFirst(function() {
      return compound("status", [variable("S")]);
    });

    assert.equal(status().args[0].name, "normal");

    e.addClause(compound("alert", [atom("high_temp")]));
    rp.bump();

    assert.equal(status().args[0].name, "alert");
  });

  it("onUpdate fires on change", function() {
    var e = new PrologEngine();
    e.addClause(compound("temperature", [atom("kitchen"), num(72)]));

    var rp = createReactiveEngine(e);
    var log = [];
    rp.onUpdate(function() {
      var r = e.queryFirst(compound("temperature", [atom("kitchen"), variable("T")]));
      log.push(r ? r.args[1].value : null);
    });

    assert.equal(log.length, 1);
    assert.equal(log[0], 72);

    e.retractFirst(compound("temperature", [atom("kitchen"), variable("_")]));
    e.addClause(compound("temperature", [atom("kitchen"), num(60)]));
    rp.bump();

    assert.equal(log.length, 2);
    assert.equal(log[1], 60);
  });
});

// ── Step 9: Ephemeral/react signals ─────────────────────────

describe("09 — Ephemeral/react signals", function() {
  function makeEngine() {
    var e = new PrologEngine();
    var rp = createReactiveEngine(e);
    loadString(e, [
      "trusted_sensor(sensor_1).",
      "trusted_sensor(sensor_2).",
      "handle_signal(From, Fact) :- ephemeral(signal(From, Fact)), react.",
      "react :- signal(From, temperature(From, Room, Val)),",
      "         trusted_sensor(From),",
      "         retractall(temperature(Room, _)),",
      "         assert(temperature(Room, Val)),",
      "         send(dashboard, temperature(Room, Val))."
    ].join("\n"));
    return e;
  }

  it("accepts signals from trusted sensors", function() {
    var e = makeEngine();
    var r = e.queryFirst(compound("handle_signal", [
      atom("sensor_1"),
      compound("temperature", [atom("sensor_1"), atom("kitchen"), num(72)])
    ]));
    assert.ok(r);
    var temp = e.queryFirst(compound("temperature", [atom("kitchen"), variable("T")]));
    assert.ok(temp);
    assert.equal(temp.args[1].value, 72);
  });

  it("drops signals from untrusted sensors", function() {
    var e = makeEngine();
    var r = e.queryFirst(compound("handle_signal", [
      atom("rogue"),
      compound("temperature", [atom("rogue"), atom("kitchen"), num(999)])
    ]));
    assert.equal(r, null);
    var temp = e.queryFirst(compound("temperature", [atom("kitchen"), variable("T")]));
    assert.equal(temp, null);
  });

  it("drops spoofed signals (From mismatch)", function() {
    var e = makeEngine();
    var r = e.queryFirst(compound("handle_signal", [
      atom("sensor_1"),
      compound("temperature", [atom("sensor_2"), atom("kitchen"), num(999)])
    ]));
    assert.equal(r, null);
  });

  it("ephemeral auto-retracts signal after query", function() {
    var e = makeEngine();
    e.queryFirst(compound("handle_signal", [
      atom("sensor_1"),
      compound("temperature", [atom("sensor_1"), atom("kitchen"), num(72)])
    ]));
    var stale = e.queryFirst(compound("signal", [variable("_"), variable("_")]));
    assert.equal(stale, null);
  });

  it("upserts replace old values", function() {
    var e = makeEngine();
    e.queryFirst(compound("handle_signal", [
      atom("sensor_1"),
      compound("temperature", [atom("sensor_1"), atom("kitchen"), num(72)])
    ]));
    e.queryFirst(compound("handle_signal", [
      atom("sensor_1"),
      compound("temperature", [atom("sensor_1"), atom("kitchen"), num(65)])
    ]));
    var results = e.query(compound("temperature", [atom("kitchen"), variable("T")]));
    assert.equal(results.length, 1);
    assert.equal(results[0].args[1].value, 65);
  });

  it("send/2 captures outgoing messages", function() {
    var e = makeEngine();
    var result = e.queryWithSends(compound("handle_signal", [
      atom("sensor_1"),
      compound("temperature", [atom("sensor_1"), atom("kitchen"), num(72)])
    ]));
    assert.ok(result.result);
    assert.equal(result.sends.length, 1);
    assert.equal(result.sends[0].target.name, "dashboard");
    assert.equal(result.sends[0].fact.functor, "temperature");
    assert.equal(result.sends[0].fact.args[0].name, "kitchen");
    assert.equal(result.sends[0].fact.args[1].value, 72);
  });

  it("send/2 produces no sends when signal is dropped", function() {
    var e = makeEngine();
    var result = e.queryWithSends(compound("handle_signal", [
      atom("rogue"),
      compound("temperature", [atom("rogue"), atom("kitchen"), num(999)])
    ]));
    assert.equal(result.result, null);
    assert.equal(result.sends.length, 0);
  });

  it("queryWithSends clears sends between calls", function() {
    var e = makeEngine();
    var r1 = e.queryWithSends(compound("handle_signal", [
      atom("sensor_1"),
      compound("temperature", [atom("sensor_1"), atom("kitchen"), num(72)])
    ]));
    assert.equal(r1.sends.length, 1);
    var r2 = e.queryWithSends(compound("handle_signal", [
      atom("sensor_1"),
      compound("temperature", [atom("sensor_1"), atom("bedroom"), num(68)])
    ]));
    assert.equal(r2.sends.length, 1);
    assert.equal(r2.sends[0].fact.args[0].name, "bedroom");
  });
});

// ── Run ─────────────────────────────────────────────────────
runTests();
