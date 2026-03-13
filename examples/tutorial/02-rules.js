// ============================================================
// 02-rules.js — Rules with body goals
//
// Rules derive new knowledge from existing facts.
// A rule has a head (the conclusion) and a body (the conditions).
//
// Run:  node examples/tutorial/02-rules.js
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";

var atom     = PrologEngine.atom;
var compound = PrologEngine.compound;
var num      = PrologEngine.num;
var variable = PrologEngine.variable;

var e = new PrologEngine();

// Facts
e.addClause(compound("room", [atom("kitchen")]));
e.addClause(compound("room", [atom("bedroom")]));
e.addClause(compound("room", [atom("garage")]));
e.addClause(compound("temperature", [atom("kitchen"), num(72)]));
e.addClause(compound("temperature", [atom("bedroom"), num(68)]));
e.addClause(compound("temperature", [atom("garage"), num(55)]));

// Target temperatures
e.addClause(compound("target_temp", [atom("kitchen"), num(70)]));
e.addClause(compound("target_temp", [atom("bedroom"), num(72)]));
e.addClause(compound("target_temp", [atom("garage"), num(50)]));

// ── Rules ───────────────────────────────────────────────────
// addClause(head, body) — body is an array of goals.

// cold(Room) :- temperature(Room, T), T < 65.
e.addClause(
  compound("cold", [variable("Room")]),
  [
    compound("temperature", [variable("Room"), variable("T")]),
    compound("<", [variable("T"), num(65)])
  ]
);

// needs_heating(Room) :- temperature(Room, T), target_temp(Room, Target), T < Target.
e.addClause(
  compound("needs_heating", [variable("Room")]),
  [
    compound("temperature", [variable("Room"), variable("T")]),
    compound("target_temp", [variable("Room"), variable("Target")]),
    compound("<", [variable("T"), variable("Target")])
  ]
);

// ── Queries ─────────────────────────────────────────────────

var coldRooms = e.query(compound("cold", [variable("R")]));
// Only garage (55 < 65)

var heatingNeeded = e.query(compound("needs_heating", [variable("R")]));
// bedroom (68 < 72) — kitchen is fine (72 >= 70), garage is fine (55 >= 50)

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Cold rooms: " + coldRooms.length);
_print("Needs heating: " + heatingNeeded.length);
for (var i = 0; i < heatingNeeded.length; i++) {
  _print("  " + heatingNeeded[i].args[0].name);
}
