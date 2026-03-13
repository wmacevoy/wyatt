// ============================================================
// 06-negation-findall.js — Negation and findall
//
// not/1 (or \+) succeeds when its argument fails.
// findall/3 collects all solutions into a list.
//
// Run:  node examples/tutorial/06-negation-findall.js
// ============================================================

import { PrologEngine, listToArray } from "../../src/prolog-engine.js";

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
e.addClause(compound("temperature", [atom("bedroom"), num(58)]));
e.addClause(compound("temperature", [atom("garage"), num(55)]));
e.addClause(compound("target_temp", [atom("kitchen"), num(70)]));
e.addClause(compound("target_temp", [atom("bedroom"), num(72)]));
e.addClause(compound("target_temp", [atom("garage"), num(50)]));

// comfortable(Room) :- temperature(Room, T), target_temp(Room, Target),
//                      T >= Target.
e.addClause(
  compound("comfortable", [variable("Room")]),
  [
    compound("temperature", [variable("Room"), variable("T")]),
    compound("target_temp", [variable("Room"), variable("Target")]),
    compound(">=", [variable("T"), variable("Target")])
  ]
);

// ── Negation ────────────────────────────────────────────────

// uncomfortable(Room) :- room(Room), not(comfortable(Room)).
e.addClause(
  compound("uncomfortable", [variable("Room")]),
  [
    compound("room", [variable("Room")]),
    compound("not", [compound("comfortable", [variable("Room")])])
  ]
);

var uncomfortable = e.query(compound("uncomfortable", [variable("R")]));
// bedroom (58 < 72)

// ── Findall ─────────────────────────────────────────────────

// all_uncomfortable(Rooms) :- findall(R, uncomfortable(R), Rooms).
e.addClause(
  compound("all_uncomfortable", [variable("Rooms")]),
  [
    compound("findall", [
      variable("R"),
      compound("uncomfortable", [variable("R")]),
      variable("Rooms")
    ])
  ]
);

var result = e.queryFirst(compound("all_uncomfortable", [variable("L")]));
var roomList = listToArray(result.args[0]);

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Uncomfortable rooms: " + uncomfortable.length);
_print("Findall collected: " + roomList.length);
for (var i = 0; i < roomList.length; i++) {
  _print("  " + roomList[i].name);
}
