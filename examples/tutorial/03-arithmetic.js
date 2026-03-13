// ============================================================
// 03-arithmetic.js — Arithmetic and comparison
//
// Prolog evaluates arithmetic with `is/2` and compares with
// >, <, >=, =<.  The `is` builtin evaluates expressions like
// X is Y + Z.
//
// Run:  node examples/tutorial/03-arithmetic.js
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";

var atom     = PrologEngine.atom;
var compound = PrologEngine.compound;
var num      = PrologEngine.num;
var variable = PrologEngine.variable;

var e = new PrologEngine();

// Facts
e.addClause(compound("temperature", [atom("kitchen"), num(72)]));
e.addClause(compound("temperature", [atom("bedroom"), num(68)]));
e.addClause(compound("temperature", [atom("garage"), num(55)]));
e.addClause(compound("target_temp", [atom("kitchen"), num(70)]));
e.addClause(compound("target_temp", [atom("bedroom"), num(72)]));
e.addClause(compound("target_temp", [atom("garage"), num(50)]));

// ── Rules with arithmetic ───────────────────────────────────

// temp_diff(Room, Diff) :- temperature(Room, T), target_temp(Room, Target),
//                          Diff is Target - T.
e.addClause(
  compound("temp_diff", [variable("Room"), variable("Diff")]),
  [
    compound("temperature", [variable("Room"), variable("T")]),
    compound("target_temp", [variable("Room"), variable("Target")]),
    compound("is", [variable("Diff"), compound("-", [variable("Target"), variable("T")])])
  ]
);

// comfortable(Room) :- temperature(Room, T), target_temp(Room, Target),
//                      T >= Target, T =< Target + 5.
e.addClause(
  compound("comfortable", [variable("Room")]),
  [
    compound("temperature", [variable("Room"), variable("T")]),
    compound("target_temp", [variable("Room"), variable("Target")]),
    compound(">=", [variable("T"), variable("Target")]),
    compound("=<", [variable("T"), compound("+", [variable("Target"), num(5)])])
  ]
);

// ── Queries ─────────────────────────────────────────────────

var diffs = e.query(compound("temp_diff", [variable("R"), variable("D")]));
// kitchen: 70-72 = -2, bedroom: 72-68 = 4, garage: 50-55 = -5

var comfy = e.query(compound("comfortable", [variable("R")]));
// kitchen: 72 >= 70 and 72 =< 75 → yes

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Temperature differences:");
for (var i = 0; i < diffs.length; i++) {
  _print("  " + diffs[i].args[0].name + ": " + diffs[i].args[1].value);
}
_print("Comfortable rooms: " + comfy.length);
