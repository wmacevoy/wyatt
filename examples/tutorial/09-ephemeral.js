// ============================================================
// 09-ephemeral.js — Ephemeral/react signal handling + send/2
//
// Three primitives:
//   ephemeral(Event) — transient event, triggers react(Event)
//   react(Pattern)   — fires on events and mutations
//   native(Call, R)  — call host-registered function
//
// ephemeral never touches the clause database.  It fires
// react rules, which can assert/retract (triggering further
// reactions) and send outgoing messages.
//
// Run:  node examples/tutorial/09-ephemeral.js
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { parseTerm } from "../../src/parser.js";

var compound = PrologEngine.compound;
var variable = PrologEngine.variable;
var atom     = PrologEngine.atom;
var num      = PrologEngine.num;

var e = new PrologEngine();

loadString(e, [
  // Trusted sensors
  "trusted_sensor(sensor_1).",
  "trusted_sensor(sensor_2).",
  "",
  // React to signal events (QJSON objects as terms)
  // From must match for spoofing protection
  "react({type: signal, from: From, reading: temperature(From, Room, Val)}) :-",
  "    trusted_sensor(From),",
  "    retractall(temperature(Room, _OldV)),",
  "    assert(temperature(Room, Val)),",
  "    send(dashboard, temperature(Room, Val)).",
  "",
  "react({type: signal, from: From, reading: humidity(From, Room, Val)}) :-",
  "    trusted_sensor(From),",
  "    retractall(humidity(Room, _OldV)),",
  "    assert(humidity(Room, Val)),",
  "    send(dashboard, humidity(Room, Val)).",
  "",
  // Derived rules
  "cold(Room) :- temperature(Room, T), T < 65.",
  "status(alert) :- cold(_Room).",
  "status(normal) :- not(cold(_Room))."
].join("\n"));

// ── Process signals via ephemeral ─────────────────────────────

// Trusted sensor sends a temperature reading
e._sends = [];
e.queryFirst(compound("ephemeral", [
  parseTerm("{type: signal, from: sensor_1, reading: temperature(sensor_1, kitchen, 72)}")
]));
var sends1 = e._sends.slice();
// sends1 has one entry: send(dashboard, temperature(kitchen, 72))

// Untrusted sensor — no react rule matches, signal dropped
e._sends = [];
e.queryFirst(compound("ephemeral", [
  parseTerm("{type: signal, from: rogue, reading: temperature(rogue, kitchen, 999)}")
]));
var sends2 = e._sends.slice();
// sends2 is empty — no trusted_sensor(rogue)

// Spoofed: transport says sensor_1, reading claims sensor_2
e._sends = [];
e.queryFirst(compound("ephemeral", [
  parseTerm("{type: signal, from: sensor_1, reading: temperature(sensor_2, kitchen, 999)}")
]));
var sends3 = e._sends.slice();
// sends3 is empty — From mismatch (sensor_1 ≠ sensor_2)

// Ephemeral never touched the DB — no stale signal facts
var staleSignal = e.queryFirst(compound("signal", [variable("_A"), variable("_B")]));
// null — ephemeral doesn't assert

// But the permanent fact WAS asserted by the react rule
var kitchenTemp = e.queryFirst(compound("temperature", [atom("kitchen"), variable("T")]));

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Signal from sensor_1: " + (sends1.length > 0 ? "accepted" : "dropped"));
_print("  sends: " + sends1.length + " (target=" + (sends1.length > 0 ? sends1[0].target.name : "none") + ")");
_print("Signal from rogue: " + (sends2.length > 0 ? "accepted" : "dropped"));
_print("Spoofed signal: " + (sends3.length > 0 ? "accepted" : "dropped"));
_print("Stale signal in DB: " + (staleSignal !== null));
_print("Kitchen temp: " + kitchenTemp.args[1].value);
