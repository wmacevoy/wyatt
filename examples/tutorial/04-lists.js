// ============================================================
// 04-lists.js — Lists and member
//
// Prolog lists are written as [a, b, c].
// The member/2 builtin checks if an element is in a list.
//
// Run:  node examples/tutorial/04-lists.js
//       qjs --module examples/tutorial/04-lists.js
// ============================================================

import { PrologEngine, listToArray } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { parseTerm } from "../../src/parser.js";

var e = new PrologEngine();

// ── Facts ───────────────────────────────────────────────────

loadString(e, `
  room(kitchen).
  room(bedroom).
  room(garage).
  room(bathroom).

  heating_schedule([kitchen, bedroom, bathroom]).
`);

// ── Rules with member ───────────────────────────────────────

loadString(e, `
  scheduled(Room) :- heating_schedule(Rooms), member(Room, Rooms).
  unscheduled(Room) :- room(Room), not(scheduled(Room)).
`);

// Dynamic (faster — skips parse, use for hot paths):
//
// var compound = PrologEngine.compound, variable = PrologEngine.variable;
// var atom = PrologEngine.atom, list = PrologEngine.list;
// e.addClause(compound("heating_schedule", [
//   list([atom("kitchen"), atom("bedroom"), atom("bathroom")])
// ]));
// e.addClause(
//   compound("scheduled", [variable("Room")]),
//   [compound("heating_schedule", [variable("Rooms")]),
//    compound("member", [variable("Room"), variable("Rooms")])]
// );

// ── Queries ─────────────────────────────────────────────────

var scheduled = e.query(parseTerm("scheduled(R)"));
// kitchen, bedroom, bathroom

var unscheduled = e.query(parseTerm("unscheduled(R)"));
// garage

// Extract the schedule list itself
var sched = e.queryFirst(parseTerm("heating_schedule(S)"));
var schedArray = listToArray(sched.args[0]);

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Scheduled: " + scheduled.length);
for (var i = 0; i < scheduled.length; i++) {
  _print("  " + scheduled[i].args[0].name);
}
_print("Unscheduled: " + unscheduled.length);
_print("Schedule list has " + schedArray.length + " items");
