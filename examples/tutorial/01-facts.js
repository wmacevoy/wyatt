// ============================================================
// 01-facts.js — Facts and queries
//
// A smart thermostat knows about rooms and their temperatures.
// We add facts and ask questions.
//
// Run:  node examples/tutorial/01-facts.js
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";

var atom     = PrologEngine.atom;
var compound = PrologEngine.compound;
var num      = PrologEngine.num;
var variable = PrologEngine.variable;

var e = new PrologEngine();

// ── Facts ───────────────────────────────────────────────────
// room(Name).
e.addClause(compound("room", [atom("kitchen")]));
e.addClause(compound("room", [atom("bedroom")]));
e.addClause(compound("room", [atom("garage")]));

// temperature(Room, DegF).
e.addClause(compound("temperature", [atom("kitchen"), num(72)]));
e.addClause(compound("temperature", [atom("bedroom"), num(68)]));
e.addClause(compound("temperature", [atom("garage"), num(55)]));

// ── Queries ─────────────────────────────────────────────────

// What rooms exist?
var rooms = e.query(compound("room", [variable("R")]));
// rooms is an array of matching terms:
//   [ {type:"compound", functor:"room", args:[{type:"atom", name:"kitchen"}]},
//     {type:"compound", functor:"room", args:[{type:"atom", name:"bedroom"}]},
//     {type:"compound", functor:"room", args:[{type:"atom", name:"garage"}]} ]

// What is the kitchen temperature?
var kitchenTemp = e.queryFirst(
  compound("temperature", [atom("kitchen"), variable("T")])
);
// kitchenTemp.args[1].value === 72

// What rooms have a temperature below 60?
var coldRooms = e.query(
  compound("temperature", [variable("R"), variable("T")])
);
// Returns all temperature facts — we'll filter with rules in step 02.

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Rooms: " + rooms.length);
_print("Kitchen temp: " + kitchenTemp.args[1].value);
_print("All temps: " + coldRooms.length);
