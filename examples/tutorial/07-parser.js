// ============================================================
// 07-parser.js — The text parser (loadString)
//
// Instead of building terms programmatically, you can write
// standard Prolog syntax and load it with loadString().
// This rewrites steps 01-06 in clean Prolog text.
//
// Run:  node examples/tutorial/07-parser.js
// ============================================================

import { PrologEngine, listToArray } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";

var variable = PrologEngine.variable;
var compound = PrologEngine.compound;
var atom     = PrologEngine.atom;
var num      = PrologEngine.num;

var e = new PrologEngine();

// ── Load rules as Prolog text ───────────────────────────────

loadString(e, [
  "room(kitchen). room(bedroom). room(garage).",
  "temperature(kitchen, 72).",
  "temperature(bedroom, 58).",
  "temperature(garage, 55).",
  "",
  "target_temp(kitchen, 70).",
  "target_temp(bedroom, 72).",
  "target_temp(garage, 50).",
  "",
  "cold(Room) :- temperature(Room, T), T < 65.",
  "comfortable(Room) :- temperature(Room, T), target_temp(Room, Target), T >= Target.",
  "uncomfortable(Room) :- room(Room), not(comfortable(Room)).",
  "needs_heating(Room) :- temperature(Room, T), target_temp(Room, Target), T < Target.",
  "",
  "temp_diff(Room, Diff) :- temperature(Room, T), target_temp(Room, Target),",
  "                         Diff is Target - T.",
  "",
  "all_cold(Rooms) :- findall(R, cold(R), Rooms).",
  "",
  "do_update(Room, NewTemp) :-",
  "    retractall(temperature(Room, _)),",
  "    assert(temperature(Room, NewTemp))."
].join("\n"));

// ── Same queries as before, much less setup code ────────────

var cold = e.query(compound("cold", [variable("R")]));
var heating = e.query(compound("needs_heating", [variable("R")]));
var uncomf = e.query(compound("uncomfortable", [variable("R")]));

var allCold = e.queryFirst(compound("all_cold", [variable("L")]));
var coldList = listToArray(allCold.args[0]);

// Dynamic update still works
e.queryFirst(compound("do_update", [atom("kitchen"), num(60)]));
var coldAfter = e.query(compound("cold", [variable("R")]));

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Cold: " + cold.length);
_print("Needs heating: " + heating.length);
_print("Uncomfortable: " + uncomf.length);
_print("Findall cold: " + coldList.length);
_print("Cold after update: " + coldAfter.length);
