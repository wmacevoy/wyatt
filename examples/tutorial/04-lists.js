// ============================================================
// 04-lists.js — Lists and member
//
// Prolog lists are built with PrologEngine.list().
// The member/2 builtin checks if an element is in a list.
//
// Run:  node examples/tutorial/04-lists.js
// ============================================================

import { PrologEngine, listToArray } from "../../src/prolog-engine.js";

var atom     = PrologEngine.atom;
var compound = PrologEngine.compound;
var num      = PrologEngine.num;
var variable = PrologEngine.variable;
var list     = PrologEngine.list;

var e = new PrologEngine();

// Facts
e.addClause(compound("room", [atom("kitchen")]));
e.addClause(compound("room", [atom("bedroom")]));
e.addClause(compound("room", [atom("garage")]));
e.addClause(compound("room", [atom("bathroom")]));

// A heating schedule: which rooms should be heated
e.addClause(compound("heating_schedule", [
  list([atom("kitchen"), atom("bedroom"), atom("bathroom")])
]));

// ── Rules with member ───────────────────────────────────────

// scheduled(Room) :- heating_schedule(Rooms), member(Room, Rooms).
e.addClause(
  compound("scheduled", [variable("Room")]),
  [
    compound("heating_schedule", [variable("Rooms")]),
    compound("member", [variable("Room"), variable("Rooms")])
  ]
);

// unscheduled(Room) :- room(Room), \+ scheduled(Room).
e.addClause(
  compound("unscheduled", [variable("Room")]),
  [
    compound("room", [variable("Room")]),
    compound("not", [compound("scheduled", [variable("Room")])])
  ]
);

// ── Queries ─────────────────────────────────────────────────

var scheduled = e.query(compound("scheduled", [variable("R")]));
// kitchen, bedroom, bathroom

var unscheduled = e.query(compound("unscheduled", [variable("R")]));
// garage

// Extract the schedule list itself
var sched = e.queryFirst(compound("heating_schedule", [variable("S")]));
var schedArray = listToArray(sched.args[0]);

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Scheduled: " + scheduled.length);
for (var i = 0; i < scheduled.length; i++) {
  _print("  " + scheduled[i].args[0].name);
}
_print("Unscheduled: " + unscheduled.length);
_print("Schedule list has " + schedArray.length + " items");
