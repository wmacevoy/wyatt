// ============================================================
// 05-dynamic.js — Dynamic state with assert/retract
//
// Prolog facts can be added and removed at runtime.
// assert/1 adds a fact; retract/1 removes the first match;
// retractall/1 removes all matches.
//
// Run:  node examples/tutorial/05-dynamic.js
//       qjs --module examples/tutorial/05-dynamic.js
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { parseTerm } from "../../src/parser.js";

var e = new PrologEngine();

// ── Initial facts and rules ─────────────────────────────────

loadString(e, `
  temperature(kitchen, 72).
  temperature(bedroom, 68).

  cold(Room) :- temperature(Room, T), T < 65.
`);

// ── Dynamic updates ────────────────────────────────────────

// Simulate a sensor update: bedroom drops to 58
// First retract the old reading, then assert the new one.
e.queryFirst(parseTerm("retract(temperature(bedroom, _Old))"));
e.queryFirst(parseTerm("assert(temperature(bedroom, 58))"));

var coldNow = e.query(parseTerm("cold(R)"));
// bedroom is now cold (58 < 65)

// Dynamic (faster — skips parse, use for hot paths):
//
// var compound = PrologEngine.compound, atom = PrologEngine.atom;
// var num = PrologEngine.num, variable = PrologEngine.variable;
// e.retractFirst(compound("temperature", [atom("bedroom"), variable("_")]));
// e.addClause(compound("temperature", [atom("bedroom"), num(58)]));

// ── Using retractall from Prolog ────────────────────────────

// A rule that replaces a temperature reading in one step
loadString(e, `
  do_update(Room, NewTemp) :-
    retractall(temperature(Room, _OldVal)),
    assert(temperature(Room, NewTemp)).
`);

// Update kitchen to 60 via the Prolog rule
e.queryFirst(parseTerm("do_update(kitchen, 60)"));

var coldAfter = e.query(parseTerm("cold(R)"));
// Both bedroom (58) and kitchen (60) are cold now

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Cold after first update: " + coldNow.length);
for (var i = 0; i < coldNow.length; i++) {
  _print("  " + coldNow[i].args[0].name);
}
_print("Cold after second update: " + coldAfter.length);
for (var i = 0; i < coldAfter.length; i++) {
  _print("  " + coldAfter[i].args[0].name);
}
