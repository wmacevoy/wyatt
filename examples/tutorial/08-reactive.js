// ============================================================
// 08-reactive.js — Reactive queries
//
// Wrap the engine with createReactiveEngine to get live queries
// that automatically recompute when facts change.
//
// Run:  node examples/tutorial/08-reactive.js
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";

var compound = PrologEngine.compound;
var variable = PrologEngine.variable;
var atom     = PrologEngine.atom;
var num      = PrologEngine.num;

var e = new PrologEngine();
loadString(e, [
  "temperature(kitchen, 72).",
  "temperature(bedroom, 68).",
  "cold(Room) :- temperature(Room, T), T < 65.",
  "status(normal) :- not(cold(_)).",
  "status(alert)  :- cold(_)."
].join("\n"));

// ── Reactive layer ──────────────────────────────────────────

var rp = createReactiveEngine(e);

// createQuery returns a memo'd function — it recomputes only
// when rp.bump() is called (after facts change).
var coldRooms = rp.createQuery(function() {
  return compound("cold", [variable("R")]);
});

var status = rp.createQueryFirst(function() {
  return compound("status", [variable("S")]);
});

// onUpdate runs its callback whenever the engine generation changes.
var log = [];
rp.onUpdate(function() {
  var s = e.queryFirst(compound("status", [variable("S")]));
  var label = s ? s.args[0].name : "unknown";
  log.push(label);
});

// Initially: no cold rooms, status is normal
var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Cold rooms: " + coldRooms().length);           // 0
_print("Status: " + status().args[0].name);             // normal

// ── Simulate sensor update ──────────────────────────────────

e.retractFirst(compound("temperature", [atom("bedroom"), variable("_")]));
e.addClause(compound("temperature", [atom("bedroom"), num(55)]));
rp.bump();  // triggers recomputation

_print("Cold rooms after update: " + coldRooms().length);  // 1
_print("Status after update: " + status().args[0].name);   // alert
_print("onUpdate ran " + log.length + " times");            // 2 (initial + update)
