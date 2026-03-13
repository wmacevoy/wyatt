// ============================================================
// 05-dynamic.js — Dynamic state with assert/retract
//
// Prolog facts can be added and removed at runtime.
// assert/1 adds a fact; retract/1 removes the first match;
// retractall/1 removes all matches.
//
// Run:  node examples/tutorial/05-dynamic.js
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";

var atom     = PrologEngine.atom;
var compound = PrologEngine.compound;
var num      = PrologEngine.num;
var variable = PrologEngine.variable;

var e = new PrologEngine();

// Initial temperatures
e.addClause(compound("temperature", [atom("kitchen"), num(72)]));
e.addClause(compound("temperature", [atom("bedroom"), num(68)]));

// cold(Room) :- temperature(Room, T), T < 65.
e.addClause(
  compound("cold", [variable("Room")]),
  [
    compound("temperature", [variable("Room"), variable("T")]),
    compound("<", [variable("T"), num(65)])
  ]
);

// ── Dynamic updates ────────────────────────────────────────

// Simulate a sensor update: bedroom drops to 58
// First retract the old reading, then assert the new one.
e.retractFirst(compound("temperature", [atom("bedroom"), variable("_")]));
e.addClause(compound("temperature", [atom("bedroom"), num(58)]));

var coldNow = e.query(compound("cold", [variable("R")]));
// bedroom is now cold (58 < 65)

// ── Using retractall from Prolog ────────────────────────────

// do_update(Room, NewTemp) :-
//   retractall(temperature(Room, _)),
//   assert(temperature(Room, NewTemp)).
e.addClause(
  compound("do_update", [variable("Room"), variable("NewTemp")]),
  [
    compound("retractall", [compound("temperature", [variable("Room"), variable("_")])]),
    compound("assert", [compound("temperature", [variable("Room"), variable("NewTemp")])])
  ]
);

// Update kitchen to 60 via the Prolog rule
e.queryFirst(compound("do_update", [atom("kitchen"), num(60)]));

var coldAfter = e.query(compound("cold", [variable("R")]));
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
