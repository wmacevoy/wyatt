// ============================================================
// 03-arithmetic.js — Arithmetic and comparison
//
// Prolog evaluates arithmetic with `is/2` and compares with
// >, <, >=, =<.  The `is` builtin evaluates expressions like
// X is Y + Z.
//
// Run:  node examples/tutorial/03-arithmetic.js
//       qjs --module examples/tutorial/03-arithmetic.js
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { parseTerm } from "../../src/parser.js";

var e = new PrologEngine();

// ── Facts ───────────────────────────────────────────────────

loadString(e, `
  temperature(kitchen, 72).
  temperature(bedroom, 68).
  temperature(garage, 55).
  target_temp(kitchen, 70).
  target_temp(bedroom, 72).
  target_temp(garage, 50).
`);

// ── Rules with arithmetic ───────────────────────────────────

loadString(e, `
  temp_diff(Room, Diff) :-
    temperature(Room, T),
    target_temp(Room, Target),
    Diff is Target - T.

  comfortable(Room) :-
    temperature(Room, T),
    target_temp(Room, Target),
    T >= Target,
    T =< Target + 5.
`);

// Dynamic (faster — skips parse, use for hot paths):
//
// var compound = PrologEngine.compound, variable = PrologEngine.variable, num = PrologEngine.num;
// e.addClause(
//   compound("temp_diff", [variable("Room"), variable("Diff")]),
//   [compound("temperature", [variable("Room"), variable("T")]),
//    compound("target_temp", [variable("Room"), variable("Target")]),
//    compound("is", [variable("Diff"), compound("-", [variable("Target"), variable("T")])])]
// );

// ── Queries ─────────────────────────────────────────────────

var diffs = e.query(parseTerm("temp_diff(R, D)"));
// kitchen: 70-72 = -2, bedroom: 72-68 = 4, garage: 50-55 = -5

var comfy = e.query(parseTerm("comfortable(R)"));
// kitchen: 72 >= 70 and 72 =< 75 → yes

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Temperature differences:");
for (var i = 0; i < diffs.length; i++) {
  _print("  " + diffs[i].args[0].name + ": " + diffs[i].args[1].value);
}
_print("Comfortable rooms: " + comfy.length);
