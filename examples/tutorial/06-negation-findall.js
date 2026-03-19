// ============================================================
// 06-negation-findall.js — Negation and findall
//
// not/1 (or \+) succeeds when its argument fails.
// findall/3 collects all solutions into a list.
//
// Run:  node examples/tutorial/06-negation-findall.js
//       qjs --module examples/tutorial/06-negation-findall.js
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
  temperature(kitchen, 72).
  temperature(bedroom, 58).
  temperature(garage, 55).
  target_temp(kitchen, 70).
  target_temp(bedroom, 72).
  target_temp(garage, 50).
`);

// ── Rules ───────────────────────────────────────────────────

loadString(e, `
  comfortable(Room) :-
    temperature(Room, T),
    target_temp(Room, Target),
    T >= Target.
`);

// Dynamic (faster — skips parse, use for hot paths):
//
// var compound = PrologEngine.compound, variable = PrologEngine.variable;
// e.addClause(
//   compound("comfortable", [variable("Room")]),
//   [compound("temperature", [variable("Room"), variable("T")]),
//    compound("target_temp", [variable("Room"), variable("Target")]),
//    compound(">=", [variable("T"), variable("Target")])]
// );

// ── Negation ────────────────────────────────────────────────

// uncomfortable(Room) :- room(Room), not(comfortable(Room)).
loadString(e, `
  uncomfortable(Room) :- room(Room), not(comfortable(Room)).
`);

var uncomfortable = e.query(parseTerm("uncomfortable(R)"));
// bedroom (58 < 72)

// ── Findall ─────────────────────────────────────────────────

// all_uncomfortable(Rooms) :- findall(R, uncomfortable(R), Rooms).
loadString(e, `
  all_uncomfortable(Rooms) :- findall(R, uncomfortable(R), Rooms).
`);

var result = e.queryFirst(parseTerm("all_uncomfortable(L)"));
var roomList = listToArray(result.args[0]);

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Uncomfortable rooms: " + uncomfortable.length);
_print("Findall collected: " + roomList.length);
for (var i = 0; i < roomList.length; i++) {
  _print("  " + roomList[i].name);
}
